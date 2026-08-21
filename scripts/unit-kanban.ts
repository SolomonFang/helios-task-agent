// Unit tests: kanban 进程清理、拉起轮询竞态、http 层错误分类、ai-review 返回体校验与 hk start 分支补全、
// 依赖探测/ocr 探测最小环境、combinedSignal 监听器释放、MCP connect settled 护栏、workspace-ready 瞬时错误分类。
// 真实 spawn 进程组 + 本地 mock 看板 API。Run: npx tsx scripts/unit-kanban.ts

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { ensureKanbanRunning, stopKanbanChild } from '../src/kanban/kanban-ensure';
import {
  classifyWorkspaceSetup,
  fetchWorkspaceSnapshot,
  fillHkStartBranches,
  waitForWorkspaceReady,
  type RepoStartInput,
} from '../src/kanban/workspace-ready';
import { apiGet, fetchKanbanHealth, KanbanHttpError, taskPageUrl } from '../src/kanban/http';
import { findOcrCommand, resolveReviewTarget } from '../src/kanban/ai-review';
import { KanbanMcp } from '../src/kanban/mcp';
import { checkLarkCli, checkLarkCliAsync } from '../src/infra/deps';
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

  // hk.sh 契约用例以真实子进程跑 bash 脚本，依赖 bash/jq/curl：缺失属环境问题而非产品缺陷，
  // 按 SKIP 处理（同 unit.ts 的 jq 探测 / smoke.ts 的 SKIP 惯例），避免干净 CI 上误红；
  // HTA_REQUIRE_E2E=1 时转 FAIL，防止「全绿」掩盖契约用例未真跑
  const hkDepsMissing = ['bash', 'jq', 'curl'].filter((cmd) => {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' });
      return false;
    } catch {
      return true;
    }
  });
  const runHkContract = (name: string, fn: () => Promise<void>): Promise<void> | void => {
    if (!hkDepsMissing.length) return checkAsync(name, fn);
    const detail = `本机缺少 ${hkDepsMissing.join('、')}（hk.sh 运行时依赖）`;
    if (process.env.HTA_REQUIRE_E2E === '1') check(name, false, `HTA_REQUIRE_E2E=1 禁止跳过：${detail}`);
    else console.log(`SKIP  ${name}  — ${detail}`);
  };

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

  await runHkContract('契约：信封成功路径一致——hk.sh 与 apiGet 提取同一份 data', async () => {
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

  await runHkContract('契约：信封失败路径一致——success:false 时两侧都以 message 报错', async () => {
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

  await runHkContract('契约：健康端点路径一致——两侧都打 /api/health', async () => {
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

  await runHkContract('契约：任务详情 URL 规则一致——/local-projects/<pid>/tasks/<tid>', async () => {
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

  // ---------- ensureKanbanRunning：拉起轮询竞态（先探健康再判退出码） ----------
  await checkAsync('ensureKanbanRunning：npx 壳先退出但看板已就绪时不误报失败', async () => {
    // 模拟 detached npx 壳退出与看板就绪几乎同时发生：假 npx 在 ~500ms 后退出，
    // mock 看板在 ~400ms 后回健康。第二轮轮询（~800ms）时「壳已退出」与「看板就绪」同时成立，
    // 旧逻辑（先判 exitCode）必误报「进程已退出」；新逻辑先探健康则正常返回。
    const startedAt = Date.now();
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health' && Date.now() - startedAt >= 400) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"success":true,"data":"OK","error_data":null,"message":null}');
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-fakenpx-exit-'));
    // sleep 用绝对路径：子进程经 minimalChildEnv 只继承 PATH=bin，裸 `sleep` 会 not found
    // 导致壳瞬间退出（Linux 回收更快，首轮轮询即误判「进程已退出」，macOS 靠时序侥幸通过）
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\n/bin/sleep 0.5\nexit 0\n', { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const ret = await ensureKanbanRunning(`http://127.0.0.1:${port}`, { waitMs: 15000 });
      assert.equal(ret.started, true);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      fs.rmSync(bin, { recursive: true, force: true });
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  // ---------- KanbanHttpError：状态码随实例传递，message 为中文文案（含 HTTP <status>） ----------
  await checkAsync('apiGet：4xx 抛 KanbanHttpError（status 可读、message 中文格式）且不重试', async () => {
    let hits = 0;
    const mock = await contractMock(() => {
      hits++;
      return { status: 404, body: {} };
    });
    try {
      const err: unknown = await apiGet(mock.baseUrl, '/missing').catch((e: unknown) => e);
      assert.ok(err instanceof KanbanHttpError, `应为 KanbanHttpError，实际：${err}`);
      assert.equal(err.status, 404);
      // message 仍含 HTTP 状态码：既有断言（如 unit-resilience 的 /HTTP 404/）按此匹配
      assert.equal(err.message, '看板接口异常（HTTP 404）');
      assert.equal(hits, 1, '4xx 不应重试');
    } finally {
      await mock.close();
    }
  });

  await checkAsync('apiGet：5xx 轻量重试 1 次后仍抛 KanbanHttpError', async () => {
    let hits = 0;
    const mock = await contractMock(() => {
      hits++;
      return { status: 500, body: {} };
    });
    try {
      const err: unknown = await apiGet(mock.baseUrl, '/boom').catch((e: unknown) => e);
      assert.ok(err instanceof KanbanHttpError, `应为 KanbanHttpError，实际：${err}`);
      assert.equal(err.status, 500);
      assert.equal(hits, 2, '5xx 应重试 1 次，共 2 次请求');
    } finally {
      await mock.close();
    }
  });

  // ---------- resolveReviewTarget：attempt/repos 返回体运行时校验（不裸 as） ----------
  await checkAsync('resolveReviewTarget：attempt 字段类型不符时报「找不到执行环境记录」', async () => {
    const mock = await contractMock(() => ({ body: { success: true, data: { container_ref: 123 } } }));
    try {
      await assert.rejects(() => resolveReviewTarget(mock.baseUrl, 'a1'), /找不到该任务的执行环境记录/);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('resolveReviewTarget：repos 行类型不符时兜底为无 repos，不阻断目录定位', async () => {
    const mock = await contractMock((url) => {
      if (url === '/api/task-attempts/a2') {
        return { body: { success: true, data: { container_ref: null, branch: 'feat' } } };
      }
      if (url === '/api/task-attempts/a2/repos') return { body: { success: true, data: [{ path: 123 }] } };
      return { status: 404, body: {} };
    });
    try {
      // repos 校验失败被吞（同端点失败策略）→ 无候选目录 → 走「无法定位」而非校验错误外溢
      await assert.rejects(() => resolveReviewTarget(mock.baseUrl, 'a2'), /无法定位该任务的代码目录/);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('resolveReviewTarget：合法 repos 行通过校验并进入候选目录', async () => {
    const missing = path.join(os.tmpdir(), 'hta-unit-nonexistent-repo-dir');
    const mock = await contractMock((url) => {
      if (url === '/api/task-attempts/a3') {
        return { body: { success: true, data: { container_ref: null, branch: null } } };
      }
      if (url === '/api/task-attempts/a3/repos') {
        return { body: { success: true, data: [{ path: missing, name: 'r', target_branch: 'main' }] } };
      }
      return { status: 404, body: {} };
    });
    try {
      const err: unknown = await resolveReviewTarget(mock.baseUrl, 'a3').catch((e: unknown) => e);
      assert.ok(err instanceof Error && err.message.includes('无法定位该任务的代码目录'), `实际：${err}`);
      // 候选目录清单只进日志不进用户消息（宿主机绝对路径不抛给终端用户）
      assert.ok(!err.message.includes(missing), '候选目录路径不应出现在用户面文案');
      assert.ok(err.message.includes('人工审查'), '用户面应给出「人工审查」指引');
    } finally {
      await mock.close();
    }
  });

  // ---------- 依赖探测最小环境：第三方 CLI 不继承完整 process.env（含敏感变量） ----------
  /** 造一个把自身 env dump 到文件的假 CLI，返回 bin 目录与 dump 文件路径。 */
  function fakeCliDumpingEnv(name: string): { bin: string; dump: string } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), `hta-unit-probe-${name}-`));
    const dump = path.join(bin, 'dump.txt');
    // dump 路径烧进脚本：子进程走 minimalChildEnv，读不到测试进程自定义的传值变量
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n/usr/bin/env > ${dump}\n`, { mode: 0o755 });
    return { bin, dump };
  }

  await checkAsync('依赖探测：probeSync/probeAsync 走最小环境，敏感变量不进第三方 CLI 子进程', async () => {
    const { bin, dump } = fakeCliDumpingEnv('lark-cli');
    const prevPath = process.env.PATH;
    process.env.PATH = bin;
    process.env.HTA_UNIT_SECRET = 'should-not-leak';
    try {
      assert.equal(checkLarkCli(), true, 'probeSync 应探测到假 lark-cli');
      let leaked = fs.readFileSync(dump, 'utf8');
      assert.ok(!leaked.includes('HTA_UNIT_SECRET'), `probeSync 子进程不应看到敏感变量，实际 env：${leaked}`);
      assert.ok(leaked.includes(`PATH=${bin}`), 'PATH 属放行清单，应保留');
      fs.rmSync(dump, { force: true });
      assert.equal(await checkLarkCliAsync(), true, 'probeAsync 应探测到假 lark-cli');
      leaked = fs.readFileSync(dump, 'utf8');
      assert.ok(!leaked.includes('HTA_UNIT_SECRET'), `probeAsync 子进程不应看到敏感变量，实际 env：${leaked}`);
      assert.ok(leaked.includes(`PATH=${bin}`), 'PATH 属放行清单，应保留');
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      delete process.env.HTA_UNIT_SECRET;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  await checkAsync('findOcrCommand：ocr 探测同样套最小环境（与 buildOcrEnv 同一防线）', async () => {
    const { bin, dump } = fakeCliDumpingEnv('ocr');
    try {
      const cmd = await findOcrCommand({ PATH: bin, LLM_API_KEY: 'secret-marker' });
      assert.equal(cmd.via, 'path', 'PATH 上有假 ocr，应命中 path 形态');
      const leaked = fs.readFileSync(dump, 'utf8');
      assert.ok(!leaked.includes('LLM_API_KEY'), `探测子进程不应看到 LLM_API_KEY，实际 env：${leaked}`);
      assert.ok(leaked.includes(`PATH=${bin}`), 'PATH 属放行清单，应保留');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  // ---------- combinedSignal：调用方 signal 上的 abort 监听器随组合信号触发即摘除，不累积 ----------
  await checkAsync('apiGet：请求结束后调用方 signal 上不留滞留 abort 监听器', async () => {
    const mock = await contractMock(() => ({ body: { success: true, data: 'ok' } }));
    try {
      const controller = new AbortController();
      const signal = controller.signal;
      let added = 0;
      let removed = 0;
      const origAdd = signal.addEventListener.bind(signal) as unknown as (t: string, l: unknown, o?: unknown) => void;
      const origRemove = signal.removeEventListener.bind(signal) as unknown as (t: string, l: unknown, o?: unknown) => void;
      signal.addEventListener = ((type: string, listener: unknown, options: unknown) => {
        if (type === 'abort') added++;
        origAdd(type, listener, options);
      }) as unknown as AbortSignal['addEventListener'];
      signal.removeEventListener = ((type: string, listener: unknown, options: unknown) => {
        if (type === 'abort') removed++;
        origRemove(type, listener, options);
      }) as unknown as AbortSignal['removeEventListener'];
      // 逐发请求 + 等超时兜底到点：旧逻辑只在 abort 事件触发时移除监听器（removed 恒 0），
      // 新逻辑随 timeout 分支触发即摘除（removed 追上 added）
      for (let i = 0; i < 5; i++) {
        await apiGet(mock.baseUrl, '/ok', { signal, timeoutMs: 30 });
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(removed, added, `第 ${i + 1} 发后滞留 ${added - removed} 个监听器`);
      }
      assert.ok(added >= 5, 'combinedSignal 应确实挂过监听器');
      controller.abort(); // 收尾：不残留对已 abort signal 的引用
    } finally {
      await mock.close();
    }
  });

  // ---------- KanbanMcp.connect：settled 护栏（超时回调不误关已建立的连接） ----------
  /** 写一个最小 fake MCP stdio server（NDJSON/JSON-RPC 应答 initialize 与 tools/list）。 */
  function fakeMcpServerScript(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-fakemcp-'));
    const script = path.join(dir, 'server.js');
    fs.writeFileSync(
      script,
      `let buf = '';
const delay = Number(process.argv[2] || 0);
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // 通知不应答
    const respond = () => {
      const result = msg.method === 'initialize'
        ? { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake', version: '0' } }
        : { tools: [] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    };
    if (delay) setTimeout(respond, delay);
    else respond();
  }
});
`,
    );
    return script;
  }

  await checkAsync('KanbanMcp.connect：正常路径连接成功、可 ping（settled 护栏不破坏成功路径）', async () => {
    const script = fakeMcpServerScript();
    const mcp = new KanbanMcp({ command: process.execPath, args: [script, '0'] });
    try {
      const tools = await mcp.connect({ timeoutMs: 10000 });
      assert.deepEqual(tools, []);
      assert.equal(mcp.connected, true);
      await mcp.ping();
      await mcp.close();
      assert.equal(mcp.connected, false);
    } finally {
      await mcp.close().catch(() => {});
      fs.rmSync(path.dirname(script), { recursive: true, force: true });
    }
  });

  await checkAsync('KanbanMcp.connect：对端无响应时按时超时抛错（settled 护栏不破坏超时清理）', async () => {
    const script = fakeMcpServerScript();
    const mcp = new KanbanMcp({ command: process.execPath, args: [script, '5000'] });
    const started = Date.now();
    try {
      await assert.rejects(mcp.connect({ timeoutMs: 300 }), '应在超时内抛错');
      assert.ok(Date.now() - started < 3000, `超时应及时返回，实际耗时 ${Date.now() - started}ms`);
      assert.equal(mcp.connected, false);
    } finally {
      await mcp.close().catch(() => {});
      fs.rmSync(path.dirname(script), { recursive: true, force: true });
    }
  });

  // ---------- workspace-ready：瞬时错误归 unknown 继续轮询，仅 404 判 failed，abort 归被中断 ----------
  await checkAsync('fetchWorkspaceSnapshot：仅 404 判 failed（null），瞬时错误归 unknown', async () => {
    const mock404 = await contractMock(() => ({ status: 404, body: {} }));
    try {
      const snap = await fetchWorkspaceSnapshot(mock404.baseUrl, 'w1');
      assert.equal(snap, null);
      assert.equal(classifyWorkspaceSetup(snap), 'failed');
    } finally {
      await mock404.close();
    }
    const mock500 = await contractMock(() => ({ status: 500, body: {} }));
    try {
      const snap = await fetchWorkspaceSnapshot(mock500.baseUrl, 'w2');
      assert.equal(snap, 'unknown', '5xx 属瞬时错误，不应误诊为初始化失败');
      assert.equal(classifyWorkspaceSetup(snap), 'unknown');
    } finally {
      await mock500.close();
    }
    // 连接拒绝（看板未起）：1 号端口必拒
    const snap = await fetchWorkspaceSnapshot('http://127.0.0.1:1', 'w3');
    assert.equal(snap, 'unknown', '连接拒绝属瞬时错误，不应误诊为初始化失败');
  });

  await checkAsync('waitForWorkspaceReady：瞬时错误继续轮询直至 ready', async () => {
    let hits = 0;
    const mock = await contractMock((url) => {
      if (url === '/api/task-attempts/w4') {
        hits++;
        // apiGet 对 5xx 内部重试 1 次：首轮 snapshot 消耗 2 次 hits 且归 unknown，第二轮即 ready
        if (hits <= 2) return { status: 500, body: {} };
        return { body: { success: true, data: { container_ref: '/tmp/ws4' } } };
      }
      return { status: 404, body: {} };
    });
    try {
      const ret = await waitForWorkspaceReady(mock.baseUrl, 'w4', { timeoutMs: 10000, intervalMs: 30 });
      assert.equal(ret.ok, true, `瞬时错误后应继续轮询到 ready，实际：${ret.message}`);
      assert.equal(hits, 3);
    } finally {
      await mock.close();
    }
  });

  await checkAsync('waitForWorkspaceReady：404 判 failed 立即返回诊断文案（不轮询）', async () => {
    let attemptsHits = 0;
    const mock = await contractMock((url) => {
      if (url === '/api/task-attempts/w5') {
        attemptsHits++;
        return { status: 404, body: {} };
      }
      if (url === '/api/task-attempts/w5/repos') return { body: { success: true, data: [{ target_branch: 'main' }] } };
      return { status: 404, body: {} };
    });
    try {
      const ret = await waitForWorkspaceReady(mock.baseUrl, 'w5', { timeoutMs: 5000, intervalMs: 20 });
      assert.equal(ret.ok, false);
      assert.ok(ret.message!.includes('请检查'), `应返回分支排查文案，实际：${ret.message}`);
      assert.equal(attemptsHits, 1, '404 应立即返回，不应继续轮询');
    } finally {
      await mock.close();
    }
  });

  await checkAsync('waitForWorkspaceReady：轮询中被 abort 归「被中断」，不报误导性失败文案', async () => {
    // 看板 hang 住（2s 后才应答）：50ms 处 abort，应走「被中断」而不是等超时或报「请检查」
    const started = Date.now();
    const server = http.createServer((_req, res) => {
      const t = setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"success":true,"data":{}}');
        } catch {
          /* 连接已被 abort 关闭 */
        }
      }, 2000);
      res.on('close', () => clearTimeout(t));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const ret = await waitForWorkspaceReady(baseUrl, 'w6', { timeoutMs: 10000, intervalMs: 30, signal: controller.signal });
      assert.equal(ret.ok, false);
      assert.ok(ret.message!.includes('被中断'), `应归「被中断」，实际：${ret.message}`);
      assert.ok(!ret.message!.includes('请检查'), '中断不应报误导性的分支排查文案');
      assert.ok(Date.now() - started < 1500, 'abort 应立即返回，不等看板应答');
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  finish();
}

void main();
