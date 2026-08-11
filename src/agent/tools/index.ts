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
import { makeMemoryHandlers } from './memory-tools';

export { summarizeBothEnds } from './shared';
export { LOCAL_TOOL_SUMMARY } from './defs';
export type { CreateCounter } from './gated-write';

export function buildTools({
  mcp,
  kanbanUrl,
  kanbanProjectId,
  kanbanRepoId,
  kanbanIteration,
  memory,
  userId,
  onMemoryChange,
  confirm,
  registry,
  auditHome,
  reportLinkBaseUrl,
  createCounter,
}: {
  mcp: KanbanMcp | null;
  kanbanUrl: string;
  kanbanProjectId?: string;
  kanbanRepoId?: string;
  kanbanIteration?: string;
  memory?: MemoryStore | null;
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
      openAiTools.push({
        type: 'function',
        function: {
          name,
          description: `[helios-kanban MCP] ${tool.description || tool.name}`,
          parameters: (tool.inputSchema as OpenAiTool['function']['parameters']) || {
            type: 'object',
            properties: {},
          },
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

  if (memory) {
    for (const [name, handler] of makeMemoryHandlers({ uid, memory, confirm, auditHome, onMemoryChange })) {
      handlers.set(name, handler);
    }
    openAiTools.push(...MEMORY_TOOLS);
  }

  openAiTools.push(...LOCAL_TOOLS);
  return { openAiTools, handlers };
}
