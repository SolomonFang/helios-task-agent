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

/** hk tasks create [project_id] <title> — title = first non-flag arg that is not a UUID. */
function hkCreateTitle(args: string[]): string {
  const rest = args[0] === 'create-and-start' ? args.slice(1) : args.slice(2);
  for (const a of rest) {
    if (a.startsWith('--')) break;
    if (/^[0-9a-fA-F-]{36}$/.test(a)) continue;
    return a;
  }
  return '';
}

function batchKeyForHk(argv: string[]): string {
  const sub = `${argv[0] ?? ''} ${argv[1] ?? ''}`.trim();
  // 同 batchKeyForMcp：任务/项目标识（UUID）纳入 key，免问仅对同一对象的同类操作生效
  const id = argv.slice(2).map(extractUuid).find(Boolean);
  return id ? `hk:${sub}:${id}` : `hk:${sub}`;
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
    const summary = isCreate ? `创建看板任务「${title}」` : `看板写操作：hk ${argv.slice(0, 3).join(' ')}`;
    // start 分支补全会改写 argv，detail 取 getter 在闸门/审计时按最终命令重算（确认卡片须展示实际执行的命令）
    return runGatedWrite({
      kind: 'hk',
      summary,
      detail: () => summarizeBothEnds(`hk ${argv.join(' ')}`),
      isCreate,
      isStart,
      urls: isCreate ? extractSourceUrls(argv.join(' ')) : [],
      title,
      batchKey: batchKeyForHk(argv),
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
                    '无法启动 workspace：未指定 --branch / --repo ID:branch，且未配置 HELIOS_KANBAN_REPO_ID。\n' +
                    '请显式传入目标分支（如 --branch hly-dev），避免静默回退到不存在的 main。',
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
