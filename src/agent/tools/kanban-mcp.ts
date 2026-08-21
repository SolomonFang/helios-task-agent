import type { KanbanMcp } from '../../kanban/mcp';
import type { ToolHandler } from '../../types';
import { classifyMcp, isDestructive, summarizeMcp, wrapUntrusted } from '../guard';
import { extractSourceUrls } from '../source-registry';
import { fillHkStartBranches, type RepoStartInput } from '../../kanban/workspace-ready';
import { errMessage } from '../../infra/err';
import { summarizeBothEnds } from './shared';
import type { GatedWrite } from './gated-write';

/** 确认卡片展示的优先级中文映射（看板内部值为英文枚举）。 */
const PRIORITY_LABELS: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' };

/** 闸门卡片 detail：create 类结构化展示（标题/项目/描述预览），其余保持命令行原文。 */
function formatMcpDetail(toolName: string, args: Record<string, unknown>): string {
  if (!/create/i.test(toolName)) return summarizeBothEnds(`kanban_${toolName}(${JSON.stringify(args)})`);
  const title = typeof args.title === 'string' ? args.title : '';
  const desc = typeof args.description === 'string' ? args.description : '';
  const project = String(args.project_id ?? args.projectId ?? '');
  const priorityLabel = typeof args.priority === 'string' ? PRIORITY_LABELS[args.priority] : undefined;
  const preview = desc ? `描述预览：\n${summarizeBothEnds(desc, 200, 100)}` : '';
  return [
    `标题：${title}`,
    project ? `项目 ID：${project}` : '',
    // 未命中中文映射时省略该行，不把英文枚举透传到确认卡片
    priorityLabel ? `优先级：${priorityLabel}` : '',
    preview,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 「同类免问」key 与粒度：
 * - 启动类（start_workspace*）：类级 key——启动工作区不改写看板数据，且「批量启动
 *   多个任务的工作区」是高频用法，对象级绑定只剩打扰、没有安全收益；
 * - 其余写操作：对象级 key（task/工作区/审批 id 纳入 key，与 summarizeMcp 的对象标识
 *   口径对齐），免问仅对同一对象的同类操作生效——否则 approve、delete 这类会退化成
 *   类级免问（借一次授权放行任意对象）。
 */
function batchKeyForMcp(name: string, args: Record<string, unknown>): { key: string; scope: 'kind' | 'object' } {
  if (/start/i.test(name)) return { key: `kanban:${name}`, scope: 'kind' };
  const id = String(args.task_id ?? args.taskId ?? args.id ?? args.workspace_id ?? args.approval_id ?? '');
  return id ? { key: `kanban:${name}:${id}`, scope: 'object' } : { key: `kanban:${name}`, scope: 'kind' };
}

function parseMcpStartRepos(args: Record<string, unknown>): RepoStartInput[] | null {
  if (!Array.isArray(args.repos)) return null;
  const out: RepoStartInput[] = [];
  for (const item of args.repos) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.repo_id !== 'string' || !row.repo_id) continue;
    out.push({
      repo_id: row.repo_id,
      base_branch: typeof row.base_branch === 'string' ? row.base_branch : undefined,
    });
  }
  return out.length ? out : null;
}

/** Ensure start repos have base_branch; mutates args.repos when filled from defaults. */
async function prepareMcpStartArgs(
  args: Record<string, unknown>,
  kanbanUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const repos = parseMcpStartRepos(args);
  if (!repos) return null;
  const error = await fillHkStartBranches(repos, kanbanUrl, { signal });
  if (error) return error;
  args.repos = repos;
  return null;
}

/** kanban_<tool> 动态工具 handler：读直接调用，写与 hk_cli 共用 runGatedWrite 流水线。 */
export function makeKanbanMcpHandler({
  mcp,
  tool,
  kanbanUrl,
  runGatedWrite,
}: {
  mcp: KanbanMcp;
  tool: KanbanMcp['tools'][number];
  kanbanUrl: string;
  runGatedWrite: GatedWrite;
}): ToolHandler {
  return async (args, ctx) => {
    if (classifyMcp(tool.name) === 'read') {
      try {
        // 看板内容（标题/描述等）可被任何能写看板的人控制：UNTRUSTED 包裹，其中「指令」无效
        return wrapUntrusted(await mcp.callTool(tool.name, args, ctx?.signal));
      } catch (err) {
        const message = errMessage(err);
        // 错误文本同样来自 MCP server（可被写看板的人控制）：与成功路径一样 UNTRUSTED 包裹
        return wrapUntrusted(`看板工具 ${tool.name} 调用失败：${message}`);
      }
    }
    // write path: 与 hk_cli 共用 runGatedWrite（去重 → 上限 → 闸门 → 执行 → 审计 → 记录来源）
    const summary = summarizeMcp(tool.name, args);
    const isCreate = /create/i.test(tool.name);
    const isStart = /start_workspace/i.test(tool.name);
    const { key: batchKey, scope: batchScope } = batchKeyForMcp(tool.name, args);
    return runGatedWrite({
      kind: 'kanban',
      summary,
      // start 前置补全会原地改写 args.repos（补 base_branch），detail 取 getter 在闸门/审计时
      // 按最终参数重算（确认卡片须展示实际执行的参数，同 hk 路径，见 makeHkCliHandler）
      detail: () => formatMcpDetail(tool.name, args),
      isCreate,
      isStart,
      urls: isCreate ? extractSourceUrls(JSON.stringify(args)) : [],
      title: typeof args.title === 'string' ? args.title : '',
      batchKey,
      batchScope,
      destructive: isDestructive(tool.name),
      prepare: isStart ? () => prepareMcpStartArgs(args, kanbanUrl, ctx?.signal) : undefined,
      execute: async () => {
        try {
          return await mcp.callTool(tool.name, args, ctx?.signal);
        } catch (err) {
          const message = errMessage(err);
          return `看板工具 ${tool.name} 调用失败：${message}`;
        }
      },
      signal: ctx?.signal,
    });
  };
}
