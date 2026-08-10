// Unit tests: kanban 进程清理与 hk start 分支补全。真实 spawn 进程组 + 本地 mock 看板 API。Run: npx tsx scripts/unit-kanban.ts

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import { stopKanbanChild } from '../src/kanban/kanban-ensure';
import { fillHkStartBranches, type RepoStartInput } from '../src/kanban/workspace-ready';
import { apiGet, fetchKanbanHealth, taskPageUrl } from '../src/kanban/http';
import { checkAsync, finish } from './testkit';

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
    const started = Date.now();
    const ret = await stopKanbanChild(null);
    assert.equal(ret, undefined);
    // 真实停止路径含 SIGTERM 后 500ms 等待窗；null 必须早返回，不进该窗口
    assert.ok(Date.now() - started < 500, 'null 子进程应早返回，不进入 SIGTERM 等待窗口');
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
      assert.ok(err && err.includes('无法启动工作区') && err.includes('r1'), `实际：${err}`);
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

  // ---------- hk.sh ↔ src/kanban/http.ts 契约一致性（漂移防护） ----------
  // 两套看板客户端（TS 侧 http.ts 与技能内 bash hk.sh）各自实现信封解析、任务详情 URL、
  // 健康端点。这里用 loopback mock 看板 + 真实子进程跑 hk.sh 只读路径，断言两侧语义一致；
  // 全程离线。注意一个已知且刻意的差异不在断言内：无 success 字段时 TS 侧宽松回退
  // （data ?? 原始 JSON），hk.sh 严格报错——契约只钉双方共识的严格信封形态。

  const HK_SH = path.join(__dirname, '..', 'skills', 'helios-kanban-remote', 'scripts', 'hk.sh');

  interface HkResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  /** 以真实子进程跑 hk.sh 只读命令（bash + jq + curl，打 loopback mock，不触网）。 */
  function runHk(args: string[], kanbanUrl: string): Promise<HkResult> {
    return new Promise((resolve) => {
      execFile('bash', [HK_SH, ...args], { env: { ...process.env, HELIOS_KANBAN_URL: kanbanUrl } }, (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  /** 通用 mock 看板：handler 返回信封 data（或完整自定义响应）；paths 记录请求路径。 */
  async function contractMock(handler: (url: string, method: string) => { status?: number; body: unknown }): Promise<{
    baseUrl: string;
    paths: () => string[];
    close: () => Promise<void>;
  }> {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      seen.push(`${req.method} ${url}`);
      const r = handler(url, req.method || 'GET');
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      baseUrl,
      paths: () => seen,
      close: async () => {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
      },
    };
  }

  await checkAsync('契约：信封成功路径一致——hk.sh 与 apiGet 提取同一份 data', async () => {
    const info = { version: '9.9.9', config: { executor_profile: { executor: 'KIMI_CLI' } } };
    const mock = await contractMock(() => ({ body: { success: true, data: info } }));
    try {
      const hk = await runHk(['info'], mock.baseUrl);
      assert.equal(hk.code, 0, `hk info 应成功，stderr：${hk.stderr}`);
      const tsData = await apiGet(mock.baseUrl, '/info');
      assert.deepEqual(JSON.parse(hk.stdout), tsData);
      assert.deepEqual(tsData, info);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('契约：信封失败路径一致——success:false 时两侧都以 message 报错', async () => {
    const mock = await contractMock(() => ({ body: { success: false, message: 'boom-msg-contract' } }));
    try {
      const hk = await runHk(['info'], mock.baseUrl);
      assert.notEqual(hk.code, 0, 'hk.sh 应非零退出');
      assert.ok(hk.stderr.includes('boom-msg-contract'), `hk.sh stderr 应含 message，实际：${hk.stderr}`);
      await assert.rejects(apiGet(mock.baseUrl, '/info'), /boom-msg-contract/);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('契约：健康端点路径一致——两侧都打 /api/health', async () => {
    const mock = await contractMock(() => ({ body: { success: true, data: { status: 'ok' } } }));
    try {
      const hk = await runHk(['health'], mock.baseUrl);
      assert.equal(hk.code, 0, `hk health 应成功，stderr：${hk.stderr}`);
      assert.deepEqual(mock.paths(), ['GET /api/health']);
      assert.equal(await fetchKanbanHealth(mock.baseUrl), 'ok');
      assert.deepEqual(mock.paths(), ['GET /api/health', 'GET /api/health']);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('契约：任务详情 URL 规则一致——/local-projects/<pid>/tasks/<tid>', async () => {
    const tid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const mock = await contractMock((url) => {
      if (url === `/api/tasks/${tid}`) {
        return { body: { success: true, data: { id: tid, project_id: 'p1', title: '契约任务', status: 'todo' } } };
      }
      if (url === `/api/task-attempts?task_id=${tid}`) return { body: { success: true, data: [] } };
      if (url === '/api/task-attempts/summary') return { body: { success: true, data: { summaries: [] } } };
      if (url === '/api/tasks?project_id=p1') {
        return { body: { success: true, data: [{ id: tid, title: '契约任务', status: 'todo' }] } };
      }
      return { status: 404, body: {} };
    });
    try {
      const hk = await runHk(['status', tid], mock.baseUrl);
      assert.equal(hk.code, 0, `hk status 应成功，stderr：${hk.stderr}`);
      const out = JSON.parse(hk.stdout) as { url?: string };
      assert.equal(out.url, taskPageUrl(mock.baseUrl, 'p1', tid));
      assert.equal(out.url, `${mock.baseUrl}/local-projects/p1/tasks/${tid}`);
    } finally {
      await mock.close();
    }
  });

  finish();
}

void main();
