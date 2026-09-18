/**
 * AI 审查 / 失败诊断 / 按诊断结论重试的完整作业生命周期（自 handler.ts 抽出）：
 * 卡片按钮回调触发的长耗时作业在消息串行队列外运行——并发上限、去重键表、
 * AbortController 登记（/stop 中断）、结果投递降级与会话注入都收口在这里，
 * handler 只剩按钮分发。
 */

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
import { safeNotify } from './notify';

/** AI 审查全局并发上限：每个审查是最长 15 分钟的子进程，不同 attempt 叠加会拖垮机器。 */
const AI_REVIEW_MAX_CONCURRENT = 2;

/** 失败诊断全局并发上限：单次 LLM 调用（最长 6 分钟），与 AI 审查同量级控制。 */
const DIAGNOSIS_MAX_CONCURRENT = 2;

/** 进程级诊断状态表上限：只增不减会无界累积，超上限整体清空（代价只是同键可再诊断/重试一次）。 */
const DIAGNOSIS_STATE_MAX_ENTRIES = 1000;

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
}

export interface ReviewJobs {
  /** 「AI 审查」按钮：执行 open-code-review 并把结果推回飞书（异步长耗时，调用方 void 后立即 ACK）。 */
  handleAiReview: (openId: string, attemptId: string, title: string) => Promise<void>;
  /** 「AI 诊断」按钮：采集失败信息 → LLM 中文诊断 → 推结果卡片（带「↻ 重试」按钮）。 */
  handleDiagnosis: (openId: string, taskId: string, attemptId: string, title: string) => Promise<void>;
  /** 「↻ 按诊断结论重试」按钮：以诊断结论作为 follow-up 指令重启任务。 */
  handleDiagnosisRetry: (openId: string, taskId: string, title: string) => Promise<void>;
  /** 文本「重试这个任务」确定性分支定位用：该用户最近一次诊断完成的任务（无记录为 undefined）。 */
  lastDiagnosis: (openId: string) => { taskId: string; title: string } | undefined;
  /** /stop：中断该用户进行中的 AI 审查/诊断，返回各自中断数（逐条收尾通知由作业自身发出）。 */
  abortForUser: (openId: string) => { reviews: number; diagnoses: number };
}

