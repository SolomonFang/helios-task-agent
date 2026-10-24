/**
 * AI 审查 / 失败诊断 / 按诊断结论重试的完整作业生命周期（自 handler.ts 抽出）：
 * 卡片按钮回调触发的长耗时作业在消息串行队列外运行——并发上限、去重键表、
 * AbortController 登记（/stop 中断）、结果投递降级与会话注入都收口在这里，
 * handler 只剩按钮分发。
 * 进行中作业按受理/完结落盘（statePath 配置时）：进程重启后作业不可恢复，
 * 启动时读取遗留记录补发中断通知并给重新发起路径（投递失败的记录保留到下次启动补投）。
 */

import fs from 'fs';
import { randomUUID } from 'crypto';
import type { FeishuChannel } from '../channels/feishu';
import type { SessionRouter } from '../agent/session-router';
import { runAiReview, ocrWillDeriveBotLlm } from '../kanban/ai-review';
import {
  runFailureDiagnosis,
  sendDiagnosisFollowUp,
  latestAttemptId,
  buildRetryPrompt,
  DIAGNOSIS_TIMEOUT_MS,
} from '../kanban/failure-diagnosis';
import { buildAiReviewCard, buildDiagnosisCard } from './cards';
import { isAllPass, writeReviewReport } from '../report/review-report';
import type { ReportServer } from '../report/report-server';
import { wrapUntrusted } from '../agent/guard';
import type { AgentConfig } from '../types';
import { errMessage } from '../infra/err';
import { writeFileAtomicPrivateSync } from '../infra/private-file';
import { safeNotify } from './notify';

/** AI 审查全局并发上限：每个审查是最长 15 分钟的子进程，不同 attempt 叠加会拖垮机器。 */
const AI_REVIEW_MAX_CONCURRENT = 2;

/** 失败诊断全局并发上限：单次 LLM 调用（最长 6 分钟），与 AI 审查同量级控制。 */
const DIAGNOSIS_MAX_CONCURRENT = 2;

/** 进程级诊断状态表上限：只增不减会无界累积，超上限整体清空（代价只是同键可再诊断/重试一次）。 */
const DIAGNOSIS_STATE_MAX_ENTRIES = 1000;

/** 有界 Set 写入：超上限整体清空后再写（代价只是老条目重新判定一次），防无界增长。 */
function boundedSetAdd<T>(set: Set<T>, value: T, max: number): void {
  if (set.size >= max) set.clear();
  set.add(value);
}

/** 有界 Map 写入：口径同 boundedSetAdd。 */
function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.size >= max) map.clear();
  map.set(key, value);
}

/**
 * 显式 opt-in 环境变量：未配置独立 OCR key 时，置 1 才允许把机器人主 LLM key 派生给
 * 第三方 ocr 审查子进程（secure-by-default，见 runAiReviewJob 的派生门）。
 */
export const OCR_ALLOW_DERIVED_LLM_KEY_ENV = 'HELIOS_OCR_ALLOW_DERIVED_LLM_KEY';

