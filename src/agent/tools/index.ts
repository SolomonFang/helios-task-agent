import type { KanbanMcp } from '../../kanban/mcp';
import type { MemoryStore } from '../memory';
import type { OpenAiTool, ToolHandlers } from '../../types';
import type { ConfirmFn } from '../guard';
import { SourceRegistry } from '../source-registry';
import { LOCAL_TOOLS, MEMORY_TOOLS } from './defs';
import { makeGatedWriter, type CreateCounter } from './gated-write';
import { makeKanbanMcpHandler } from './kanban-mcp';
import { makeLarkCliHandler } from './lark-cli';
import { makeHkCliHandler } from './hk-cli';
import { makeRepoFsHandler } from './repo-fs';
import { makeSkillDocHandler, makeSkillExecHandler } from './skill-tools';
import { makeWorkSummaryHandler } from './work-summary';
import { makeDailyReportHandler } from './personal-daily';
import { makeIterationRetroHandler } from './iteration-retro';
import { makeMemoryHandlers } from './memory-tools';
import { makeReminderHandlers } from './reminder-tools';
import { REMINDER_TOOLS } from './defs';
import type { ReminderStore } from '../reminder';

export { summarizeBothEnds } from './shared';
export { LOCAL_TOOL_SUMMARY, localToolSummary } from './defs';
export type { CreateCounter } from './gated-write';

/** OpenAI function name 约束（长度含 kanban_ 前缀后计算）：非法名会让整个 tools 数组被 API 400 拒绝。 */
const OPENAI_FN_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const EMPTY_SCHEMA: OpenAiTool['function']['parameters'] = { type: 'object', properties: {} };

/**
 * 外部 MCP server 的 inputSchema 零信任：只接受 type==='object' 且 properties（如有）
 * 为 plain object 的形态；畸形时退化为空 schema 并 warn（schema 原样透传给 LLM API，
 * 畸形值可能让整个 tools 数组被 400 拒绝）。
 */
function sanitizeMcpInputSchema(toolName: string, schema: unknown): OpenAiTool['function']['parameters'] {
  const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const malformed = !isPlainObject(schema) || schema.type !== 'object' || (schema.properties !== undefined && !isPlainObject(schema.properties));
  if (malformed) {
    console.warn(`[tools] MCP 工具「${toolName}」的 inputSchema 形态非法（须为 type:object 的 JSON Schema），已按空 schema 注册`);
    return EMPTY_SCHEMA;
  }
  return schema as OpenAiTool['function']['parameters'];
}

export function buildTools({
  mcp,
  kanbanUrl,
  kanbanProjectId,
  kanbanRepoId,
  kanbanIteration,
  memory,
  reminders,
  userId,
  onMemoryChange,
  confirm,
  registry,
  auditHome,
  reportLinkBaseUrl,
  channel,
  createCounter,
}: {
  mcp: KanbanMcp | null;
  kanbanUrl: string;
  kanbanProjectId?: string;
  kanbanRepoId?: string;
  kanbanIteration?: string;
  memory?: MemoryStore | null;
  /** 提醒存储：传入则注册 reminder_* 工具（两形态会话恒传）。 */
  reminders?: ReminderStore | null;
  userId?: string;
  /** Called after any successful memory write so session can refresh system prompt. */
  onMemoryChange?: () => void;
  /** Write gate: every write op waits for explicit user approval. Omit → writes blocked. */
  confirm?: ConfirmFn;
  /** Dedupe store for「飞书来源 → 看板任务」；defaults to <home>/synced-sources.json. */
  registry?: SourceRegistry;
  /** Override audit log home (tests). */
  auditHome?: string;
  /** bot 场景传入报告静态服务基地址：work_summary 报告改推 HTTP 链接（CLI 不传，保留本机路径）。 */
  reportLinkBaseUrl?: string;
  /** 会话形态：bot 场景报告服务不可用时省略本机路径行（死链+目录泄露）；缺省按 CLI。 */
  channel?: 'cli' | 'bot';
  /** 会话级创建计数（缺省每次 buildTools 新建；AgentSession 传入以跨工具闭包重建存活）。 */
  createCounter?: CreateCounter;
}): { openAiTools: OpenAiTool[]; handlers: ToolHandlers } {
  const openAiTools: OpenAiTool[] = [];
  const handlers: ToolHandlers = new Map();
  const uid = userId || 'local';
  const reg = registry || new SourceRegistry();
  const runGatedWrite = makeGatedWriter({
    uid,
    registry: reg,
    kanbanUrl,
    confirm,
    auditHome,
    createCounter: createCounter || { count: 0 },
  });

  if (mcp && mcp.connected) {
    for (const tool of mcp.tools) {
      const name = `kanban_${tool.name}`;
      if (!OPENAI_FN_NAME.test(name)) {
        // MCP server 返回非法名：注册会让整个 tools 数组被 API 400 拒绝（全工具不可用），跳过并告警；
        // 正则细节收 HTA_DEBUG（用户面不出现正则原文）
        console.warn(`[tools] 跳过非法 MCP 工具名「${name}」（名称含非法字符或过长）`);
        if (process.env.HTA_DEBUG) console.error(`[tools] 非法工具名「${name}」：须匹配 ${OPENAI_FN_NAME.source}`);
        continue;
      }
      openAiTools.push({
        type: 'function',
        function: {
          name,
          description: `[helios-kanban MCP] ${tool.description || tool.name}`,
          parameters: sanitizeMcpInputSchema(name, tool.inputSchema ?? EMPTY_SCHEMA),
        },
      });
      handlers.set(name, makeKanbanMcpHandler({ mcp, tool, kanbanUrl, runGatedWrite }));
    }
  }

  handlers.set('lark_cli', makeLarkCliHandler({ uid, confirm, auditHome }));
  handlers.set(
    'hk_cli',
    makeHkCliHandler({ kanbanUrl, kanbanProjectId, kanbanRepoId, kanbanIteration, runGatedWrite }),
  );
  handlers.set('repo_fs', makeRepoFsHandler({ uid, kanbanUrl, auditHome }));
  handlers.set('skill_doc', makeSkillDocHandler());
  handlers.set('skill_exec', makeSkillExecHandler({ uid, confirm, auditHome }));
  handlers.set(
    'work_summary',
    makeWorkSummaryHandler({ kanbanUrl, kanbanProjectId, kanbanIteration, reportLinkBaseUrl }),
  );
  handlers.set(
    'daily_report',
    makeDailyReportHandler({ kanbanUrl, kanbanProjectId, kanbanIteration, reportLinkBaseUrl, channel }),
  );
  handlers.set(
    'iteration_retro',
    makeIterationRetroHandler({ kanbanUrl, kanbanProjectId, kanbanIteration, reportLinkBaseUrl, channel }),
  );

  if (memory) {
    for (const [name, handler] of makeMemoryHandlers({ uid, memory, confirm, auditHome, onMemoryChange })) {
      handlers.set(name, handler);
    }
    openAiTools.push(...MEMORY_TOOLS);
  }

  if (reminders) {
    for (const [name, handler] of makeReminderHandlers({ uid, reminders, confirm, auditHome })) {
      handlers.set(name, handler);
    }
    openAiTools.push(...REMINDER_TOOLS);
  }

  openAiTools.push(...LOCAL_TOOLS);
  return { openAiTools, handlers };
}
