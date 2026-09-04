import OpenAI from 'openai';
import { apiGet, apiPost, pickLatestAttempt, KanbanHttpError } from './http';
import { errMessage } from '../infra/err';
import type { OcrLlmConfig } from './ai-review';

/**
 * 失败任务 AI 诊断：失败卡片的「AI 诊断」按钮触发，采集该任务失败 attempt 的
 * 可用信息（任务描述 / 失败摘要 / diff 统计，以看板 REST 实际能拿到的为准），
 * 调 LLM 生成中文诊断（失败原因归类 + 关键证据摘要 + 建议修复方向），
 * 诊断结论再作为「↻ 重试」按钮的 follow-up 指令（带失败原因与修复建议重启任务）。
 *
 * LLM 配置派生口径与 AI 审查（ai-review.ts）一致：OCR_LLM_* 逐项优先
 * （专用 key/端点/模型可借此与主配置隔离），缺项回退机器人主 LLM 配置。
 * 与审查的差别：诊断是单次 chat 调用（不拉起 ocr 子进程），超时更短（默认 6 分钟）。
 */

/** 诊断整体超时（默认 6 分钟：单次 LLM 调用 + 少量看板采集，比 15 分钟的 AI 审查短）。 */
export const DIAGNOSIS_TIMEOUT_MS = 6 * 60 * 1000;

/** 诊断结论进入飞书卡片的截断上限（完整结论同时注入会话，追问不丢上下文）。 */
export const DIAGNOSIS_CARD_MAX_CHARS = 3000;

/** 重试 follow-up 指令里携带的诊断结论上限（指令只是重启背景，超长收敛避免 prompt 膨胀）。 */
const DIAGNOSIS_FOLLOWUP_MAX_CHARS = 2000;

/** 失败摘要进入诊断 prompt 的上限。 */
const SUMMARY_MAX_CHARS = 2000;

/** 任务描述进入诊断 prompt 的上限。 */
const DESCRIPTION_MAX_CHARS = 1500;

export interface DiagnosisLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** OCR_LLM_URL 是给 ocr CLI 的完整端点（…/chat/completions）；OpenAI SDK 需要剥回 baseURL。 */
function toSdkBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '');
}

/**
 * 诊断 LLM 配置：OCR_LLM_URL / OCR_LLM_TOKEN / OCR_LLM_MODEL 逐项优先，
 * 缺项回退机器人主 LLM 配置（与 ai-review 的 buildOcrEnv 同一隔离语义，
 * 只是消费方从 ocr 子进程换成本进程内的 OpenAI SDK 调用）。
 */
export function resolveDiagnosisLlm(fallback: OcrLlmConfig, env: NodeJS.ProcessEnv = process.env): DiagnosisLlmConfig {
  const url = (env.OCR_LLM_URL || '').trim();
  return {
    baseUrl: url ? toSdkBaseUrl(url) : fallback.baseUrl,
    apiKey: (env.OCR_LLM_TOKEN || '').trim() || fallback.apiKey,
    model: (env.OCR_LLM_MODEL || '').trim() || fallback.model,
  };
}

/** 诊断采集到的失败上下文（看板 REST 实际可得的全部字段）。 */
export interface FailureContext {
  taskId: string;
  title: string;
  /** 任务描述（需求背景；取不到为空串）。 */
  description: string;
  /** 最近一次 attempt 的失败摘要（last_attempt_summary 等宽松字段；取不到为空串）。 */
  attemptSummary: string;
  /** 最新 attempt id（重试 follow-up 定位会话用；无 attempt 时为空）。 */
  attemptId?: string;
  /** 最新 attempt 的 diff 统计（取不到为 undefined）。 */
  diffStats?: { filesChanged?: number; additions?: number; deletions?: number };
}

function toNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** 宽松提取任务详情里的描述与失败摘要（看板版本间字段可能不同，取不到就静默兜底）。 */
function pickTaskFields(detail: unknown): { description: string; attemptSummary: string } {
  if (!detail || typeof detail !== 'object') return { description: '', attemptSummary: '' };
  const o = detail as Record<string, unknown>;
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  const summary = o.last_attempt_summary ?? o.summary ?? o.result ?? o.last_attempt_output;
  return { description, attemptSummary: typeof summary === 'string' ? summary.trim() : '' };
}

