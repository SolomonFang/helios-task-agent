// Unit tests（批次4：bot 与产品交互）: 纯逻辑 —— 无 LLM、无网络、无飞书连接。Run: npx tsx scripts/unit-bot.ts

import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { Readable } from 'stream';
import * as Lark from '@larksuiteoapi/node-sdk';
import { parseBotArgs } from '../src/bot-main';
import { UPDATE_YES_RE, UPDATE_YES_WORDS, promptVersionUpdate } from '../src/infra/update-check';
import { FeishuChannel, FEISHU_HTTP_TIMEOUT_MS, FEISHU_IMAGE_DOWNLOAD_TIMEOUT_MS } from '../src/channels/feishu';
import { buildAiReviewCard } from '../src/channels/feishu-cards';
import { check, checkAsync, finish } from './testkit';

// ---------- 退出码子进程测试的共用装置 ----------
// 以完整 env 配置启动真实入口（tsx 跑 src/*.ts），配合 HTA_TEST_CRASH 钩子 / SIGINT
// 验证优雅退出的退出码：崩溃必须是 1（launchd/systemd 据此判断是否重启），正常信号是 0。

const repoRoot = path.join(__dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** 本地 mock 看板：/api/health 返回看板信封，让子进程顺利越过看板拉起进入 MCP 连接窗口。 */
async function startMockKanbanHealth(): Promise<{ server: http.Server; url: string; healthSeen: Promise<void> }> {
  let markSeen!: () => void;
  const healthSeen = new Promise<void>((r) => (markSeen = r));
  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/health')) {
      markSeen(); // CLI 子进程非 TTY 时 Spinner 静默：以此作为「看板拉起完成、即将连接 MCP」的同步点
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"success":true,"data":"OK","error_data":null,"message":null}');
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, healthSeen };
}

