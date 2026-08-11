import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ocrPackageSpec } from '../infra/deps';
import { minimalChildEnv } from '../infra/proc-env';
import { apiGet, validateRows } from './http';

/**
 * AI 审查（open-code-review）：根据看板 attempt 定位代码目录，调用 ocr CLI
 * 审查该 attempt 的 diff（merge-base(target_branch)..attempt_branch，与看板 diff 视图同口径）。
 *
 * - ocr 优先用 PATH 上的 `ocr`，未安装则 `npx -y <钉版本包规格>`（OCR_PACKAGE 可覆盖）。
 * - LLM 默认复用机器人的 OpenAI 兼容配置（派生为 OCR_LLM_* 环境变量）；用户已显式配置
 *   OCR_LLM_URL / OCR_LLM_TOKEN（专用 key 优先于主 key 派生）或
 *   ~/.opencodereview/config.json 里有 provider/llm 时尊重用户配置，不再注入对应项。
 */

const execFileP = promisify(execFile);

/** attempt 详情里与定位审查目录/所属任务相关的字段（宽松解析，看板版本间字段可能不同）。 */
interface AttemptRow {
  container_ref?: string | null;
  branch?: string | null;
  agent_working_dir?: string | null;
  task_id?: string | null;
}

interface AttemptRepoRow {
  path?: string;
  name?: string;
  target_branch?: string | null;
}

/** attempt 详情的运行时校验（宽容：字段缺失/null 容忍，存在则必须是 string）。 */
function isAttemptRow(v: unknown): v is AttemptRow {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (['container_ref', 'branch', 'agent_working_dir'] as const).every(
    (f) => r[f] === undefined || r[f] === null || typeof r[f] === 'string',
  );
}

export interface ReviewTarget {
  /** 本地 git 仓库目录（优先 workspace 内的仓库目录，兜底看板注册的原始仓库 path）。 */
  repoDir: string;
  /** diff 起点（target_branch）；缺失时 ocr 退化为工作区模式。 */
  fromRef?: string;
  /** diff 终点（attempt 分支）。 */
  toRef?: string;
  /** 所属看板任务 id（取任务描述作审查背景用）；看板版本不带该字段时为空。 */
  taskId?: string;
}

export interface OcrLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OcrCommand {
  cmd: string;
  prefixArgs: string[];
  via: 'path' | 'npx';
}

/**
 * git refname 合法性校验（fromRef/toRef 来自看板 API，作为 argv 传给 ocr 子进程）：
 * 仅允许字母数字与 ._/-；拒绝以 - 开头（防被当作选项）、..、空白与控制字符。
 */
export function isValidGitRef(ref: string): boolean {
  return Boolean(ref) && !ref.startsWith('-') && !ref.includes('..') && /^[A-Za-z0-9._/-]+$/.test(ref);
}

/** 异步探测（bot 事件循环内路径）：同步 execFileSync 每个最多阻塞 5s，飞书回调/心跳全卡。 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileP('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 定位 attempt 的代码目录与 diff 引用。
 * 候选顺序：container_ref/agent_working_dir → container_ref/<repo name> → container_ref
 * 本身 → 看板注册的原始仓库 path（use_worktree=false 时 agent 直接在原仓库提交）。
 */
export async function resolveReviewTarget(kanbanUrl: string, attemptId: string): Promise<ReviewTarget> {
  const raw: unknown = await apiGet(kanbanUrl, `/task-attempts/${attemptId}`);
  if (!isAttemptRow(raw)) {
    throw new Error('找不到该任务的 workspace（attempt）记录，可能已被清理。');
  }
  const attempt: AttemptRow = raw;
  let repos: AttemptRepoRow[] = [];
  try {
    // 宽容校验：字段缺失/null 容忍（看板版本间字段可能不同），类型不符或返回非数组时抛错，
    // 由下方 catch 兜底为「无 repos 信息」，不阻断 workspace 目录路径
    repos = validateRows<AttemptRepoRow>(`/task-attempts/${attemptId}/repos`, await apiGet(kanbanUrl, `/task-attempts/${attemptId}/repos`), {
      path: 'string',
      name: 'string',
      target_branch: 'string',
    });
  } catch {
    /* repos 端点失败不阻断，仍可尝试 workspace 目录 */
  }
  const container = typeof attempt.container_ref === 'string' ? attempt.container_ref.trim() : '';
  const workdir = typeof attempt.agent_working_dir === 'string' ? attempt.agent_working_dir.trim() : '';
  const candidates: string[] = [];
  if (container && workdir) candidates.push(path.join(container, workdir));
  if (container) {
    for (const r of repos) {
      const name = (r.name || '').trim();
      if (name) candidates.push(path.join(container, name));
    }
    candidates.push(container);
  }
  for (const r of repos) {
    const p = (r.path || '').trim();
    if (p) candidates.push(p);
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir) && (await isGitRepo(dir))) {
      const fromRef = repos.map((r) => (r.target_branch || '').trim()).find(Boolean) || undefined;
      const toRef = (attempt.branch || '').trim() || undefined;
      const taskId = typeof attempt.task_id === 'string' ? attempt.task_id.trim() || undefined : undefined;
      return { repoDir: dir, fromRef, toRef, taskId };
    }
  }
  throw new Error(
    '无法定位该任务的代码目录（workspace 可能已清理，或原始仓库不可达）。\n已尝试：\n' +
      (candidates.map((d) => `- ${d}`).join('\n') || '（无候选目录）') +
      '\n请用「人工审查」打开看板 diff。',
  );
}

