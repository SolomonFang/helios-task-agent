import type { ToolHandler } from '../../types';
import { classifyHk, isDestructive, wrapUntrusted } from '../guard';
import { extractSourceUrls } from '../source-registry';
import {
  applyRepoBaseBranches,
  fetchRepoDefaultBranches,
  fillHkStartBranches,
  formatMissingBaseBranchError,
} from '../../kanban/workspace-ready';
import { extractUuid, resolveHkScript, run, summarizeBothEnds } from './shared';
import type { GatedWrite } from './gated-write';

/** 确认摘要的高频子命令中文动作（与 MCP 通道 summarizeMcp 口径对齐）；对象标识留在 detail 区。 */
const HK_ACTION_LABELS: Record<string, string> = {
  'tasks create': '创建看板任务',
  'tasks update': '更新看板任务',
  'tasks delete': '删除看板任务',
  'tasks cancel': '取消看板任务',
  'projects create': '创建看板项目',
  'projects update': '更新看板项目',
  start: '启动任务的工作区',
  'create-and-start': '创建看板任务并启动工作区',
  stop: '停止工作区',
  'follow-up': '向任务发送跟进消息',
  approve: '批准审批',
  deny: '拒绝审批',
};

function hkActionLabel(argv: string[]): string | undefined {
  return HK_ACTION_LABELS[`${argv[0] ?? ''} ${argv[1] ?? ''}`.trim()] ?? HK_ACTION_LABELS[argv[0] ?? ''];
}

/** hk tasks create [project_id] <title> — title = first non-flag arg that is not a UUID. */
function hkCreateTitle(args: string[]): string {
  const rest = args[0] === 'create-and-start' ? args.slice(1) : args.slice(2);
  // 遇 flag 跳过 flag 及其值继续找（--project X "标题"），不能在第一个 -- 处 break，否则取不到标题
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      if (!a.includes('=')) i++; // --flag value 形态成对跳过；--flag=value 只占一位
      continue;
    }
    if (/^[0-9a-fA-F-]{36}$/.test(a)) continue;
    return a;
  }
  return '';
}

function batchKeyForHk(argv: string[]): { key: string; scope: 'kind' | 'object' } {
  const cmd = argv[0] ?? '';
  // start/create-and-start 类级免问（同 batchKeyForMcp 的启动类）：启动不改写看板数据，
  // 批量启动多任务工作区是高频用法，对象级绑定只剩打扰
  if (cmd === 'start' || cmd === 'create-and-start') return { key: `hk:${cmd}`, scope: 'kind' };
  const sub = `${cmd} ${argv[1] ?? ''}`.trim();
  // 其余写操作对象级免问：任务/项目标识（UUID）纳入 key，仅对同一对象的同类操作生效。
  // stop/approve/follow-up 的对象 id 在 argv[1]，先看它，再回退 argv[2+]（tasks <sub> <id> 形态）；
  // 漏看 argv[1] 会把对象 id 的 key 错绑到后续参数（如 repo id）上
  const id = extractUuid(argv[1] ?? '') ?? argv.slice(2).map(extractUuid).find(Boolean);
  return id ? { key: `hk:${sub}:${id}`, scope: 'object' } : { key: `hk:${sub}`, scope: 'kind' };
}

function hkStartHasBranch(argv: string[]): boolean {
  if (argv.includes('--branch')) return true;
  return argv.some((a, i) => a === '--repo' && typeof argv[i + 1] === 'string' && String(argv[i + 1]).includes(':'));
}

/** hk_cli handler：读直接执行，写走 runGatedWrite（start 前置补全分支后再过闸门）。 */
export function makeHkCliHandler({
  kanbanUrl,
  kanbanProjectId,
  kanbanRepoId,
  kanbanIteration,
  runGatedWrite,
}: {
  kanbanUrl: string;
  kanbanProjectId?: string;
  kanbanRepoId?: string;
  kanbanIteration?: string;
  runGatedWrite: GatedWrite;
}): ToolHandler {
  const hkEnv: NodeJS.ProcessEnv = { HELIOS_KANBAN_URL: kanbanUrl };
  if (kanbanProjectId) hkEnv.HELIOS_KANBAN_PROJECT_ID = kanbanProjectId;
  if (kanbanRepoId) hkEnv.HELIOS_KANBAN_REPO_ID = kanbanRepoId;
  if (kanbanIteration) hkEnv.HELIOS_KANBAN_ITERATION = kanbanIteration;

  return async (raw, ctx) => {
    const args = raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return '参数错误：args 必须是字符串数组';
    }
    const argv = args as string[];
    if (classifyHk(argv) === 'read') {
      return wrapUntrusted(await run('bash', [resolveHkScript(), ...argv], { env: hkEnv, signal: ctx?.signal }));
    }
    const isCreate = argv[0] === 'create-and-start' || (argv[0] === 'tasks' && argv[1] === 'create');
    const isStart = argv[0] === 'start' || argv[0] === 'create-and-start';
    const title = isCreate ? hkCreateTitle(argv) : '';
    // 高频子命令摘要用中文动作（对象标识在 detail）；未覆盖的子命令回退原命令行形态
    const summary = isCreate
      ? `创建看板任务${title ? `「${title}」` : ''}`
      : hkActionLabel(argv) ?? `看板写操作：${argv.slice(0, 3).join(' ')}`;
    // start 分支补全会改写 argv，detail 取 getter 在闸门/审计时按最终命令重算（确认卡片须展示实际执行的命令）
    const { key: batchKey, scope: batchScope } = batchKeyForHk(argv);
    return runGatedWrite({
      kind: 'hk',
      summary,
      detail: () => summarizeBothEnds(`hk ${argv.join(' ')}`),
      isCreate,
      isStart,
      urls: isCreate ? extractSourceUrls(argv.join(' ')) : [],
      title,
      batchKey,
      batchScope,
      destructive: isDestructive(`${argv[0] ?? ''} ${argv[1] ?? ''}`),
      prepare: isStart
        ? async () => {
            if (!hkStartHasBranch(argv)) {
              // Prefer env default repo's configured branch; otherwise require explicit --branch.
              const repoId = kanbanRepoId || '';
              if (repoId) {
                const defaults = await fetchRepoDefaultBranches(kanbanUrl, [repoId], ctx?.signal);
                const { unresolved } = applyRepoBaseBranches([{ repo_id: repoId }], defaults);
                if (unresolved.length) return formatMissingBaseBranchError(unresolved);
                const branch = defaults[repoId];
                if (branch) argv.push('--branch', branch);
              } else {
                // 显式 --repo id（无 :branch）也要先解析默认分支再补全，否则 hk.sh 静默回退 main
                return await fillHkStartBranches(argv, kanbanUrl, {
                  signal: ctx?.signal,
                  noRepoError:
                    '无法启动工作区：未指定 --branch / --repo ID:branch，且未配置默认仓库。\n' +
                    '请显式传入目标分支（如 --branch develop），避免静默回退到不存在的 main。',
                });
              }
            } else if (!argv.includes('--branch')) {
              // 混合形态：部分 --repo 已带 :branch，其余未带的也要补默认分支，不能静默回退 main
              return await fillHkStartBranches(argv, kanbanUrl, { signal: ctx?.signal });
            }
            return null;
          }
        : undefined,
      execute: () => run('bash', [resolveHkScript(), ...argv], { env: hkEnv, signal: ctx?.signal }),
      signal: ctx?.signal,
    });
  };
}