function spawnAgent(entry: string, kanbanUrl: string, extraEnv: Record<string, string>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-bot-exit-'));
  const child = spawn(process.execPath, [tsxCli, path.join(repoRoot, 'src', entry)], {
    cwd: tmp, // 避免 cwd .env 干扰子进程配置
    env: {
      ...process.env,
      HELIOS_TASK_AGENT_HOME: tmp, // 数据目录隔离；同时让 home .env 不存在（不会覆盖下列 env）
      HELIOS_TASK_AGENT_ENV: path.join(tmp, 'nonexistent.env'), // 中和父进程可能带来的强制 env
      LLM_BASE_URL: 'http://127.0.0.1:9/v1',
      LLM_API_KEY: 'sk-x',
      LLM_MODEL: 'm',
      HELIOS_KANBAN_URL: kanbanUrl,
      // 慢命令：MCP 连接窗口（45s 超时）内信号/崩溃必然落在连接在途期间
      HELIOS_KANBAN_MCP_COMMAND: process.execPath,
      HELIOS_KANBAN_MCP_ARGS: '-e setTimeout(()=>{},30000)',
      HTA_UPDATE_CHECK: '0',
      KANBAN_WATCH: '0',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (d: Buffer) => (buf += d.toString()));
  child.stderr.on('data', (d: Buffer) => (buf += d.toString()));
  return { child, tmp, out: () => buf };
}

function waitExit(child: ChildProcess, timeoutMs = 30000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('子进程退出超时'));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function waitOutput(out: () => string, marker: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!out().includes(marker)) {
    if (Date.now() > deadline) throw new Error(`等待子进程输出超时: ${marker}；已有输出：${out()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 轮询进程表，直到 MCP 慢命令（`node -e setTimeout...`）出现在 pid 的后代进程中——即连接已在途。
 *  注意必须沿祖先链判定而非直接父子：tsx 会再 fork 一层 node 跑入口，MCP 子进程是「孙子」。 */
async function waitMcpConnecting(pid: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    const ppidOf = new Map<number, number>();
    const markers: number[] = [];
    for (const line of ps.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      ppidOf.set(Number(m[1]), Number(m[2]));
      if (m[3]!.includes('setTimeout(()=>{},30000)')) markers.push(Number(m[1]));
    }
    const isDescendant = (p: number): boolean => {
      let cur = p;
      while (ppidOf.has(cur)) {
        cur = ppidOf.get(cur)!;
        if (cur === pid) return true;
      }
      return false;
    };
    if (markers.some(isDescendant)) return;
    if (Date.now() > deadline) throw new Error(`等待 MCP 慢命令后代进程超时（pid=${pid}）`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  // ---------- bot 参数解析（--rebind / --reconfig） ----------
  check('parseBotArgs：无参数', (() => {
    const r = parseBotArgs([]);
    return !r.rebind && !r.reconfig;
  })());
  check('parseBotArgs：--reconfig（含无横线形式）', (() => {
    return parseBotArgs(['--reconfig']).reconfig && parseBotArgs(['reconfig']).reconfig && !parseBotArgs(['--reconfig']).rebind;
  })());
  check('parseBotArgs：--rebind 与 --reconfig 互不混淆', (() => {
    const rb = parseBotArgs(['--rebind']);
    const both = parseBotArgs(['--rebind', '--reconfig']);
    return rb.rebind && !rb.reconfig && both.rebind && both.reconfig;
  })());

  // ---------- 更新确认词表：独立于写操作闸门 ----------
  check('UPDATE_YES_RE：更新意图词命中', (() => {
    return ['更新', '确认更新', '升级', '确认', 'update', 'UPDATE', 'y', 'yes'].every((w) => UPDATE_YES_RE.test(w));
  })());
  check('UPDATE_YES_RE：写操作批准词不触发全局更新', (() => {
    return ['执行', '批准', '确认执行', '同意', '', '取消', '随便'].every((w) => !UPDATE_YES_RE.test(w));
  })());
  check('UPDATE_YES_RE：词表不含写闸门词（执行/批准/同意）', (() => {
    return !UPDATE_YES_WORDS.some((w) => ['执行', '批准', '同意', '确认执行'].includes(w));
  })());

  await checkAsync('promptVersionUpdate：回复「执行」「批准」跳过更新', async () => {
    const info = { current: '1.0.2', latest: '1.1.0', tag: 'latest' as const };
    for (const word of ['执行', '批准', '确认执行']) {
      let ran = false;
      const outcome = await promptVersionUpdate({
        info,
        ask: async () => word,
        runUpdate: async () => {
          ran = true;
          return true;
        },
      });
      assert.equal(outcome, 'skipped', `回复「${word}」不应触发 npm i -g`);
      assert.equal(ran, false);
    }
  });

  await checkAsync('promptVersionUpdate：回复「更新」「升级」执行更新（保留频道）', async () => {
    const info = { current: '1.1.0-beta.0', latest: '1.2.0-beta.0', tag: 'next' as const };
    for (const word of ['更新', '升级']) {
      const ran: string[] = [];
      const outcome = await promptVersionUpdate({
        info,
        ask: async () => word,
        runUpdate: async (tag) => {
          ran.push(tag);
          return true;
        },
      });
      assert.equal(outcome, 'updated');
      assert.deepEqual(ran, ['next']);
    }
  });

  // ---------- FeishuChannel.stop()：未启动时可安全调用、可重复 ----------
  await checkAsync('FeishuChannel.stop：未 start 也幂等安全', async () => {
    const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] });
    assert.equal(ch.connectionState(), null, '未启动时无连接状态');
    await ch.stop();
    assert.equal(ch.connectionState(), null, 'stop 不应意外建立连接');
    assert.equal(ch.lastEventAt(), 0, 'stop 不应伪造事件时间');
    await ch.stop(); // 重复调用幂等
    assert.equal(ch.connectionState(), null);
  });

  // ---------- 飞书 REST 超时：构造 channel 即给 SDK 共享 axios 实例配默认超时 ----------
  check('FeishuChannel：REST 调用有超时兜底（SDK axios 默认 timeout=0 会永久 pending）', (() => {
    new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] });
    return Lark.defaultHttpInstance.defaults.timeout === FEISHU_HTTP_TIMEOUT_MS && FEISHU_HTTP_TIMEOUT_MS > 0;
  })());

  // ---------- downloadImage：流读取有整体超时（axios timeout 只覆盖到响应头） ----------
  // client 是私有字段：与既有 fake 注入同一手法，一次性收窄后替换 messageResource.get
  type ImageGet = () => Promise<{ getReadableStream: () => Readable; headers: Record<string, unknown> }>;
  const stubImageGet = (ch: FeishuChannel, get: ImageGet): void => {
    (ch as unknown as { client: unknown }).client = { im: { v1: { messageResource: { get } } } };
  };

  await checkAsync('downloadImage：正常读取聚合 Buffer 与 MIME', async () => {
    const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] });
    stubImageGet(ch, async () => ({
      getReadableStream: () => Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
      headers: { 'content-type': 'image/png' },
    }));
    const r = await ch.downloadImage('m1', 'k1');
    assert.equal(r.data.toString(), 'abcd');
    assert.equal(r.mimeType, 'image/png');
  });

  await checkAsync('downloadImage：body 停滞有整体超时，超时销毁流并抛错（走「下载失败」路径）', async () => {
    const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] });
    const stalled = new Readable({ read() {} }); // 永不产出数据：模拟 TCP 停滞
    stubImageGet(ch, async () => ({
      getReadableStream: () => stalled,
      headers: {},
    }));
    const t0 = Date.now();
    await assert.rejects(ch.downloadImage('m1', 'k1', undefined, 50), /超时/);
    assert.ok(Date.now() - t0 < FEISHU_IMAGE_DOWNLOAD_TIMEOUT_MS, '超时兜底应在注入的短超时内触发');
    assert.ok(stalled.destroyed, '超时后应销毁流，释放底层连接');
  });

  // ---------- FeishuChannel.start：等待首次握手结果（SDK start() 不等，首次连不上会假「就绪」僵尸） ----------
  // 补丁 WSClient.prototype.start/close 为可控假实现（namespace 对象只读，换类不灵；原型补丁对类本身生效）：
  // ready 回调 onReady / error 回调 onError / hang 永不回调（模拟网络未就绪时 SDK 静默无限重试）。
  // 真实构造器照跑（无网络），回调在构造时存为实例字段（this.onReady 等），补丁直接取用。
  interface WsPatched {
    onReady?: () => void;
    onError?: (err: Error) => void;
    onReconnecting?: () => void;
    onReconnected?: () => void;
    __htaClosed?: boolean;
  }
  const wsCtl: { behavior: 'ready' | 'error' | 'hang'; last: WsPatched | null } = { behavior: 'ready', last: null };
  const wsProto = Lark.WSClient.prototype as unknown as Record<string, unknown>;
  const realWsStart = wsProto.start;
  const realWsClose = wsProto.close;
  wsProto.start = async function (this: WsPatched, _params: unknown): Promise<void> {
    wsCtl.last = this;
    if (wsCtl.behavior === 'ready') setTimeout(() => this.onReady?.(), 5);
    else if (wsCtl.behavior === 'error') setTimeout(() => this.onError?.(new Error('invalid app credentials')), 5);
    // hang：永不回调（SDK 在网络未就绪时静默无限重试，不触发任何回调）
  };
  wsProto.close = function (this: WsPatched): void {
    this.__htaClosed = true;
  };
  try {
    await checkAsync('FeishuChannel.start：onReady 后 resolve，重连告警接线不变', async () => {
      wsCtl.behavior = 'ready';
      const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] }, { wsFirstConnectTimeoutMs: 1000 });
      const states: string[] = [];
      ch.onWsStateChange = (state) => states.push(state);
      await ch.start(async () => {});
      // 首次握手完成后，断线重连仍走既有 ws-alerter 接线
      wsCtl.last!.onReconnecting?.();
      wsCtl.last!.onReconnected?.();
      assert.deepEqual(states, ['reconnecting', 'reconnected'], '重连状态钩子应照常透传');
      await ch.stop();
      assert.ok(wsCtl.last!.__htaClosed, 'stop 应关闭底层 WSClient');
    });

    await checkAsync('FeishuChannel.start：首次连接不可重试错误（onError）时 reject', async () => {
      wsCtl.behavior = 'error';
      const origErr = console.error;
      console.error = () => {}; // onError 会记日志，测试期间静音
      try {
        const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] }, { wsFirstConnectTimeoutMs: 1000 });
        await assert.rejects(ch.start(async () => {}), /invalid app credentials/, '不可重试错误应抛出');
        assert.ok(wsCtl.last!.__htaClosed, '失败后应关闭底层 WSClient，不留孤儿重连');
      } finally {
        console.error = origErr;
      }
    });

    await checkAsync('FeishuChannel.start：首次握手超时 reject（网络未就绪时 SDK 静默重试）', async () => {
      wsCtl.behavior = 'hang';
      const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] }, { wsFirstConnectTimeoutMs: 50 });
      await assert.rejects(ch.start(async () => {}), /首次握手超时/, '超时应抛出而非假「就绪」');
      assert.ok(wsCtl.last!.__htaClosed, '超时后应关闭底层 WSClient，不留孤儿重连');
    });
  } finally {
    wsProto.start = realWsStart;
    wsProto.close = realWsClose;
  }

  // ---------- buildAiReviewCard：注脚按 URL 是否 loopback 区分可达口径（与 buildWatchEventCard 一致） ----------
  const aiCardNote = (url: string): string => {
    const card = buildAiReviewCard('任务X', url, false) as {
      elements: Array<{ tag: string; elements?: Array<{ content?: string }> }>;
    };
    const note = card.elements.find((e) => e.tag === 'note');
    return note?.elements?.map((x) => x.content).join(' ') ?? '';
  };
  check('buildAiReviewCard：loopback URL 注脚标注仅本机可达', aiCardNote('http://127.0.0.1:7964/r.html').includes('链接仅本机可达（手机/局域网打不开）'));
  check(
    'buildAiReviewCard：局域网 URL 注脚标注所在网络可达（report-server 绑 0.0.0.0 时手机可达）',
    aiCardNote('http://192.168.1.10:7964/r.html').includes('链接仅本机所在网络可达'),
  );

  // ---------- 进程退出码：崩溃路径为 1，正常信号路径为 0 ----------
  const feishuEnv = { FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 's', FEISHU_ALLOWED_OPEN_IDS: 'ou_x' };
  const kanban = await startMockKanbanHealth();
  try {
    await checkAsync('退出码：bot uncaughtException 优雅退出且退出码为 1（进程管理器据此重启）', async () => {
      const { child, tmp, out } = spawnAgent('bot-main.ts', kanban.url, { ...feishuEnv, HTA_TEST_CRASH: '1' });
      try {
        const code = await waitExit(child);
        assert.ok(out().includes('未捕获异常'), `应走 uncaughtException 优雅退出路径，输出：${out()}`);
        assert.equal(code, 1, `崩溃路径退出码应为 1，实际 ${code}；输出：${out()}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    await checkAsync('退出码：bot 在 MCP 连接窗口内收到 SIGINT 正常退出且退出码为 0', async () => {
      const { child, tmp, out } = spawnAgent('bot-main.ts', kanban.url, feishuEnv);
      try {
        await waitOutput(out, '正在连接 helios-kanban MCP'); // 连接在途（慢命令）时发信号
        child.kill('SIGINT');
        const code = await waitExit(child);
        assert.ok(out().includes('正在退出'), `应走优雅退出路径，输出：${out()}`);
        assert.equal(code, 0, `SIGINT 路径退出码应为 0，实际 ${code}；输出：${out()}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    await checkAsync('退出码：cli uncaughtException 优雅退出且退出码为 1', async () => {
      const { child, tmp, out } = spawnAgent('cli.ts', kanban.url, { HTA_TEST_CRASH: '1' });
      try {
        const code = await waitExit(child);
        assert.ok(out().includes('未捕获异常'), `应走 uncaughtException 优雅退出路径，输出：${out()}`);
        assert.equal(code, 1, `崩溃路径退出码应为 1，实际 ${code}；输出：${out()}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    await checkAsync('退出码：cli 在 MCP 连接窗口内收到 SIGINT 正常退出且退出码为 0', async () => {
      const { child, tmp, out } = spawnAgent('cli.ts', kanban.url, {});
      try {
        // 非 TTY 时 Spinner 无输出，无法用 stdout 作同步点。改为等慢命令孙子进程出现：
        // 孙子进程存在 = connectMcp 已发起，而信号处理在连接之前注册，此时 SIGINT 必走优雅退出。
        // （此前用 healthSeen + 150ms 固定余量，高负载下信号偶尔落在处理注册之前 → 假失败）
        await kanban.healthSeen;
        await waitMcpConnecting(child.pid!);
        child.kill('SIGINT');
        const code = await waitExit(child);
        assert.ok(out().includes('再见'), `应走优雅退出路径，输出：${out()}`);
        assert.equal(code, 0, `SIGINT 路径退出码应为 0，实际 ${code}；输出：${out()}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  } finally {
    kanban.server.closeAllConnections?.();
    await new Promise((r) => kanban.server.close(r));
  }

  finish();
}

void main();