/** 用户是否已在 OCR 侧配置好 provider/llm（已配置则尊重，不再注入派生环境变量）。 */
export function ocrConfigHasProvider(home = os.homedir()): boolean {
  try {
    const raw = fs.readFileSync(path.join(home, '.opencodereview', 'config.json'), 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    if (typeof json.provider === 'string' && json.provider.trim()) return true;
    const llm = json.llm as Record<string, unknown> | undefined;
    return Boolean(llm && (llm.url || llm.model));
  } catch {
    return false;
  }
}

/**
 * 组装 ocr 子进程环境：最小环境（见 proc-env.ts，不继承 LLM_API_KEY 等敏感变量）
 * + 显式 OCR_* 变量；显式 OCR_LLM_URL / 已有 OCR 配置文件优先；
 * 否则把机器人的 OpenAI 兼容配置派生为 OCR_LLM_*（OCR 环境变量优先级高于其配置文件）。
 * 安全：OCR_LLM_TOKEN 已显式设置（AI 审查专用 key）时不覆盖——避免把机器人主
 * LLM key 交给第三方 ocr 子进程的用户可借此隔离；URL/MODEL 同理按项回退派生。
 */
export function buildOcrEnv(
  llm: OcrLlmConfig,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): NodeJS.ProcessEnv {
  // OCR_* 是 ocr 的预期配置接口，显式放行；OCR_LLM_* 派生副本属预期用途，保留
  const explicit: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('OCR_')) explicit[key] = value;
  }
  const out: NodeJS.ProcessEnv = { ...minimalChildEnv(explicit, env), NO_COLOR: '1' };
  if (out.OCR_LLM_URL || ocrConfigHasProvider(home)) return out;
  if (llm.baseUrl && llm.apiKey && llm.model) {
    out.OCR_LLM_URL = /\/(chat\/completions|messages)\/?$/.test(llm.baseUrl)
      ? llm.baseUrl
      : `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    // 逐项回退：专用 OCR_LLM_TOKEN / OCR_LLM_MODEL 已显式提供时优先，不覆盖
    out.OCR_LLM_TOKEN = out.OCR_LLM_TOKEN || llm.apiKey;
    out.OCR_LLM_MODEL = out.OCR_LLM_MODEL || llm.model;
    out.OCR_USE_ANTHROPIC = out.OCR_USE_ANTHROPIC || 'false';
  }
  return out;
}

/**
 * AI 审查是否会把机器人主 LLM 配置派生给 ocr（未显式配置 OCR_LLM_URL 且
 * 无 OCR 配置文件时）。用于首次触发审查时告知用户主 key 将交给第三方子进程。
 */
export function ocrWillDeriveBotLlm(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): boolean {
  return !env.OCR_LLM_URL && !ocrConfigHasProvider(home);
}

/** ocr 可执行命令：PATH 优先，缺失回退 npx 钉版本包（首次会下载，缓存后同速）。异步探测（同 isGitRepo，避免阻塞 bot 事件循环）。 */
export async function findOcrCommand(env: NodeJS.ProcessEnv = process.env): Promise<OcrCommand> {
  try {
    await execFileP('ocr', ['version'], { timeout: 5000, env });
    return { cmd: 'ocr', prefixArgs: [], via: 'path' };
  } catch {
    return { cmd: 'npx', prefixArgs: ['-y', ocrPackageSpec(env)], via: 'npx' };
  }
}

/** 去掉 ANSI 转义与回车，避免污染飞书消息。 */
export function sanitizeCliOutput(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][0-9A-B]|\x07/g, '').replace(/\r/g, '');
}

export interface RunAiReviewOptions {
  kanbanUrl: string;
  attemptId: string;
  /** 任务标题，与按 task_id 拉取的任务描述一起作为 --background 传给 ocr 提供需求上下文。 */
  title?: string;
  llm: OcrLlmConfig;
  /** 整体超时（默认 15 分钟；ocr 内部单任务超时另计）。 */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** 取消信号（/stop）：abort 时 execFile 立即 kill ocr 子进程，不必等整体超时。 */
  signal?: AbortSignal;
}

/** ocr 无语言选项，通过 --background 注入输出语言要求。 */
const LANG_HINT = '输出要求：请全程使用简体中文撰写审查结论与建议。';

/** 任务描述注入 --background 的长度上限（描述只是需求背景，超长收敛避免 prompt 膨胀）。 */
const DESCRIPTION_MAX_CHARS = 2000;

/** 宽松提取任务详情里的描述字段（看板版本间字段可能不同，取不到返回空串）。 */
export function pickTaskDescription(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  const d = (detail as Record<string, unknown>).description;
  return typeof d === 'string' ? d.trim() : '';
}

/** 取 attempt 所属任务的描述；任何一步失败都静默兜底为空（描述只是审查背景，不阻断审查）。 */
export async function fetchTaskDescription(kanbanUrl: string, taskId: string): Promise<string> {
  try {
    return pickTaskDescription(await apiGet(kanbanUrl, `/tasks/${taskId}`));
  } catch {
    return '';
  }
}

/** 组装 ocr --background：任务标题 + 任务描述（需求上下文）+ 中文输出要求。 */
export function buildReviewBackground(title: string, description: string): string {
  const parts: string[] = [];
  const t = title.trim();
  if (t) parts.push(`任务标题：${t.slice(0, 200)}`);
  const d = description.trim();
  if (d) parts.push(`任务描述：\n${d.slice(0, DESCRIPTION_MAX_CHARS)}`);
  parts.push(LANG_HINT);
  return parts.join('\n');
}

/** 执行 AI 审查，返回完整文本结果（不截断，完整内容供 HTML 报告使用）；失败抛出带排查信息的中文错误。 */
export async function runAiReview(opts: RunAiReviewOptions): Promise<string> {
  const target = await resolveReviewTarget(opts.kanbanUrl, opts.attemptId);
  const ocr = await findOcrCommand(opts.env);
  const args = [...ocr.prefixArgs, 'review', '--repo', target.repoDir];
  if (target.fromRef && target.toRef) {
    if (!isValidGitRef(target.fromRef) || !isValidGitRef(target.toRef)) {
      throw new Error(`非法的 git 分支名（from=${target.fromRef}, to=${target.toRef}），已拒绝执行 AI 审查。`);
    }
    args.push('--from', target.fromRef, '--to', target.toRef);
  }
  args.push('--audience', 'agent', '--format', 'text');
  // 需求上下文：卡片只带标题，任务描述按 task_id 现场拉取（取不到不阻断审查）
  const description = target.taskId ? await fetchTaskDescription(opts.kanbanUrl, target.taskId) : '';
  args.push('--background', buildReviewBackground(opts.title || '', description));

  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  let stdout = '';
  let stderr = '';
  try {
    const out = await execFileP(ocr.cmd, args, {
      cwd: target.repoDir,
      env: buildOcrEnv(opts.llm, opts.env),
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      signal: opts.signal,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = out.stdout || '';
    stderr = out.stderr || '';
  } catch (err) {
    const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    // 完整输出进日志；消息里只带尾部 3 行，避免整段 stderr 倾倒给终端用户
    const full = sanitizeCliOutput(e.stderr || e.stdout || '').trim();
    const tail = full.split('\n').slice(-3).join('\n');
    if (full) console.error(`[ai-review] 代码审查工具完整输出：\n${full}`);
    if (e.killed) {
      throw new Error(
        `AI 审查超时（${Math.round(timeoutMs / 60000)} 分钟），已终止。可再次点击「AI 审查」重试。${tail ? `\n${tail}` : ''}`,
      );
    }
    throw new Error(`代码审查工具执行失败：${tail || e.message || '未知错误'}`);
  }
  const text = sanitizeCliOutput(stdout).trim() || sanitizeCliOutput(stderr).trim();
  return text || '（代码审查工具未产生输出：可能没有可审查的变更）';
}
