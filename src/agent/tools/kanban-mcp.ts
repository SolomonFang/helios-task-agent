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

/** 确认卡片展示的任务类型中文映射（看板内部值为 conventional commit 英文前缀）。 */
const TASK_TYPE_LABELS: Record<string, string> = {
  feat: '功能',
  fix: '修复',
  docs: '文档',
  refactor: '重构',
  perf: '性能',
  test: '测试',
  chore: '杂务',
};

/** 高频参数键的中文展示名（确认卡片面向用户，不落蛇形内部名；未收录的键原样展示）。 */
const ARG_KEY_LABELS: Record<string, string> = {
  task_id: '任务 ID',
  taskId: '任务 ID',
  workspace_id: '工作区 ID',
  approval_id: '审批 ID',
  project_id: '项目 ID',
  projectId: '项目 ID',
  title: '标题',
  description: '描述',
  priority: '优先级',
  task_type: '类型',
  status: '状态',
  message: '消息内容',
  reason: '原因',
  repos: '仓库',
};

/** 单个参数值的中文展示：枚举映射中文，repos 数组展开为「仓库 ID（分支：…）」。 */
function formatMcpArgValue(key: string, value: unknown): string {
  if (key === 'priority' && typeof value === 'string') return PRIORITY_LABELS[value] ?? value;
  if (key === 'task_type' && typeof value === 'string') return TASK_TYPE_LABELS[value] ?? value;
  if (key === 'repos' && Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item || typeof item !== 'object') return String(item);
        const row = item as Record<string, unknown>;
        const branch = typeof row.base_branch === 'string' ? `（分支：${row.base_branch}）` : '';
        return `${String(row.repo_id ?? '?')}${branch}`;
      })
      .join('、');
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 闸门卡片 detail：结构化中文展示（操作名 + 逐参数中文键），不落蛇形工具名与 JSON 伪调用串。 */
function formatMcpDetail(toolName: string, args: Record<string, unknown>): string {
  if (!/create/i.test(toolName)) {
    const lines = [`操作：${summarizeMcp(toolName, args)}`];
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null || value === '') continue;
      const label = ARG_KEY_LABELS[key] ?? key;
      lines.push(`${label}：${summarizeBothEnds(formatMcpArgValue(key, value), 200, 100)}`);
    }
    return lines.join('\n');
  }
  const title = typeof args.title === 'string' ? args.title : '';
  // create_project 的名称在 args.name（无 title 字段）
  const name = typeof args.name === 'string' ? args.name : '';
  const desc = typeof args.description === 'string' ? args.description : '';
  const project = String(args.project_id ?? args.projectId ?? '');
  const priorityLabel = typeof args.priority === 'string' ? PRIORITY_LABELS[args.priority] : undefined;
  const taskType = typeof args.task_type === 'string' ? args.task_type : '';
  const taskTypeLabel = taskType ? TASK_TYPE_LABELS[taskType] : undefined;
  const preview = desc ? `描述预览：\n${summarizeBothEnds(desc, 200, 100)}` : '';
  return [
    // 空标题省略整行，不渲染裸「标题：」
    title ? `标题：${title}` : '',
    name ? `名称：${name}` : '',
    project ? `项目 ID：${project}` : '',
    // 未命中中文映射时省略该行，不把英文枚举透传到确认卡片
    priorityLabel ? `优先级：${priorityLabel}` : '',
    taskTypeLabel ? `类型：${taskTypeLabel}` : '',
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
 *   类级免问（借一次授权放行任意对象）；
 * - 创建类（create_*）：类级 key——天然无既有对象可绑，与 hk 通道创建口径一致；
 * - 其余写操作缺可识别对象 id：fail-closed 不提供免问（key 退化为类级等于静默放行整类）。
 */
function batchKeyForMcp(name: string, args: Record<string, unknown>): { key?: string; scope: 'kind' | 'object' } {
  if (/start/i.test(name)) return { key: `kanban:${name}`, scope: 'kind' };
  const id = String(args.task_id ?? args.taskId ?? args.id ?? args.workspace_id ?? args.approval_id ?? '');
  if (id) return { key: `kanban:${name}:${id}`, scope: 'object' };
  // 创建类天然无既有对象可绑：类级 key（与 hk 通道 'hk:tasks create' 口径一致，批量建任务不逐次弹窗）
  if (/create/i.test(name)) return { key: `kanban:${name}`, scope: 'kind' };
  console.warn(`[kanban] 写工具 ${name} 缺少可识别对象 id 参数，本次不提供「同类免问」（每次均需确认）`);
  return { key: undefined, scope: 'kind' };
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

/**
 * MCP 调用失败的用户面文案：英文蛇形工具名与 server 英文原文不进用户面。
 * 动作复用 guard.summarizeMcp 的中文摘要（与确认卡片口径一致）；server 原文含中文才保留，
 * 否则给通用中文定性并指出路，原文一律进 HTA_DEBUG 日志。
 * 文案以「调用失败：」行首起：looksLikeStrongFailure（guard.ts）按行首识别强失败，
 * 写路径的审计 ok / 来源映射 / 创建计数都依赖该判定。
 */
function mcpFailureText(toolName: string, args: Record<string, unknown>, err: unknown): string {
  const message = errMessage(err);
  if (process.env.HTA_DEBUG) console.error(`[kanban] 工具 ${toolName} 报错原文：${message}`);
  const action = summarizeMcp(toolName, args);
  const label = action === '看板写操作' ? '看板操作' : action;
  let reason: string;
  if (/[一-龥]/.test(message)) {
    reason = message;
  } else if (/not found|does not exist/i.test(message)) {
    // 确定性失败（任务不存在）重试必败，不带「稍后重试」
    reason = '看板拒绝了该操作，请核对任务是否存在、参数是否正确后重新发起';
  } else if (/invalid|unauthorized|forbidden|credential|token|auth/i.test(message)) {
    // 「invalid」收窄到本档：凭证失效类（invalid token/credentials 等）不能误诊为
    // 「核对任务是否存在」——重试与联系部署者才是出路
    reason = '看板拒绝了该操作，请重新发起；持续失败请联系部署者';
  } else {
    // 连接类失败：CLI 无重连机制，看板正常但仍失败时重启本程序才能恢复连接
    reason = '看板服务暂时无响应，请稍后重试；若看板服务正常但仍失败，请重启本程序恢复连接；持续失败请联系部署者';
  }
  return `调用失败：${label}（${reason}）`;
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
        // 错误文本同样来自 MCP server（可被写看板的人控制）：与成功路径一样 UNTRUSTED 包裹
        return wrapUntrusted(mcpFailureText(tool.name, args, err));
      }
    }
    // write path: 与 hk_cli 共用 runGatedWrite（去重 → 上限 → 闸门 → 执行 → 审计 → 记录来源）
    const summary = summarizeMcp(tool.name, args);
    // 创建上限只计任务创建（撞线文案为「看板任务」，与 hk 通道只认 tasks create / create-and-start
    // 口径对齐）：create_project 不计入，避免「项目创建」消耗任务配额且文案失实
    const isCreate = /create/i.test(tool.name) && !/project/i.test(tool.name);
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
      // 查重粒度 (来源 URL, 项目)：同来源拆到多项目时按 project_id 区分（口径同 formatMcpDetail）
      projectId: String(args.project_id ?? args.projectId ?? '') || undefined,
      batchKey,
      batchScope,
      destructive: isDestructive(tool.name),
      prepare: isStart ? () => prepareMcpStartArgs(args, kanbanUrl, ctx?.signal) : undefined,
      execute: async () => {
        try {
          return await mcp.callTool(tool.name, args, ctx?.signal);
        } catch (err) {
          return mcpFailureText(tool.name, args, err);
        }
      },
      signal: ctx?.signal,
    });
  };
}
