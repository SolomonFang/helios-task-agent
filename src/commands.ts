/**
 * CLI（终端）与飞书 bot 共用的启动序列与斜杠命令内容构建。
 * 通道差异通过 Paint（CLI 上色 / bot 纯文本，飞书消息不能带 ANSI 色码）
 * 与少量文案参数保留；文案、顺序与降级逻辑与两端原实现一致（纯重构）。
 */

import { KanbanMcp, diagnoseMcpFailure } from './kanban/mcp';
import { probeLarkCliAuthAsync, checkHkDepsAsync, LARK_CLI_AUTH_HINT, HK_CLI_INSTALL_HINT } from './deps';
import { LOCAL_TOOL_SUMMARY } from './tools';
import { loadSkillDigests } from './prompt';
import { friendlyLlmError } from './llm-error';
import type { AgentConfig } from './types';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** 输出着色适配：CLI 传 ui.c，bot 传 plainPaint。 */
export interface Paint {
  ok: (t: unknown) => string;
  warn: (t: unknown) => string;
  info: (t: unknown) => string;
  strong: (t: unknown) => string;
  gray: (t: unknown) => string;
}

export const plainPaint: Paint = { ok: String, warn: String, info: String, strong: String, gray: String };

/** 「试试对我说」示例：CLI /help 与 bot /help 共用唯一来源，避免两端文案漂移。 */
export const TRY_EXAMPLES: string[] = [
  '以后都从这个飞书地址同步任务：<链接>',
  '同步/列出我的任务（含链接会展开详情）',
  '写进 helios-kanban（确认后再创建，不自动启动）',
  '有哪些项目 / 创建一个任务：修复登录页样式 bug',
  '用 Claude 跑这个任务 / 再跟它说一句：先写测试（启用方式由你指定）',
  '把 xx 群最近的聊天整理成任务',
  '总结一下这个迭代做了什么 / 今天完成了什么（生成 HTML/MD 报告）',
];

/** 斜杠命令解析：返回小写命令词（如 '/status'），非命令返回 null。 */
export function parseCommand(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  return t.split(/\s+/)[0]!.toLowerCase();
}

export interface McpBootResult {
  mcp: KanbanMcp;
  ok: boolean;
  /** 连接失败的错误信息（ok=false 时有值）。 */
  error?: string;
  /** 已知失败模式的排查提示（未命中为 null）。 */
  hint: string | null;
}

/** 连接 kanban MCP（45s 超时）；失败不抛出（调用方按通道风格提示降级），返回诊断 hint。 */
export async function connectMcp(cfg: Pick<AgentConfig, 'mcpCommand' | 'mcpArgs'>): Promise<McpBootResult> {
  const mcp = new KanbanMcp({ command: cfg.mcpCommand, args: cfg.mcpArgs });
  try {
    await mcp.connect({ timeoutMs: 45000 });
    return { mcp, ok: true, hint: null };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (process.env.HTA_DEBUG) console.error(`\n[mcp] ${e.stack || e.message}`);
    return { mcp, ok: false, error: e.message, hint: diagnoseMcpFailure(mcp.getStderrTail()) };
  }
}