/** 从 /task-attempts/summary 返回里宽松提取单个 attempt 的 diff 统计（形状不稳定：数组或按 id 键控）。 */
function pickDiffStatsFor(raw: unknown, attemptId: string): FailureContext['diffStats'] {
  const rows: Array<Record<string, unknown>> = [];
  if (Array.isArray(raw)) {
    for (const v of raw) if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v as Record<string, unknown>);
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) rows.push({ ...v, __key: k } as Record<string, unknown>);
    }
  }
  const row = rows.find((r) => {
    const id = String(r.workspace_id ?? r.id ?? r.attempt_id ?? r.task_attempt_id ?? r.__key ?? '');
    return id === attemptId;
  });
  if (!row) return undefined;
  const stats: NonNullable<FailureContext['diffStats']> = {};
  const filesChanged = toNumber(row.files_changed ?? row.file_count ?? row.filesChanged ?? row.changed_files_count);
  if (filesChanged !== undefined) stats.filesChanged = filesChanged;
  const additions = toNumber(row.additions ?? row.added_lines ?? row.lines_added);
  if (additions !== undefined) stats.additions = additions;
  const deletions = toNumber(row.deletions ?? row.deleted_lines ?? row.lines_removed);
  if (deletions !== undefined) stats.deletions = deletions;
  return Object.keys(stats).length ? stats : undefined;
}

/** 采集失败上下文：任务详情 + 最新 attempt + diff 统计；后两者失败不阻断（有多少用多少）。 */
export async function collectFailureContext(kanbanUrl: string, taskId: string): Promise<FailureContext> {
  const detail = await apiGet(kanbanUrl, `/tasks/${taskId}`); // 任务详情拿不到没法诊断，错误照常上抛
  const { description, attemptSummary } = pickTaskFields(detail);
  const title =
    detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).title === 'string'
      ? ((detail as Record<string, unknown>).title as string)
      : '';
  let attemptId: string | undefined;
  let diffStats: FailureContext['diffStats'];
  try {
    attemptId = pickLatestAttempt(await apiGet(kanbanUrl, `/task-attempts?task_id=${taskId}`))?.id;
  } catch {
    /* attempts 拉取失败不阻断诊断（重试时按钮侧再补拉） */
  }
  if (attemptId) {
    try {
      diffStats = pickDiffStatsFor(await apiPost(kanbanUrl, '/task-attempts/summary', { archived: false }), attemptId);
    } catch {
      /* diff 统计端点可选 */
    }
  }
  return { taskId, title, description, attemptSummary, attemptId, diffStats };
}

/** 诊断 prompt（纯函数便于单测）：三段式中文输出契约 + 采集到的材料。 */
export function buildDiagnosisPrompt(ctx: FailureContext, title: string): string {
  // 标题取不到时用「该任务」指代：塞裸 UUID 会被 LLM 复述进卡片，用户无从辨认
  const ref = title || ctx.title ? `看板任务「${title || ctx.title}」` : '该任务';
  const parts: string[] = [
    `${ref}的最近一次自动执行失败了。请根据以下材料给出诊断，严格按三段输出：`,
    '一、失败原因归类：从【测试失败 / 构建错误 / 代码冲突 / 执行超时 / 需求不清 / 环境或依赖问题 / 其他】中选一个最贴切的，并用一两句说明判断依据',
    '二、关键证据摘要：引用下方材料中最能说明问题的内容，保持简短',
    '三、建议修复方向：给出可操作的下一步，供再次执行该任务的 Agent 直接参考',
  ];
  if (ctx.description) parts.push(`【任务描述】\n${ctx.description.slice(0, DESCRIPTION_MAX_CHARS)}`);
  if (ctx.attemptSummary) parts.push(`【失败摘要】\n${ctx.attemptSummary.slice(0, SUMMARY_MAX_CHARS)}`);
  if (ctx.diffStats) {
    const s = ctx.diffStats;
    parts.push(
      `【变更统计】改动 ${s.filesChanged ?? '未知'} 个文件，+${s.additions ?? '?'} / -${s.deletions ?? '?'}`,
    );
  }
  if (!ctx.description && !ctx.attemptSummary && !ctx.diffStats) {
    parts.push('（看板未提供失败摘要等更多材料，请基于任务标题给出最可能的原因与排查建议，并说明材料不足。）');
  }
  return parts.join('\n\n');
}