export function createReviewJobs(deps: ReviewJobsDeps): ReviewJobs {
  const { channel, cfg, router, reportServer } = deps;
  const runReview = deps.aiReviewRunner ?? runAiReview;
  const runDiagnosis = deps.diagnosisRunner ?? runFailureDiagnosis;
  const sendFollowUp = deps.followUpSender ?? sendDiagnosisFollowUp;

  /** 进行中的 AI 审查（按 attempt 去重，防止连点按钮）；携带发起人与 AbortController，/stop 可中断。 */
  const aiReviewRunning = new Map<string, { openId: string; ctl: AbortController }>();
  /** 进行中的失败诊断（按 task 去重，防止连点按钮）；携带发起人与 AbortController，/stop 可中断。 */
  const diagnosisRunning = new Map<string, { openId: string; ctl: AbortController }>();
  /** 已完成诊断的 (task, attempt) 键：同一 attempt 只诊断一次（进程内语义，与 AI 审查去重一致）。 */
  const diagnosedKeys = new Set<string>();
  /** 每个任务最近一次诊断结论（「↻ 重试」按钮的 follow-up 材料；键为 taskId）。 */
  const diagnosisResults = new Map<string, { attemptId?: string; text: string; cardMessageId?: string }>();
  /** 已发起过重试的 (task, attempt) 键：重试发起后按钮置终态，重复点击不再发起。 */
  const retryLaunched = new Set<string>();
  /** 发起中的重试（taskId 粒度，首个 await 前落键）：attemptId 补拉窗口内的连点穿透防护（retryLaunched 的键那时还算不出来）。 */
  const retryLaunching = new Set<string>();
  /** 每用户最近一次诊断完成的任务（文本「重试这个任务」确定性分支用；卡片按钮自带 taskId 不经过这里）。 */
  const lastDiagnosisByUser = new Map<string, { taskId: string; title: string }>();
  /** 首次 AI 审查的 LLM 配置告知是否已发送（每进程一次，避免刷屏）。 */
  let aiReviewLlmNoticed = false;

  /** 执行 AI 审查（open-code-review）并把结果推回飞书；同时注入会话上下文便于追问/修复。 */
  const handleAiReview = async (openId: string, attemptId: string, title: string): Promise<void> => {
    if (aiReviewRunning.has(attemptId)) {
      await safeNotify(channel, openId, `🤖 《${title}》的 AI 审查正在进行中，请稍候…`);
      return;
    }
    // 全局并发上限：超出时拒收并提示稍后再试（按 attempt 去重挡不住不同 attempt 的叠加）
    if (aiReviewRunning.size >= AI_REVIEW_MAX_CONCURRENT) {
      await safeNotify(
        channel,
        openId,
        `🤖 同时进行的 AI 审查已达上限（${AI_REVIEW_MAX_CONCURRENT} 个）：《${title}》本次未开始。请等现有审查完成后，重新点击看板通知卡片上的「AI 审查」。`,
      );
      return;
    }
    const ctl = new AbortController();
    aiReviewRunning.set(attemptId, { openId, ctl });
    try {
      // 首次触发时告知：AI 审查由第三方工具执行，会用到模型 API key（只提示一次，不刷屏）
      // （仅在实际会派生主 key 时提示；用户已自配 OCR_LLM_URL / OCR 配置文件则不打扰）
      let llmNotice = '';
      if (!aiReviewLlmNoticed && ocrWillDeriveBotLlm()) {
        aiReviewLlmNoticed = true;
        llmNotice =
          '\n⚠️ 安全提示：AI 审查由第三方工具执行，会使用你的模型 API key。' +
          '如需隔离，可以为它单独配置一个专用 key（在配置文件中设置 OCR_LLM_TOKEN，详见 README）。';
      }
      await channel.notifyOpenId(
        openId,
        `🤖 AI 审查已开始：《${title}》\n正在调用代码审查工具（open-code-review）分析改动，完成后推送结果（首次使用需自动下载，耗时稍长）。${llmNotice}`,
      );
      // /stop 可中断：竞速胜出后立即向用户收尾返回；signal 同时透传给 runAiReview，
      // 底层 ocr 子进程随 abort 被 execFile 立即 kill，不必等自身 15 分钟超时。
      // （Promise.race 已给 runAiReview 挂上反应，其后续 settle 不会成未处理 rejection。）
      const result = await Promise.race([
        runReview({
          kanbanUrl: cfg.kanbanUrl,
          attemptId,
          title,
          llm: { baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, model: cfg.llmModel },
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
          const name = writeReviewReport({
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
        // 失败原因截断防超长推送；底层文案自带出路（重试/重新发起/人工审查）时不重复追加重试后缀
        const message = errMessage(err).slice(0, 200);
        const hasOwnWayOut = ['重试', '重新发起', '人工审查'].some((w) => message.includes(w));
        const retryHint = hasOwnWayOut ? '' : '\n可稍后重新点击卡片上的「AI 审查」重试。';
        await safeNotify(channel, openId, `⚠️ AI 审查失败：《${title}》\n${message}${retryHint}`);
      }
    } finally {
      aiReviewRunning.delete(attemptId);
    }
  };

  /** 执行失败诊断（采集失败信息 → LLM 中文诊断）并推结果卡片（带「↻ 重试」按钮）；同时注入会话上下文。 */
  const handleDiagnosis = async (openId: string, taskId: string, attemptId: string, title: string): Promise<void> => {
    title = title.trim() || '未命名任务';
    const dedupeKey = `${taskId}:${attemptId || 'latest'}`;
    if (diagnosedKeys.has(dedupeKey)) {
      // 指引按结果实际形态分支：诊断卡片推送失败走文本降级时没有卡片按钮可点
      const tip = diagnosisResults.get(taskId)?.cardMessageId
        ? '结果见上方诊断卡片；点卡片上的「↻ 按诊断结论重试」可按结论重启任务。'
        : '结果见上方消息；回复「重试这个任务」可按结论重启。';
      await safeNotify(channel, openId, `🔍 《${title}》这次失败已诊断过，${tip}`);
      return;
    }
    if (diagnosisRunning.has(taskId)) {
      await safeNotify(channel, openId, `🔍 《${title}》的 AI 诊断正在进行中，请稍候…`);
      return;
    }
    // 全局并发上限：超出时拒收并提示稍后再试（按 task 去重挡不住不同任务的叠加）
    if (diagnosisRunning.size >= DIAGNOSIS_MAX_CONCURRENT) {
      await safeNotify(
        channel,
        openId,
        `🔍 同时进行的 AI 诊断已达上限（${DIAGNOSIS_MAX_CONCURRENT} 个）：《${title}》本次未开始。请等现有诊断完成后，重新点击失败卡片上的「AI 诊断」。`,
      );
      return;
    }
    const ctl = new AbortController();
    diagnosisRunning.set(taskId, { openId, ctl });
    try {
      await channel.notifyOpenId(
        openId,
        `🔍 AI 诊断已开始：《${title}》\n正在采集失败信息并调用模型分析（约几分钟内完成），完成后推送诊断结果。`,
      );
      const { text, attemptId: diagnosedAttemptId } = await runDiagnosis({
        kanbanUrl: cfg.kanbanUrl,
        taskId,
        title,
        llm: { baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, model: cfg.llmModel },
        timeoutMs: DIAGNOSIS_TIMEOUT_MS,
        signal: ctl.signal,
      });
      // 同一 attempt 只诊断一次：按钮与诊断采集到的真实 attempt 两个键都记（按钮 attempt 可能滞后）。
      // 拿不到真实 attempt（attempts 端点异常）时不落键：否则 task:latest 永久占位，
      // 之后的新失败会被谎称「已诊断过」并导向一张旧卡片。
      // dedupeKey 无条件落键：按钮 attempt 为空时它是 task:latest，诊断采到真实 attempt 后
      // 只落 task:<real> 会漏掉它——同卡片再点（attempt 仍为空）会绕过 task:<real> 重跑完整诊断
      const realAttemptId = diagnosedAttemptId || attemptId;
      if (realAttemptId) {
        if (diagnosedKeys.size >= DIAGNOSIS_STATE_MAX_ENTRIES) diagnosedKeys.clear();
        diagnosedKeys.add(`${taskId}:${realAttemptId}`);
        diagnosedKeys.add(dedupeKey);
      }
      const result: { attemptId?: string; text: string; cardMessageId?: string } = { text };
      if (diagnosedAttemptId) result.attemptId = diagnosedAttemptId;
      if (diagnosisResults.size >= DIAGNOSIS_STATE_MAX_ENTRIES) diagnosisResults.clear();
      diagnosisResults.set(taskId, result);
      // 「重试这个任务」文本分支按用户定位最近一次诊断的任务（卡片按钮自带 taskId，不走这里）
      if (lastDiagnosisByUser.size >= DIAGNOSIS_STATE_MAX_ENTRIES) lastDiagnosisByUser.clear();
      lastDiagnosisByUser.set(openId, { taskId, title });
      // 结果推送与诊断执行分开兜底：推送失败降级为文本（含重试指引），不谎报「诊断失败」
      try {
        const messageId = await channel.notifyCardOpenId(openId, buildDiagnosisCard(title, text, taskId));
        if (messageId) result.cardMessageId = messageId;
      } catch (deliverErr) {
        console.error(`[diagnosis] 诊断卡片推送失败，降级文本推送: ${errMessage(deliverErr)}`);
        const excerpt = text.length > 3000 ? `${text.slice(0, 3000)}\n…（结果过长已截断）` : text;
        await channel
          .notifyOpenId(openId, `🔍 AI 失败诊断：《${title}》\n${excerpt}\n\n要按诊断结论重试，回复「重试这个任务」。`)
          .catch((e) => {
            // 降级文本也失败：结果未送达，摘除去重键允许重新诊断——否则用户再点「AI 诊断」
            // 会被谎指「已诊断过，结果见上方消息」，而上方什么都没有
            diagnosedKeys.delete(`${taskId}:${realAttemptId}`);
            diagnosedKeys.delete(dedupeKey);
            console.error(`[diagnosis] 降级文本推送也失败: ${errMessage(e)}`);
          });
      }
      // 注入会话：用户追问「按诊断结论修一下」时 agent 有上下文
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
        // 失败原因截断防超长推送；底层文案自带出路（重试/重新发起/配置不完整联系部署者）时不重复追加重试后缀
        const message = errMessage(err).slice(0, 200);
        const hasOwnWayOut = ['重试', '重新发起', '配置不完整'].some((w) => message.includes(w));
        const retryHint = hasOwnWayOut ? '' : '\n可稍后重新点击失败卡片上的「AI 诊断」重试。';
        await safeNotify(channel, openId, `⚠️ AI 诊断失败：《${title}》\n${message}${retryHint}`);
      }
    } finally {
      diagnosisRunning.delete(taskId);
    }
  };

  /** 「↻ 按诊断结论重试」：以诊断结论作为 follow-up 指令重启任务（点击即显式授权，不再二次确认）。 */
  const handleDiagnosisRetry = async (openId: string, taskId: string, title: string): Promise<void> => {
    title = title.trim() || '未命名任务';
    const result = diagnosisResults.get(taskId);
    if (!result) {
      await safeNotify(
        channel,
        openId,
        `⚠️ 找不到《${title}》的诊断结论（机器人可能已重启）。请重新点击失败卡片上的「AI 诊断」后再重试。`,
      );
      return;
    }
    // 防连点提到首个 await 之前（taskId 粒度「发起中」标记）：result.attemptId 为空时补拉
    // latestAttemptId 是一次网络往返，窗口内第二次点击时 task:attempt 键还没算出来，
    // 只靠 retryLaunched 会双双穿透、重复发重试指令；成功发起后换成 task:attempt 键，失败摘除
    if (retryLaunching.has(taskId)) {
      await safeNotify(
        channel,
        openId,
        `↻ 《${title}》的重试已发起过，任务进展会继续推送；如长时间无进展，请到看板查看或手动重新发起。`,
      );
      return;
    }
    retryLaunching.add(taskId);
    try {
      // 诊断时没采到 attempt（attempts 端点异常）这里补拉一次；仍没有则无法定位会话
      let attemptId = result.attemptId;
      if (!attemptId) {
        try {
          attemptId = await latestAttemptId(cfg.kanbanUrl, taskId);
        } catch (err) {
          // 网络抖动/超时与「执行记录已清理」不是同一出口：前者提示稍后重试，后者才指路手动重新发起
          console.error(`[diagnosis] 补拉执行记录失败: ${errMessage(err)}`);
          await safeNotify(
            channel,
            openId,
            `⚠️ 重试未发起：《${title}》查询执行记录失败（看板暂时不可用），请稍后重新点击「↻ 按诊断结论重试」。`,
          );
          return;
        }
      }
      if (!attemptId) {
        await safeNotify(
          channel,
          openId,
          `⚠️ 重试未发起：《${title}》找不到可重试的执行记录（可能已被看板清理），请到看板手动重新发起该任务。`,
        );
        return;
      }
      const retryKey = `${taskId}:${attemptId}`;
      if (retryLaunched.has(retryKey)) {
        await safeNotify(
          channel,
          openId,
          `↻ 《${title}》的重试已发起过，任务进展会继续推送；如长时间无进展，请到看板查看或手动重新发起。`,
        );
        return;
      }
      if (retryLaunched.size >= DIAGNOSIS_STATE_MAX_ENTRIES) retryLaunched.clear();
      retryLaunched.add(retryKey);
      // 点「重试」时用户看不到将发送的 follow-up 全文（诊断结论直发执行方）：
      // 回执与终态卡片附双向截断摘要，发出去什么用户看得见
      const followUp = buildRetryPrompt(title, result.text);
      const followUpExcerpt = excerptMiddle(followUp, 400);
      try {
        await sendFollowUp(cfg.kanbanUrl, attemptId, followUp);
      } catch (err) {
        retryLaunched.delete(retryKey);
        throw err;
      }
      // 按钮置终态：诊断卡片原地替换为无按钮终态（参照确认卡片终态更新模式），失败不阻断
      if (result.cardMessageId) {
        const settledAt = new Date().toLocaleString('zh-CN', { hour12: false });
        await channel
          .updateCard(result.cardMessageId, buildDiagnosisCard(title, result.text, taskId, { settledAt, followUpExcerpt }))
          .catch((e) => console.error(`[diagnosis] 诊断卡片终态更新失败: ${errMessage(e)}`));
      }
      await safeNotify(
        channel,
        openId,
        `↻ 已按诊断结论发起重试：《${title}》\n已把以下跟进指令发给任务执行方，任务进展会继续推送：\n${followUpExcerpt}`,
      );
    } catch (err) {
      const message = errMessage(err).slice(0, 200);
      const hasOwnWayOut = ['重试', '重新发起', '手动', '已被看板清理'].some((w) => message.includes(w));
      const retryHint = hasOwnWayOut ? '' : '\n可稍后重新点击诊断卡片上的「↻ 按诊断结论重试」。';
      await safeNotify(channel, openId, `⚠️ 重试发起失败：《${title}》\n${message}${retryHint}`);
    } finally {
      retryLaunching.delete(taskId);
    }
  };

  const abortForUser = (openId: string): { reviews: number; diagnoses: number } => {
    // AI 审查在串行队列外运行（卡片回调触发），单独登记单独中断
    let reviews = 0;
    for (const r of aiReviewRunning.values()) {
      if (r.openId === openId && !r.ctl.signal.aborted) {
        r.ctl.abort();
        reviews++;
      }
    }
    // 失败诊断同样在队列外运行，一并中断（各有带标题的逐条收尾通知）
    let diagnoses = 0;
    for (const r of diagnosisRunning.values()) {
      if (r.openId === openId && !r.ctl.signal.aborted) {
        r.ctl.abort();
        diagnoses++;
      }
    }
    return { reviews, diagnoses };
  };

  return {
    handleAiReview,
    handleDiagnosis,
    handleDiagnosisRetry,
    lastDiagnosis: (openId) => lastDiagnosisByUser.get(openId),
    abortForUser,
  };
}