/** 双向截断：超长文本保留头尾、中间省略（重试回执展示将发送的 follow-up 全文摘要用）。 */
function excerptMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - head - tail} 字）…\n${text.slice(-tail)}`;
}

/** 作业实际用到的 channel 方法子集（fake channel 单测同样满足）。 */
export type ReviewJobsChannel = Pick<FeishuChannel, 'notifyOpenId' | 'notifyCardOpenId' | 'updateCard'>;

export interface ReviewJobsDeps {
  channel: ReviewJobsChannel;
  cfg: AgentConfig;
  router: SessionRouter;
  reportServer: ReportServer | null;
  /** 测试注入用：替换 AI 审查执行器（默认 runAiReview 会拉起 ocr 子进程，单测不可行）。 */
  aiReviewRunner?: typeof runAiReview;
  /** 测试注入用：替换失败诊断执行器（默认 runFailureDiagnosis 调 LLM，单测不可行）。 */
  diagnosisRunner?: typeof runFailureDiagnosis;
  /** 测试注入用：替换重试 follow-up 发送（默认 sendDiagnosisFollowUp 走看板 REST）。 */
  followUpSender?: typeof sendDiagnosisFollowUp;
  /** 测试注入用：替换重试时的 attemptId 补拉（默认 latestAttemptId 走看板 REST）。 */
  attemptIdFetcher?: typeof latestAttemptId;
  /** 进行中作业落盘路径（重启后补发中断通知用）；缺省不持久化（测试场景）。 */
  statePath?: string;
}

/**
 * tryStart* 的受理结果：accepted = 同步落去重键并已启动异步段；
 * 其余为早退分支（作业未开始）——toast 是给卡片回调的如实短文案，详细指引同时经 safeNotify 落消息。
 * 所有早退判定都在首个 await 之前同步完成：调用方（卡片回调）据此决定能否同步换「进行中」卡片，
 * 否则按钮被抹掉而作业其实没跑，卡片文案变死路。
 */
export type TryStartResult<T extends string> = { status: 'accepted' } | { status: T; toast: string };

export interface ReviewJobs {
  /** 「AI 审查」按钮：同步受理判定（去重/并发上限）；accepted 时异步执行 open-code-review 并把结果推回飞书。 */
  tryStartAiReview: (openId: string, attemptId: string, title: string) => TryStartResult<'running' | 'over-limit'>;
  /** 「AI 诊断」按钮：同步受理判定；accepted 时异步采集失败信息 → LLM 中文诊断 → 推结果卡片（带「↻ 重试」按钮）。url 为看板任务链接，随诊断结论留存（重试按钮与「进行中」卡片的「查看任务」入口）。 */
  tryStartDiagnosis: (openId: string, taskId: string, attemptId: string, title: string, url?: string) => TryStartResult<'running' | 'diagnosed' | 'over-limit'>;
  /** 「↻ 按诊断结论重试」按钮与文本「重试这个任务」：按稳定 diagnosisId 读取该用户自己的结论。 */
  tryStartRetry: (openId: string, diagnosisId: string, title: string) => TryStartResult<'launching' | 'launched' | 'no-diagnosis' | 'not-owner'>;
  /** 文本「重试这个任务」确定性分支定位用：该用户最近一次诊断（无记录为 undefined）。 */
  lastDiagnosis: (openId: string) => { diagnosisId: string; taskId: string; title: string } | undefined;
  /** 文本「重新审查这个任务」确定性分支定位用：该用户最近一次发起的 AI 审查（无记录为 undefined）。 */
  lastReview: (openId: string) => { attemptId: string; title: string } | undefined;
  /** /stop：中断该用户进行中的 AI 审查/诊断/重试，返回各自中断数。 */
  abortForUser: (openId: string) => { reviews: number; diagnoses: number; retries: number };
  /** 进程退出：中断全部用户的队列外作业，须在关闭消息通道前调用。 */
  stopAll: () => void;
  /** 启动后补发「机器人重启导致作业中断」通知（无遗留作业时无操作）；通道就绪后调用一次。 */
  notifyInterruptedJobs: () => Promise<void>;
}

export function createReviewJobs(deps: ReviewJobsDeps): ReviewJobs {
  const { channel, cfg, router, reportServer } = deps;
  const runReview = deps.aiReviewRunner ?? runAiReview;
  const runDiagnosis = deps.diagnosisRunner ?? runFailureDiagnosis;
  const sendFollowUp = deps.followUpSender ?? sendDiagnosisFollowUp;
  const fetchAttemptId = deps.attemptIdFetcher ?? latestAttemptId;

  /** 进行中的 AI 审查（按 attempt 去重，防止连点按钮）；携带发起人与 AbortController，/stop 可中断。 */
  const aiReviewRunning = new Map<string, { openId: string; ctl: AbortController }>();
  /** 进行中的失败诊断（按发起人 + task 去重）；不同白名单用户的同任务作业互不误停。 */
  const diagnosisRunning = new Map<string, { openId: string; ctl: AbortController }>();
  /** 已完成诊断的 (openId, task, attempt) 键：同一用户同一 attempt 只诊断一次。 */
  const diagnosedKeys = new Set<string>();
  interface DiagnosisResult {
    diagnosisId: string;
    openId: string;
    taskId: string;
    attemptId?: string;
    text: string;
    cardMessageId?: string;
    url?: string;
  }
  /** 每次诊断按稳定 diagnosisId 独立留存，旧卡片绝不回退读取同任务的最新结果。 */
  const diagnosisResults = new Map<string, DiagnosisResult>();
  const latestDiagnosisByUserTask = new Map<string, string>();
  /** 发起中与已发起的重试均按 diagnosisId 去重；AbortController 同时纳入 /stop 与进程清理。 */
  const retryLaunching = new Set<string>();
  const retryLaunched = new Set<string>();
  const retryRunning = new Map<string, { openId: string; ctl: AbortController }>();
  /** 每用户最近一次诊断（文本重试只定位 diagnosisId，不再按 taskId 猜结果）。 */
  const lastDiagnosisByUser = new Map<string, { diagnosisId: string; taskId: string; title: string }>();
  /** 每用户最近一次发起的 AI 审查（文本「重新审查这个任务」确定性分支用；卡片按钮自带 attemptId 不经过这里）。 */
  const lastReviewByUser = new Map<string, { attemptId: string; title: string }>();
  /** 首次 AI 审查的 LLM 配置告知是否已发送（每进程一次，避免刷屏）。 */
  let aiReviewLlmNoticed = false;

  /**
   * 进行中作业的落盘与重启补通知（statePath 配置时启用）：
   * 受理时落、完结时摘，文件始终反映「当前进行中」；启动时读到的记录 = 上次进程消亡中断的作业，
   * notifyInterruptedJobs 补发中断通知（投递失败的保留到下次启动补投，重复优于丢失）。
   */
  interface RunningJobRecord {
    kind: 'review' | 'diagnosis' | 'retry';
    openId: string;
    /** 作业去重标识（review=attemptId，diagnosis/retry=diagnosisId）。 */
    key: string;
    /** 诊断/重试对应任务；旧格式缺省时以 key 兼容回填。 */
    taskId?: string;
    title: string;
    startedAt: string;
  }
  /** 当前进行中的作业（键 kind:key）：受理时落、完结时摘，随时可整体落盘。 */
  const runningJobs = new Map<string, RunningJobRecord>();
  /** 上次进程遗留的进行中作业：启动时读取，notifyInterruptedJobs 补发通知后清空。 */
  const interruptedJobs: RunningJobRecord[] = [];
  if (deps.statePath) {
    try {
      if (fs.existsSync(deps.statePath)) {
        const raw = JSON.parse(fs.readFileSync(deps.statePath, 'utf8')) as unknown;
        for (const j of Array.isArray(raw) ? raw : []) {
          const rec = j as Partial<RunningJobRecord> | null;
          if (
            rec &&
            (rec.kind === 'review' || rec.kind === 'diagnosis' || rec.kind === 'retry') &&
            typeof rec.openId === 'string' &&
            rec.openId &&
            typeof rec.key === 'string' &&
            rec.key &&
            typeof rec.title === 'string'
          ) {
            interruptedJobs.push({
              kind: rec.kind,
              openId: rec.openId,
              key: rec.key,
              taskId: typeof rec.taskId === 'string' ? rec.taskId : undefined,
              title: rec.title,
              startedAt: typeof rec.startedAt === 'string' ? rec.startedAt : '',
            });
          }
        }
      }
    } catch {
      /* 损坏文件按无遗留处理 */
    }
    // 被中断的作业回填文本定位：诊断结论未持久化，重试会如实要求重新诊断。
    for (const j of interruptedJobs) {
      if (j.kind === 'review') lastReviewByUser.set(j.openId, { attemptId: j.key, title: j.title });
      else if (j.kind === 'diagnosis') {
        lastDiagnosisByUser.set(j.openId, { diagnosisId: j.key, taskId: j.taskId ?? j.key, title: j.title });
      }
    }
  }
  /** 落盘当前进行中作业（extra 合并写入：中断通知未送达的遗留记录随下次启动补投）。 */
  const persistRunningJobs = (extra: RunningJobRecord[] = []): void => {
    if (!deps.statePath) return;
    try {
      writeFileAtomicPrivateSync(deps.statePath, JSON.stringify([...runningJobs.values(), ...extra], null, 2) + '\n');
    } catch {
      /* best-effort：写盘失败只是重启后漏通知，不阻断作业 */
    }
  };
  const trackJob = (rec: RunningJobRecord): void => {
    runningJobs.set(`${rec.kind}:${rec.key}`, rec);
    persistRunningJobs();
  };
  const untrackJob = (kind: RunningJobRecord['kind'], key: string): void => {
    if (runningJobs.delete(`${kind}:${key}`)) persistRunningJobs();
  };
  /** 重启后补发中断通知：遗留作业已随进程消亡，如实告知并按 kind 给文本可达的重新发起路径。 */
  const notifyInterruptedJobs = async (): Promise<void> => {
    const jobs = interruptedJobs.splice(0);
    if (!jobs.length) return;
    // 按用户聚合：一条消息列清所有被中断的作业，避免逐条刷屏
    const byUser = new Map<string, RunningJobRecord[]>();
    for (const j of jobs) {
      const list = byUser.get(j.openId) ?? [];
      list.push(j);
      byUser.set(j.openId, list);
    }
    const kindLabel = { review: 'AI 审查', diagnosis: 'AI 诊断', retry: '按诊断结论重试' } as const;
    // 出路必须文本可达：原卡片上的按钮仍存在于聊天记录，但文本路径不依赖翻卡片
    const kindHint = {
      review: '回复「重新审查这个任务」重新发起',
      diagnosis: '回复「为什么失败」重新诊断',
      retry: '重试可能未发出：回复「为什么失败」重新诊断后，再回复「重试这个任务」',
    } as const;
    const unsent: RunningJobRecord[] = [];
    for (const [openId, userJobs] of byUser) {
      const lines = userJobs.map((j) => `· ${kindLabel[j.kind]}《${j.title}》：${kindHint[j.kind]}`);
      try {
        await channel.notifyOpenId(
          openId,
          `⚠️ 机器人重启，以下进行中的作业已被中断：\n${lines.join('\n')}\n也可重新点击原推送卡片上的按钮重新发起。`,
        );
      } catch (err) {
        console.error(`[review-jobs] 中断通知投递失败(${openId.slice(0, 4)}…): ${errMessage(err)}`);
        unsent.push(...userJobs); // 投递失败保留记录，下次启动补投（重复优于丢失）
      }
    }
    persistRunningJobs(unsent);
  };

  /** AI 审查的异步段（执行/投递/注入会话）；受理判定与去重落键在 tryStartAiReview 同步完成。 */
  const runAiReviewJob = async (openId: string, attemptId: string, title: string, ctl: AbortController): Promise<void> => {
    try {
      // 开始反馈已由卡片回调的 toast + 「进行中」卡片承担，这里不再重复发文本通知（三重同义刷屏）。
      // 主 LLM key 派生门（secure-by-default）：未配置独立 OCR key 时，默认不把机器人主 LLM
      // 配置派生给第三方 ocr 子进程——跳过派生（ocr 缺少模型配置会自行失败），并输出清晰警告
      // 告知开启方式；显式 opt-in（HELIOS_OCR_ALLOW_DERIVED_LLM_KEY=1）保留旧的派生行为，
      // 该路径仍每进程一次补发安全提示。
      const willDerive = ocrWillDeriveBotLlm();
      const deriveAllowed = !willDerive || process.env[OCR_ALLOW_DERIVED_LLM_KEY_ENV] === '1';
      let llmNotice = '';
      if (willDerive && !deriveAllowed) {
        console.warn(
          `[review] 未配置独立 OCR key，已跳过主 LLM key 派生（本次审查可能因审查工具缺少模型配置而失败）。` +
            `开启方式（二选一）：为审查工具配置专用 key（OCR_LLM_URL/OCR_LLM_TOKEN，详见 README）；` +
            `或显式设置 ${OCR_ALLOW_DERIVED_LLM_KEY_ENV}=1 允许派生机器人主 LLM 配置。`,
        );
        if (!aiReviewLlmNoticed) {
          aiReviewLlmNoticed = true;
          llmNotice =
            '\n⚠️ 安全提示：AI 审查由第三方工具执行，未配置独立 key 时默认不会把机器人主模型 key 交给它，本次审查可能因此失败。' +
            `如需使用，请联系部署者为审查工具配置专用 key（OCR_LLM_URL / OCR_LLM_TOKEN），或显式设置 ${OCR_ALLOW_DERIVED_LLM_KEY_ENV}=1 允许派生。`;
        }
      } else if (!aiReviewLlmNoticed && willDerive) {
        aiReviewLlmNoticed = true;
        llmNotice =
          '\n⚠️ 安全提示：AI 审查由第三方工具执行，会使用你的模型 API key。' +
          '如需隔离，可以为它单独配置一个专用 key（在配置文件中设置 OCR_LLM_TOKEN，详见 README）。';
      }
      // 派生被拒时清空 llm 配置：buildOcrEnv 的派生条件（baseUrl/apiKey/model 齐全）不成立，
      // ocr 子进程拿不到机器人主 key；显式 OCR_* 环境变量 / OCR 配置文件不受影响
      const jobLlm = deriveAllowed
        ? { baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, model: cfg.llmModel }
        : { baseUrl: '', apiKey: '', model: '' };
      if (llmNotice) {
        await channel.notifyOpenId(
          openId,
          `🤖 AI 审查已开始：《${title}》\n正在调用代码审查工具（open-code-review）分析改动，完成后推送结果（首次使用需自动下载，耗时稍长）。${llmNotice}`,
        );
      }
      // /stop 可中断：竞速胜出后立即向用户收尾返回；signal 同时透传给 runAiReview，
      // 底层 ocr 子进程随 abort 被 execFile 立即 kill，不必等自身 15 分钟超时。
      // （Promise.race 已给 runAiReview 挂上反应，其后续 settle 不会成未处理 rejection。）
      const result = await Promise.race([
        runReview({
          kanbanUrl: cfg.kanbanUrl,
          attemptId,
          title,
          llm: jobLlm,
          signal: ctl.signal,
        }),
        new Promise<never>((_, reject) => {
          ctl.signal.addEventListener('abort', () => reject(new Error('已中断')), { once: true });
        }),
      ]);
      // 投递段（报告写盘 / 卡片推送）与审查执行分开兜底：投递失败不是「AI 审查失败」，
      // 审查结果本身也不丢——降级为文本推送（截断 + 注明失败原因）
      try {
        if (reportServer) {
          // 完整结果写入 HTML 报告，飞书推卡片（按钮直达静态报告页，进程存活期间有效）
          const name = await writeReviewReport({
            title,
            attemptId,
            generatedAt: new Date().toLocaleString('zh-CN'),
            text: result,
          });
          const url = `${reportServer.baseUrl}/${name}`;
          await channel.notifyCardOpenId(openId, buildAiReviewCard(title, url, isAllPass(result)));
        } else {
          await channel.notifyOpenId(openId, `🤖 AI 审查结果：《${title}》\n${result}`);
        }
      } catch (deliverErr) {
        const dmsg = errMessage(deliverErr);
        // 原始错误（英文 fs/网络原文 + 宿主机绝对路径）只进日志，不落用户面
        console.error(`[review] 报告写盘/卡片推送失败，降级文本推送: ${dmsg}`);
        const excerpt = result.length > 3000 ? `${result.slice(0, 3000)}\n…（结果过长已截断）` : result;
        await channel
          .notifyOpenId(
            openId,
            `🤖 AI 审查结果：《${title}》\n⚠️ 审查报告生成或推送失败，改为文本推送：\n${excerpt}`,
          )
          .catch((e) => {
            // 降级文本也失败：结果无法送达，只能落日志（不再往外抛，避免误报「AI 审查失败」）
            console.error(`[review] 降级文本推送也失败: ${errMessage(e)}`);
          });
      }
      // 注入会话：用户追问「按审查意见修一下」时 agent 有上下文
      // （审查结果含被审仓库代码，属外部内容，UNTRUSTED 包裹；注入发生在轮边界）
      try {
        router
          .getOrCreate(openId)
          .injectSystemNote(
            `[AI 审查完成 ${new Date().toLocaleString('zh-CN')}]\n《${title}》\n${wrapUntrusted(result.slice(0, 1500))}`,
          );
      } catch {
        /* ignore */
      }
    } catch (err) {
      if (ctl.signal.aborted) {
        await safeNotify(channel, openId, `⏹ AI 审查已中断：《${title}》`);
      } else {
        // 失败原因截断防超长推送；底层文案自带真实出路（重新发起/人工查看指引）时不重复追加后缀。
        // 注意「重试」不算自带出路：底层文案里的重试指引若指向卡片按钮，按钮已随
        // 「进行中」卡片换掉，是必败指引——必须补上文本回复类出路，不能让它成为唯一出路
        const message = errMessage(err).slice(0, 200);
        const hasOwnWayOut = ['重新发起', '查看任务'].some((w) => message.includes(w));
        const retryHint = hasOwnWayOut ? '' : '\n可回复「重新审查这个任务」再试一次。';
        await safeNotify(channel, openId, `⚠️ AI 审查失败：《${title}》\n${message}${retryHint}`);
      }
    } finally {
      aiReviewRunning.delete(attemptId);
      untrackJob('review', attemptId);
    }
  };

  /**
   * 「AI 审查」按钮的同步受理判定：去重/并发上限等早退分支在首个 await 前完成并同步返回；
   * accepted 时同步落去重键、void 启动异步段（回调方据此才敢同步换「进行中」卡片）。
   */
  const tryStartAiReview = (openId: string, attemptId: string, title: string): TryStartResult<'running' | 'over-limit'> => {
    title = title.trim() || '未命名任务';
    if (aiReviewRunning.has(attemptId)) {
      void safeNotify(channel, openId, `🤖 《${title}》的 AI 审查正在进行中，请稍候…`);
      return { status: 'running', toast: 'AI 审查进行中，请稍候' };
    }
    // 全局并发上限：超出时拒收并提示稍后再试（按 attempt 去重挡不住不同 attempt 的叠加）
    if (aiReviewRunning.size >= AI_REVIEW_MAX_CONCURRENT) {
      void safeNotify(
        channel,
        openId,
        `🤖 同时进行的 AI 审查已达上限（${AI_REVIEW_MAX_CONCURRENT} 个）：《${title}》本次未开始。请等现有审查完成后，重新点击看板通知卡片上的「AI 审查」。`,
      );
      return { status: 'over-limit', toast: `已达上限（${AI_REVIEW_MAX_CONCURRENT} 个），请稍后再试` };
    }
    const ctl = new AbortController();
    aiReviewRunning.set(attemptId, { openId, ctl });
    trackJob({ kind: 'review', openId, key: attemptId, title, startedAt: new Date().toISOString() });
    // 受理成功即记录：文本「重新审查这个任务」确定性分支据此复用本次审查重新发起
    boundedMapSet(lastReviewByUser, openId, { attemptId, title }, DIAGNOSIS_STATE_MAX_ENTRIES);
    void runAiReviewJob(openId, attemptId, title, ctl);
    return { status: 'accepted' };
  };

  /** 失败诊断的异步段（采集 → LLM 诊断 → 推结果卡片 → 注入会话）；受理判定与去重落键在 tryStartDiagnosis 同步完成。 */
  const runDiagnosisJob = async (
    openId: string,
    diagnosisId: string,
    taskId: string,
    attemptId: string,
    title: string,
    dedupeKey: string,
    runningKey: string,
    ctl: AbortController,
    url?: string,
  ): Promise<void> => {
    try {
      const { text, attemptId: diagnosedAttemptId } = await runDiagnosis({
        kanbanUrl: cfg.kanbanUrl,
        taskId,
        title,
        llm: { baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, model: cfg.llmModel },
        timeoutMs: DIAGNOSIS_TIMEOUT_MS,
        signal: ctl.signal,
      });
      if (ctl.signal.aborted) throw new Error('已中断');
      const realAttemptId = diagnosedAttemptId || attemptId;
      if (realAttemptId) {
        boundedSetAdd(diagnosedKeys, `${openId}:${taskId}:${realAttemptId}`, DIAGNOSIS_STATE_MAX_ENTRIES);
        diagnosedKeys.add(dedupeKey);
      }
      const result: DiagnosisResult = { diagnosisId, openId, taskId, text };
      if (diagnosedAttemptId) result.attemptId = diagnosedAttemptId;
      if (url) result.url = url;
      boundedMapSet(diagnosisResults, diagnosisId, result, DIAGNOSIS_STATE_MAX_ENTRIES);
      boundedMapSet(latestDiagnosisByUserTask, runningKey, diagnosisId, DIAGNOSIS_STATE_MAX_ENTRIES);
      boundedMapSet(lastDiagnosisByUser, openId, { diagnosisId, taskId, title }, DIAGNOSIS_STATE_MAX_ENTRIES);
      // 结果推送与诊断执行分开兜底：推送失败降级为文本（含重试指引），不谎报「诊断失败」
      try {
        const messageId = await channel.notifyCardOpenId(
          openId,
          buildDiagnosisCard(title, text, taskId, { diagnosisId, owner: openId, ...(url ? { url } : {}) }),
        );
        if (messageId) result.cardMessageId = messageId;
      } catch (deliverErr) {
        console.error(`[diagnosis] 诊断卡片推送失败，降级文本推送: ${errMessage(deliverErr)}`);
        const excerpt = text.length > 3000 ? `${text.slice(0, 3000)}\n…（结果过长已截断）` : text;
        await channel
          .notifyOpenId(openId, `🔍 AI 失败诊断：《${title}》\n${excerpt}\n\n要按诊断结论重试，回复「重试这个任务」。`)
          .catch((e) => {
            diagnosedKeys.delete(`${openId}:${taskId}:${realAttemptId}`);
            diagnosedKeys.delete(dedupeKey);
            diagnosisResults.delete(diagnosisId);
            latestDiagnosisByUserTask.delete(runningKey);
            console.error(`[diagnosis] 降级文本推送也失败: ${errMessage(e)}`);
          });
      }
      try {
        router
          .getOrCreate(openId)
          .injectSystemNote(
            `[AI 失败诊断完成 ${new Date().toLocaleString('zh-CN')}]\n《${title}》\n${wrapUntrusted(text.slice(0, 1500))}`,
          );
      } catch {
        /* ignore */
      }
    } catch (err) {
      if (ctl.signal.aborted) {
        await safeNotify(channel, openId, `⏹ AI 诊断已中断：《${title}》`);
      } else {
        const message = errMessage(err).slice(0, 200);
        const hasOwnWayOut = ['重新发起', '配置不完整'].some((w) => message.includes(w));
        const retryHint = hasOwnWayOut ? '' : '\n可回复「为什么失败」重新诊断。';
        await safeNotify(channel, openId, `⚠️ AI 诊断失败：《${title}》\n${message}${retryHint}`);
      }
    } finally {
      diagnosisRunning.delete(runningKey);
      untrackJob('diagnosis', diagnosisId);
    }
  };

  /** 「AI 诊断」按钮的同步受理判定（早退分支同步返回，accepted 时落去重键并启动异步段）。 */
  const tryStartDiagnosis = (
    openId: string,
    taskId: string,
    attemptId: string,
    title: string,
    url?: string,
  ): TryStartResult<'running' | 'diagnosed' | 'over-limit'> => {
    title = title.trim() || '未命名任务';
    const runningKey = `${openId}:${taskId}`;
    const dedupeKey = `${runningKey}:${attemptId || 'latest'}`;
    if (diagnosedKeys.has(dedupeKey)) {
      const diagnosisId = latestDiagnosisByUserTask.get(runningKey) ?? '';
      const retryStarted = retryLaunching.has(diagnosisId) || [...retryLaunched].some((k) => k.startsWith(`${diagnosisId}:`));
      const tip = retryStarted
        ? '重试已按诊断结论发起过，任务进展会继续推送；如长时间无进展，请到看板查看或手动重新发起。'
        : diagnosisResults.get(diagnosisId)?.cardMessageId
          ? '结果见上方诊断卡片；点卡片上的「↻ 按诊断结论重试」可按结论重启任务。'
          : '结果见上方消息；回复「重试这个任务」可按结论重启。';
      void safeNotify(channel, openId, `🔍 《${title}》这次失败已诊断过，${tip}`);
      return { status: 'diagnosed', toast: '已诊断过，结果见上方' };
    }
    if (diagnosisRunning.has(runningKey)) {
      void safeNotify(channel, openId, `🔍 《${title}》的 AI 诊断正在进行中，请稍候…`);
      return { status: 'running', toast: 'AI 诊断进行中，请稍候' };
    }
    if (diagnosisRunning.size >= DIAGNOSIS_MAX_CONCURRENT) {
      void safeNotify(
        channel,
        openId,
        `🔍 同时进行的 AI 诊断已达上限（${DIAGNOSIS_MAX_CONCURRENT} 个）：《${title}》本次未开始。请等现有诊断完成后，重新点击失败卡片上的「AI 诊断」。`,
      );
      return { status: 'over-limit', toast: `已达上限（${DIAGNOSIS_MAX_CONCURRENT} 个），请稍后再试` };
    }
    const ctl = new AbortController();
    const diagnosisId = randomUUID();
    diagnosisRunning.set(runningKey, { openId, ctl });
    trackJob({ kind: 'diagnosis', openId, key: diagnosisId, taskId, title, startedAt: new Date().toISOString() });
    void runDiagnosisJob(openId, diagnosisId, taskId, attemptId, title, dedupeKey, runningKey, ctl, url);
    return { status: 'accepted' };
  };

  /** 重试的异步段：attemptId 补拉与 follow-up 都受同一 AbortSignal 约束。 */
  const runRetryJob = async (
    openId: string,
    title: string,
    result: DiagnosisResult,
    ctl: AbortController,
  ): Promise<void> => {
    const { diagnosisId, taskId } = result;
    let followUpStarted = false;
    try {
      let attemptId = result.attemptId;
      if (!attemptId) {
        try {
          attemptId = await fetchAttemptId(cfg.kanbanUrl, taskId, ctl.signal);
        } catch (err) {
          if (ctl.signal.aborted) throw err;
          console.error(`[diagnosis] 补拉执行记录失败: ${errMessage(err)}`);
          await safeNotify(
            channel,
            openId,
            `⚠️ 重试未发起：《${title}》查询执行记录失败（看板暂时不可用），请稍后回复「重试这个任务」重新发起。`,
          );
          return;
        }
      }
      if (ctl.signal.aborted) throw new Error('已中断');
      if (!attemptId) {
        await safeNotify(
          channel,
          openId,
          `⚠️ 重试未发起：《${title}》找不到可重试的执行记录（可能已被看板清理），请到看板手动重新发起该任务。`,
        );
        return;
      }
      const retryKey = `${diagnosisId}:${attemptId}`;
      if (retryLaunched.has(retryKey)) {
        await safeNotify(
          channel,
          openId,
          `↻ 《${title}》的重试已发起过，任务进展会继续推送；如长时间无进展，请到看板查看或手动重新发起。`,
        );
        return;
      }
      boundedSetAdd(retryLaunched, retryKey, DIAGNOSIS_STATE_MAX_ENTRIES);
      const followUp = buildRetryPrompt(title, result.text);
      const followUpExcerpt = excerptMiddle(followUp, 400);
      if (ctl.signal.aborted) throw new Error('已中断');
      try {
        followUpStarted = true;
        await sendFollowUp(cfg.kanbanUrl, attemptId, followUp, ctl.signal);
      } catch (err) {
        // 中断时请求可能已经到服务端，不能摘键诱导用户立刻再发一次；普通失败仍回补可重试。
        if (!ctl.signal.aborted) retryLaunched.delete(retryKey);
        throw err;
      }
      if (result.cardMessageId) {
        const settledAt = new Date().toLocaleString('zh-CN', { hour12: false });
        await channel
          .updateCard(
            result.cardMessageId,
            buildDiagnosisCard(title, result.text, taskId, { settledAt, followUpExcerpt, ...(result.url ? { url: result.url } : {}) }),
          )
          .catch((e) => console.error(`[diagnosis] 诊断卡片终态更新失败: ${errMessage(e)}`));
      }
      const stoppedNote = ctl.signal.aborted ? '\n⏹ 已收到停止请求，但跟进指令已发出，无法撤回；请到看板确认任务状态。' : '';
      await safeNotify(
        channel,
        openId,
        `↻ 已按诊断结论发起重试：《${title}》\n已把以下跟进指令发给任务执行方，任务进展会继续推送（如长时间无进展，请到看板查看或手动重新发起）：\n${followUpExcerpt}${stoppedNote}`,
      );
    } catch (err) {
      if (ctl.signal.aborted) {
        await safeNotify(
          channel,
          openId,
          followUpStarted
            ? `⏹ 重试已中断：《${title}》\n重试请求可能已发出，结果无法确认，也无法撤回；请到看板确认任务状态，避免重复发起。`
            : `⏹ 重试已中断：《${title}》\n重试指令未发出。`,
        );
      } else {
        const message = errMessage(err).slice(0, 200);
        const hasOwnWayOut = ['重新发起', '手动', '已被看板清理'].some((w) => message.includes(w));
        const retryHint = hasOwnWayOut ? '' : '\n可回复「重试这个任务」重新发起重试。';
        await safeNotify(channel, openId, `⚠️ 重试发起失败：《${title}》\n${message}${retryHint}`);
      }
    } finally {
      retryLaunching.delete(diagnosisId);
      retryRunning.delete(diagnosisId);
      untrackJob('retry', diagnosisId);
    }
  };

  /** 同步按 diagnosisId 校验结果存在性与归属，并在首个 await 前登记控制器和去重键。 */
  const tryStartRetry = (openId: string, diagnosisId: string, title: string): TryStartResult<'launching' | 'launched' | 'no-diagnosis' | 'not-owner'> => {
    title = title.trim() || '未命名任务';
    const result = diagnosisResults.get(diagnosisId);
    if (result && result.openId !== openId) {
      const tip = '这是其他用户发起的诊断，只有发起人可以读取或重试。';
      void safeNotify(channel, openId, tip);
      return { status: 'not-owner', toast: tip };
    }
    if (!result) {
      void safeNotify(
        channel,
        openId,
        `⚠️ 找不到《${title}》的诊断结论（卡片可能来自旧版或机器人已重启）。请回复「为什么失败」重新诊断后再重试。`,
      );
      return { status: 'no-diagnosis', toast: '找不到诊断结论，请回复「为什么失败」重新诊断' };
    }
    const launchedToast = '重试已发起过，请稍候';
    const launchedNotify = `↻ 《${title}》的重试已发起过，任务进展会继续推送；如长时间无进展，请到看板查看或手动重新发起。`;
    if (retryLaunching.has(diagnosisId)) {
      void safeNotify(channel, openId, `↻ 《${title}》的重试正在发起中，请稍候…`);
      return { status: 'launching', toast: '重试正在发起中，请稍候' };
    }
    if (result.attemptId && retryLaunched.has(`${diagnosisId}:${result.attemptId}`)) {
      void safeNotify(channel, openId, launchedNotify);
      return { status: 'launched', toast: launchedToast };
    }
    const ctl = new AbortController();
    retryLaunching.add(diagnosisId);
    retryRunning.set(diagnosisId, { openId, ctl });
    trackJob({ kind: 'retry', openId, key: diagnosisId, taskId: result.taskId, title, startedAt: new Date().toISOString() });
    void runRetryJob(openId, title, result, ctl);
    return { status: 'accepted' };
  };

  const abortForUser = (openId: string): { reviews: number; diagnoses: number; retries: number } => {
    let reviews = 0;
    let diagnoses = 0;
    let retries = 0;
    for (const r of aiReviewRunning.values()) {
      if (r.openId === openId && !r.ctl.signal.aborted) {
        r.ctl.abort();
        reviews++;
      }
    }
    for (const r of diagnosisRunning.values()) {
      if (r.openId === openId && !r.ctl.signal.aborted) {
        r.ctl.abort();
        diagnoses++;
      }
    }
    for (const r of retryRunning.values()) {
      if (r.openId === openId && !r.ctl.signal.aborted) {
        r.ctl.abort();
        retries++;
      }
    }
    return { reviews, diagnoses, retries };
  };

  const stopAll = (): void => {
    for (const running of [aiReviewRunning, diagnosisRunning, retryRunning]) {
      for (const r of running.values()) {
        if (!r.ctl.signal.aborted) r.ctl.abort();
      }
    }
  };

  return {
    tryStartAiReview,
    tryStartDiagnosis,
    tryStartRetry,
    lastDiagnosis: (openId) => lastDiagnosisByUser.get(openId),
    lastReview: (openId) => lastReviewByUser.get(openId),
    abortForUser,
    stopAll,
    notifyInterruptedJobs,
  };
}