export interface FailureDiagnosisResult {
  /** 诊断结论文本（中文三段式）。 */
  text: string;
  /** 采集到的最新 attempt id（重试 follow-up 用；无 attempt 时为空）。 */
  attemptId?: string;
}

export interface RunFailureDiagnosisOptions {
  kanbanUrl: string;
  taskId: string;
  /** 任务标题（卡片回传；采集到的详情标题优先）。 */
  title?: string;
  /** 机器人主 LLM 配置（OCR_LLM_* 未显式设置时的回退）。 */
  llm: OcrLlmConfig;
  /** 整体超时（默认 6 分钟，见 DIAGNOSIS_TIMEOUT_MS）。 */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 测试注入：替换失败上下文采集。 */
  collectContext?: (kanbanUrl: string, taskId: string) => Promise<FailureContext>;
  /** 测试注入：替换 LLM 调用。 */
  complete?: (prompt: string, llm: DiagnosisLlmConfig, signal?: AbortSignal) => Promise<string>;
}

const SYSTEM_PROMPT =
  '你是资深研发工程师，擅长诊断自动化编码任务的失败原因。全程使用简体中文回答，结论务实、可直接执行，不要使用内部术语黑话。';

/**
 * 采集失败的错误中文化（网络映射与 net-error 同族；kanban 层无反向依赖 config 的先例，这里内联最小集）：
 * 看板不可达/超时给中文定性，英文原文（fetch failed / The operation timed out…）由调用方收 HTA_DEBUG。
 */
function collectFailureMessage(err: unknown): string {
  if (err instanceof KanbanHttpError) {
    return err.status === 404 ? '该任务在看板上已不存在（可能已被清理）' : '看板接口暂时异常';
  }
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const s = [errMessage(err), cause?.code, cause?.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/timed?\s*out|etimedout|aborted/.test(s)) return '连接看板超时';
  if (s.includes('econnrefused')) return '看板不可达（连接被拒）';
  if (s.includes('enotfound') || s.includes('eai_again')) return '看板地址解析失败';
  if (s.includes('fetch failed')) return '看板不可达（网络请求失败）';
  return '看板响应异常';
}

/** 执行失败诊断：采集上下文 → 单次 LLM 调用；失败抛出中文错误（原文只进日志/HTA_DEBUG）。 */
export async function runFailureDiagnosis(opts: RunFailureDiagnosisOptions): Promise<FailureDiagnosisResult> {
  const collect = opts.collectContext ?? collectFailureContext;
  let ctx: FailureContext;
  try {
    ctx = await collect(opts.kanbanUrl, opts.taskId);
  } catch (err) {
    if (opts.signal?.aborted) throw new Error('已中断');
    if (process.env.HTA_DEBUG) console.error(`[diagnosis] 失败上下文采集原文：${errMessage(err).slice(0, 300)}`);
    throw new Error(`采集该任务的失败信息失败（${collectFailureMessage(err)}），请稍后重试。`);
  }
  const title = ctx.title || opts.title || '';
  const prompt = buildDiagnosisPrompt(ctx, title);
  const llm = resolveDiagnosisLlm(opts.llm, opts.env);
  const timeoutMs = opts.timeoutMs ?? DIAGNOSIS_TIMEOUT_MS;
  // 总时长兜底：OpenAI 客户端的 timeout 只是单次尝试（maxRetries:2 叠加最坏 3 倍），
  // 用 AbortSignal.timeout 与调用方 signal 组合约束整段 complete（含全部重试）
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  const turnSignal = AbortSignal.any(signals);
  const complete =
    opts.complete ??
    (async (p: string, l: DiagnosisLlmConfig, signal?: AbortSignal): Promise<string> => {
      if (!l.baseUrl || !l.apiKey || !l.model) {
        throw new Error('模型配置不完整，请联系部署者检查模型配置。');
      }
      const client = new OpenAI({ baseURL: l.baseUrl, apiKey: l.apiKey, timeout: timeoutMs, maxRetries: 2 });
      const resp = await client.chat.completions.create(
        {
          model: l.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: p },
          ],
          temperature: 0.2,
        },
        { signal },
      );
      const text = resp.choices[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('模型未返回诊断内容');
      return text.trim();
    });
  try {
    const text = await complete(prompt, llm, turnSignal);
    return { text, attemptId: ctx.attemptId };
  } catch (err) {
    if (opts.signal?.aborted) throw new Error('已中断');
    // 兜底信号到点（非调用方中断）：无论底层报什么错都按超时收尾（abort 原文不一定含 timeout 字样）
    if (turnSignal.aborted) {
      throw new Error(`AI 诊断超时（${Math.round(timeoutMs / 60000)} 分钟），已终止。`);
    }
    const message = errMessage(err);
    if (process.env.HTA_DEBUG) console.error(`[diagnosis] 模型调用失败原文：${message.slice(0, 300)}`);
    if (/timed?\s*out|timeout/i.test(message)) {
      throw new Error(`AI 诊断超时（${Math.round(timeoutMs / 60000)} 分钟），已终止。`);
    }
    if (message.includes('模型配置不完整') || message.includes('模型未返回诊断内容')) throw err;
    throw new Error('模型调用失败，请稍后重新点击卡片上的「AI 诊断」重试；持续失败请联系部署者检查模型配置。');
  }
}

