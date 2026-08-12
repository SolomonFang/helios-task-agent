import type { ToolHandler } from '../../types';
import { wrapUntrusted } from '../guard';
import { auditLog } from '../../infra/audit';
import { runRepoFs } from '../repo-fs';

/** repo_fs handler：只读浏览仓库代码；读审计记 action/路径，不记读回内容。 */
export function makeRepoFsHandler({
  uid,
  kanbanUrl,
  auditHome,
}: {
  uid: string;
  kanbanUrl: string;
  auditHome?: string;
}): ToolHandler {
  return async (raw) => {
    const action = typeof raw.action === 'string' ? raw.action : '';
    const relPath = typeof raw.path === 'string' ? raw.path : '.';
    // 仓库代码属外部内容（可能含注释型注入）：UNTRUSTED 包裹
    const { out, denied } = await runRepoFs(kanbanUrl, {
      action,
      root: typeof raw.root === 'string' ? raw.root : undefined,
      repo_id: typeof raw.repo_id === 'string' ? raw.repo_id : undefined,
      path: typeof raw.path === 'string' ? raw.path : undefined,
      pattern: typeof raw.pattern === 'string' ? raw.pattern : undefined,
      glob: typeof raw.glob === 'string' ? raw.glob : undefined,
    });
    // 读审计：仓库代码外发 LLM 留痕；只记 action/目标路径，不记读回内容。
    // 被敏感文件 denylist / 仓库白名单拒绝的尝试最值得记（探测行为的信号），记 decision: 'denied'。
    // denied 取 runRepoFs 的结构化字段：仓库文件内容可能恰好含拒绝文案，字符串反向解析会误判
    auditLog(
      {
        user: uid,
        kind: 'repo_fs_read',
        summary: `仓库读操作：repo_fs ${action || '?'} ${relPath}`,
        detail:
          `repo_fs(${JSON.stringify({
            action,
            root: raw.root,
            repo_id: raw.repo_id,
            path: raw.path,
            pattern: raw.pattern,
            glob: raw.glob,
          })})`.slice(0, 800),
        decision: denied ? 'denied' : 'approved',
        ok: !denied,
      },
      auditHome,
    );
    return wrapUntrusted(out);
  };
}
