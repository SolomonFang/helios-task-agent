// Unit tests: kanban 进程清理与 hk start 分支补全。真实 spawn 进程组 + 本地 mock 看板 API。Run: npx tsx scripts/unit-kanban.ts

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import { stopKanbanChild } from '../src/kanban/kanban-ensure';
import { fillHkStartBranches, type RepoStartInput } from '../src/kanban/workspace-ready';
import { check, checkAsync, finish } from './testkit';

/** 进程组是否还有存活成员（与 kanban-ensure.treeAlive 同判定）。 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.on('exit', () => r());
  });
}

/** 启动 mock 看板 API：GET /api/repos/:id 回 default_target_branch。返回 baseUrl 与请求计数。 */
async function mockKanban(branches: Record<string, string | null>): Promise<{
  baseUrl: string;
  requests: () => number;
  close: () => Promise<void>;
}> {
  let count = 0;
  const server = http.createServer((req, res) => {
    const m = (req.url || '').match(/^\/api\/repos\/([^/?]+)$/);
    if (m) {
      count++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { default_target_branch: branches[m[1]!] ?? null } }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests: () => count,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

async function main(): Promise<void> {
  // ---------- stopKanbanChild ----------
  await checkAsync('stopKanbanChild(null) 直接返回', async () => {
    await stopKanbanChild(null);
  });

  await checkAsync('stopKanbanChild：进程组整体已退出时不发信号也不抛错', async () => {
    const child = spawn('bash', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
    await waitExit(child);
    assert.ok(child.exitCode !== null);
    await stopKanbanChild(child); // 组内无活口：静默返回
  });

  await checkAsync('stopKanbanChild：壳进程已退出但进程组存活（exitCode 不短路），仍按组杀干净', async () => {
    // 模拟「npx 先死、看板孙进程被 reparent 后仍在组里」：bash 拉起 sleep 后自己退出
    const child = spawn('bash', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' });
    const pid = child.pid!;
    try {
      await waitExit(child);
      assert.ok(child.exitCode !== null, '壳进程应已退出（exitCode 非 null）');
      assert.ok(groupAlive(pid), '孙进程应仍在进程组里存活');
      await stopKanbanChild(child);
      assert.ok(!groupAlive(pid), '进程组应被清理（旧逻辑此处会留孤儿）');
    } finally {
      try {
        process.kill(-pid, 'SIGKILL'); // 兜底清理，防测试失败泄漏 sleep
      } catch {
        /* 已退出 */
      }
    }
  });

  // ---------- fillHkStartBranches：argv 形态 ----------
  await checkAsync('fillHkStartBranches argv：--repo 无 :branch 时回填默认分支', async () => {
    const mock = await mockKanban({ r1: 'hly-dev' });
    try {
      const argv = ['start', '--repo', 'r1'];
      const err = await fillHkStartBranches(argv, mock.baseUrl);
      assert.equal(err, null);
      assert.deepEqual(argv, ['start', '--repo', 'r1:hly-dev']);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('fillHkStartBranches argv：--repo 已带 :branch 时原样保留且不回填', async () => {
    const mock = await mockKanban({ r1: 'hly-dev' });
    try {
      const argv = ['start', '--repo', 'r1:dev'];
      const err = await fillHkStartBranches(argv, mock.baseUrl);
      assert.equal(err, null);
      assert.deepEqual(argv, ['start', '--repo', 'r1:dev']);
      assert.equal(mock.requests(), 0); // 没有待补全项，不应请求看板
    } finally {
      await mock.close();
    }
  });

  await checkAsync('fillHkStartBranches argv：混合形态只补未带 :branch 的 --repo', async () => {
    const mock = await mockKanban({ r2: 'hly-dev' });
    try {
      const argv = ['start', '--repo', 'r1:dev', '--repo', 'r2'];
      const err = await fillHkStartBranches(argv, mock.baseUrl);
      assert.equal(err, null);
      assert.deepEqual(argv, ['start', '--repo', 'r1:dev', '--repo', 'r2:hly-dev']);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('fillHkStartBranches argv：仓库无默认分支时返回 unresolved 错误', async () => {
    const mock = await mockKanban({}); // r1 未配置 default_target_branch
    try {
      const argv = ['start', '--repo', 'r1'];
      const err = await fillHkStartBranches(argv, mock.baseUrl);
      assert.ok(err && err.includes('无法启动 workspace') && err.includes('r1'), `实际：${err}`);
      assert.deepEqual(argv, ['start', '--repo', 'r1']); // 出错不改写 argv
    } finally {
      await mock.close();
    }
  });

  await checkAsync('fillHkStartBranches argv：无任何 --repo 时按 noRepoError 报错 / 未传则放行', async () => {
    const mock = await mockKanban({});
    try {
      const noRepoError = '无法启动 workspace：未指定 --branch / --repo ID:branch';
      const err = await fillHkStartBranches(['start'], mock.baseUrl, { noRepoError });
      assert.equal(err, noRepoError);
      const ok = await fillHkStartBranches(['start', '--branch', 'dev'], mock.baseUrl);
      assert.equal(ok, null);
      assert.equal(mock.requests(), 0);
    } finally {
      await mock.close();
    }
  });

  // ---------- fillHkStartBranches：repos 形态（MCP start_workspace_session） ----------
  await checkAsync('fillHkStartBranches repos：缺 base_branch 的回填，显式传入的保留', async () => {
    const mock = await mockKanban({ r1: 'hly-dev' });
    try {
      const repos: RepoStartInput[] = [{ repo_id: 'r1' }, { repo_id: 'r2', base_branch: 'feat' }];
      const err = await fillHkStartBranches(repos, mock.baseUrl);
      assert.equal(err, null);
      assert.deepEqual(repos, [
        { repo_id: 'r1', base_branch: 'hly-dev' },
        { repo_id: 'r2', base_branch: 'feat' },
      ]);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('fillHkStartBranches repos：无默认分支可回填时报错且不写回', async () => {
    const mock = await mockKanban({});
    try {
      const repos: RepoStartInput[] = [{ repo_id: 'r9' }];
      const err = await fillHkStartBranches(repos, mock.baseUrl);
      assert.ok(err && err.includes('r9'), `实际：${err}`);
      assert.deepEqual(repos, [{ repo_id: 'r9' }]);
    } finally {
      await mock.close();
    }
  });

  finish();
}

void main();