/** 取任务最新 attempt id（重试时诊断结论缺 attemptId 的补拉；无 attempt 返回 undefined）。 */
export async function latestAttemptId(kanbanUrl: string, taskId: string): Promise<string | undefined> {
  return pickLatestAttempt(await apiGet(kanbanUrl, `/task-attempts?task_id=${taskId}`))?.id;
}

/**
 * 重试请求的看板错误定性：404 = 执行记录已被看板清理（自动重试必败，单独指路）；
 * 其余状态码统一中文定性，裸 HTTP 码不直达用户（收 HTA_DEBUG）。
 */
function followUpRequestError(err: unknown): Error {
  if (err instanceof KanbanHttpError) {
    if (process.env.HTA_DEBUG) console.error(`[diagnosis] 重试请求被看板拒绝：HTTP ${err.status}`);
    if (err.status === 404) return new Error('执行记录已被看板清理，请到看板手动重新发起该任务。');
    return new Error('看板接口暂时异常，请稍后重试；持续失败请联系部署者。');
  }
  return err instanceof Error ? err : new Error(errMessage(err));
}

/**
 * 以诊断结论作为 follow-up 指令重启任务：定位 attempt 的最新会话后 POST follow-up。
 * 按钮点击本身就是用户显式授权（与审批/AI 审查按钮同一语义），不再走二次确认。
 */
export async function sendDiagnosisFollowUp(kanbanUrl: string, attemptId: string, prompt: string): Promise<void> {
  let raw: unknown;
  try {
    raw = await apiGet(kanbanUrl, `/sessions?workspace_id=${encodeURIComponent(attemptId)}`);
  } catch (err) {
    throw followUpRequestError(err);
  }
  const list = Array.isArray(raw) ? raw : [];
  const sessionId = list
    .map((s) => (s && typeof s === 'object' ? String((s as Record<string, unknown>).id || '') : ''))
    .filter(Boolean)
    .pop();
  if (!sessionId) {
    throw new Error('找不到该任务的执行会话（可能已被看板清理），无法自动重试。请到看板手动重新发起该任务。');
  }
  try {
    await apiPost(kanbanUrl, `/sessions/${encodeURIComponent(sessionId)}/follow-up`, { prompt });
  } catch (err) {
    throw followUpRequestError(err);
  }
}

/** 组装重试 follow-up 指令：上次失败原因 + 修复建议作为再次执行的背景。 */
export function buildRetryPrompt(title: string, diagnosis: string): string {
  return [
    `上次自动执行失败的 AI 诊断结论：`,
    diagnosis.slice(0, DIAGNOSIS_FOLLOWUP_MAX_CHARS),
    '',
    `请根据以上诊断定位并修复问题，然后继续完成任务「${title}」。`,
  ].join('\n');
}