/** /status 的 kanban 健康探测：'ok' / 'HTTP <code>' / '不可达'。 */
export async function fetchKanbanHealth(kanbanUrl: string): Promise<string> {
  try {
    const res = await fetch(`${kanbanUrl.replace(/\/+$/, '')}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? 'ok' : `HTTP ${res.status}`;
  } catch {
    return '不可达';
  }
}

/** /status 内容行（通道自己的标题/缩进由调用方加）；extra 为 bot 专属的 ocr / 推送行。 */
export async function buildStatusLines(
  opts: {
    model: string;
    kanbanUrl: string;
    mcpOk: boolean;
    mcpToolCount: number;
    /** MCP 不可用时的状态说明（通道文案）。 */
    mcpDownNote: string;
    larkOk: boolean;
    extra?: string[];
  },
  p: Paint,
): Promise<string[]> {
  // 探测全部走异步版：/status 在 bot 事件循环里执行，同步 execFileSync 串行探测最坏阻塞十几秒
  const health = await fetchKanbanHealth(opts.kanbanUrl);
  // hk_cli 降级链依赖（jq/curl）：MCP 掉线时 hk.sh 才能兜底，缺失则降级链是断的
  const hkMissing = await checkHkDepsAsync();
  // larkOk 只代表二进制存在，补探测授权态，区分未安装/未授权/可用
  const larkAuthed = opts.larkOk ? (await probeLarkCliAuthAsync()) === 'ok' : false;
  const mcpText = opts.mcpOk
    ? p.ok(`ok（${opts.mcpToolCount} 个工具）`)
    : p.warn(
        hkMissing.length
          ? `${opts.mcpDownNote}；但 hk_cli 缺少 ${hkMissing.join('、')}，降级链不可用（${HK_CLI_INSTALL_HINT}）`
          : opts.mcpDownNote,
      );
  const larkText = !opts.larkOk
    ? p.warn('未安装（飞书读取不可用）')
    : larkAuthed
      ? p.ok('ok')
      : p.warn(`未授权（${LARK_CLI_AUTH_HINT}）`);
  const lines = [
    `模型: ${p.info(opts.model)}`,
    `kanban: ${health === 'ok' ? p.ok('ok') : p.warn(health)}（${opts.kanbanUrl}）`,
    `MCP: ${mcpText}`,
    `lark-cli: ${larkText}`,
    `hk_cli: ${hkMissing.length ? p.warn(`缺少 ${hkMissing.join('、')}（${HK_CLI_INSTALL_HINT}）`) : p.ok('ok')}`,
  ];
  return opts.extra?.length ? [...lines, ...opts.extra] : lines;
}

/** /tools 内容行：MCP 可用列工具，不可用输出降级说明；本地工具恒定。 */
export function buildToolsLines(
  opts: {
    mcpOk: boolean;
    mcpTools: Tool[];
    /** MCP 可用时的看板工具标题（通道文案，CLI 可上色）。 */
    kanbanHeader: string;
    /** MCP 不可用时的降级说明（整行替换看板工具段）。 */
    downNote: string;
    localHeader: string;
    /** 条目前缀：CLI 用缩进，bot 用 '· '。 */
    bullet: string;
  },
  p: Paint,
): string[] {
  const lines: string[] = [];
  if (opts.mcpOk) {
    lines.push(opts.kanbanHeader);
    for (const t of opts.mcpTools) {
      const desc = (t.description || '').split('\n')[0];
      lines.push(`${opts.bullet}${p.info('kanban_' + t.name)}${desc ? `  ${p.gray(desc)}` : ''}`);
    }
  } else {
    lines.push(opts.downNote);
  }
  lines.push(opts.localHeader);
  for (const t of LOCAL_TOOL_SUMMARY) lines.push(`${opts.bullet}${p.info(t.name)}  ${p.gray(t.summary)}`);
  return lines;
}

/** /skills 内容行；空目录时 CLI 只给提示、bot 保留标题（headerWhenEmpty）。 */
export function buildSkillsLines(
  opts: { header: string; bullet: string; footer?: string; headerWhenEmpty?: boolean },
  p: Paint,
): string[] {
  const skills = loadSkillDigests();
  if (!skills.length) {
    const note = p.gray('（skills/ 下没有已安装技能）');
    return opts.headerWhenEmpty ? [opts.header, note] : [note];
  }
  const lines = [opts.header];
  for (const s of skills) {
    const brief = s.description.replace(/\s+/g, ' ').slice(0, 100);
    lines.push(`${opts.bullet}${p.info(s.name)}  ${p.gray(brief)}`);
  }
  if (opts.footer) lines.push(opts.footer);
  return lines;
}

/** /memory 内容行：[标题, 记忆正文]。 */
export function buildMemoryLines(session: { formatMemory(): string }, header: string): string[] {
  return [header, session.formatMemory()];
}

/** /clear 回复（两端一致）。 */
export const CLEARED_TEXT = '对话历史已清空（记忆保留）。';

/** 「同类免问」状态查询文案；revokeHint 为通道自己的撤销方式说明（active=0 时忽略）。 */
export function confirmStateText(active: number, revokeHint: string): string {
  return active
    ? `当前有 ${active} 类写操作处于「同类免问」中；${revokeHint}。`
    : '当前没有生效中的「同类免问」（写操作逐次确认）。';
}

/** 「同类免问」撤销结果文案；noneText 为「没有可撤销」的通道文案。 */
export function confirmRevokedText(n: number, noneText: string): string {
  return n ? `已恢复逐次确认（撤销 ${n} 类「同类免问」授权）。` : noneText;
}

/** LLM 请求失败的三段回复：错误头 / 友好提示（可空）/ 原消息截断复述（60 字符）。 */
export function llmFailureParts(
  message: string,
  input: string,
  channel: 'cli' | 'bot',
): { head: string; friendly: string | null; tail: string } {
  const friendly = channel === 'bot' ? friendlyLlmError(message, { channel: 'bot' }) : friendlyLlmError(message);
  const quoted = `${input.slice(0, 60)}${input.length > 60 ? '…' : ''}`;
  const tail =
    channel === 'bot'
      ? `你的上一条消息未处理：「${quoted}」，可修改后重发。`
      : `上一条内容「${quoted}」未发送成功，可修改后重发；也可用 /config 检查模型配置。`;
  return { head: `请求失败: ${message}`, friendly, tail };
}
