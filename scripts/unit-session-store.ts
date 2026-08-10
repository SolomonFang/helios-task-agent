/**
 * 会话历史持久化单测（SessionHistoryStore + AgentSession 接线）：
 * 落盘→重建恢复；坏 JSON 宽容；版本不符视为无历史；畸形 tool_calls 条目丢弃；
 * /clear 清盘；文件名穿越防护；目录文件数上限清理；system note 不落盘；
 * 失败轮次的 user 消息不落盘；成功轮次落盘（happy path）；SessionRouter 透传接线。
 * 运行：tsx scripts/unit-session-store.ts
 */
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { SessionHistoryStore } from '../src/agent/session-store';
import { AgentSession } from '../src/agent/session';
import { SessionRouter } from '../src/agent/session-router';
import { MemoryStore } from '../src/agent/memory';
import { check, checkAsync, finish } from './testkit';
import type { AgentConfig, ChatMessage } from '../src/types';

const cfg: AgentConfig = {
  llmBaseUrl: 'http://localhost:1/v1', // 不可达：handleUserMessage 预期快速失败
  llmApiKey: 'sk-x',
  llmModel: 'm',
  mcpCommand: 'npx',
  mcpArgs: [],
  kanbanUrl: 'http://localhost:1',
  kanbanProjectId: '',
  kanbanRepoId: '',
  kanbanIteration: '',
};

function tmpHome(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hta-unit-sess-${tag}-`));
}

const historyOf = (s: AgentSession) => (s as unknown as { messages: ChatMessage[] }).messages;

/** 最小 fake LLM：立即回固定补全（happy path 落盘断言用，不触真实网络）。 */
async function startFakeLlm(replyText = '好的，已收到'): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'cmpl-fake',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

async function main(): Promise<void> {
  // ---------- 落盘 → 重建 store 恢复（system 角色被过滤，user/assistant/tool 保留） ----------
  check('save→load 往返：仅持久化 user/assistant/tool，system note 被过滤', (() => {
    const tmp = tmpHome('roundtrip');
    try {
      const store = new SessionHistoryStore(tmp);
      const messages: ChatMessage[] = [
        { role: 'system', content: '系统提示词' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
        { role: 'system', content: '[看板事件通知] 任务完成' }, // 注入的 system note 不落盘
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '工具结果' },
      ];
      store.save('ou_abc', messages);
      const restored = new SessionHistoryStore(tmp).load('ou_abc');
      assert.deepEqual(
        restored.map((m) => m.role),
        ['user', 'assistant', 'assistant', 'tool'],
      );
      assert.equal(restored[0]!.content, '你好');
      // 0600 权限
      const file = path.join(tmp, 'sessions', 'ou_abc.json');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      // 目录 0700 权限
      assert.equal(fs.statSync(path.join(tmp, 'sessions')).mode & 0o777, 0o700);
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  // ---------- 坏 JSON / 格式不符宽容 ----------
  check('坏 JSON / 格式不符：视为无历史', (() => {
    const tmp = tmpHome('badjson');
    try {
      const dir = path.join(tmp, 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
      fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ hello: 1 }));
      fs.writeFileSync(path.join(dir, 'mixed.json'), JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'ok' }, { role: 'user' }, 42] }));
      const store = new SessionHistoryStore(tmp);
      assert.deepEqual(store.load('bad'), []);
      assert.deepEqual(store.load('wrong'), []);
      assert.deepEqual(store.load('missing'), []);
      // 混合坏条目：只留合法的
      const mixed = store.load('mixed');
      assert.equal(mixed.length, 1);
      assert.equal(mixed[0]!.content, 'ok');
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  // ---------- clear 清盘 ----------
  check('clear：删除磁盘历史，再次 load 为空；重复 clear 不抛错', (() => {
    const tmp = tmpHome('clear');
    try {
      const store = new SessionHistoryStore(tmp);
      store.save('u1', [{ role: 'user', content: 'hi' }]);
      assert.equal(store.load('u1').length, 1);
      store.clear('u1');
      assert.deepEqual(store.load('u1'), []);
      store.clear('u1'); // 幂等
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  // ---------- 文件名穿越防护 ----------
  check('恶意 open_id（../evil 等）：不能写出 sessions 目录', (() => {
    const tmp = tmpHome('traversal');
    try {
      const store = new SessionHistoryStore(tmp);
      store.save('../evil', [{ role: 'user', content: 'x' }]);
      store.save('..%2f..%2fetc', [{ role: 'user', content: 'x' }]);
      store.save('', [{ role: 'user', content: 'x' }]);
      // 目录外不得出现任何文件
      assert.equal(fs.existsSync(path.join(tmp, 'evil.json')), false);
      assert.deepEqual(fs.readdirSync(tmp), ['sessions']);
      // 全部落在 sessions/ 内且可读回
      const files = fs.readdirSync(path.join(tmp, 'sessions'));
      assert.equal(files.length, 3);
      for (const f of files) {
        assert.equal(path.dirname(path.join(tmp, 'sessions', f)), path.join(tmp, 'sessions'));
      }
      assert.equal(store.load('../evil').length, 1);
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  // ---------- 目录文件数上限清理（按 mtime 删最老） ----------
  check('文件总数超上限：按 mtime 清最老，新文件保留', (() => {
    const tmp = tmpHome('prune');
    try {
      const store = new SessionHistoryStore(tmp, 3);
      for (let i = 0; i < 5; i++) store.save(`u${i}`, [{ role: 'user', content: `m${i}` }]);
      // 人为拉开 mtime：u0 最老，u4 最新
      const dir = path.join(tmp, 'sessions');
      for (let i = 0; i < 5; i++) {
        const f = path.join(dir, `u${i}.json`);
        if (fs.existsSync(f)) fs.utimesSync(f, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
      }
      store.save('u5', [{ role: 'user', content: 'm5' }]); // 触发 prune
      const files = fs.readdirSync(dir).sort();
      assert.equal(files.length, 3);
      assert.ok(!files.includes('u0.json') && !files.includes('u1.json') && !files.includes('u2.json'));
      assert.ok(files.includes('u5.json'));
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  // ---------- AgentSession：重建时恢复磁盘历史 ----------
  check('AgentSession：新建会话从磁盘恢复历史（system prompt 之后）', (() => {
    const tmp = tmpHome('restore');
    try {
      const store = new SessionHistoryStore(tmp);
      store.save('u1', [
        { role: 'user', content: '之前的问题' },
        { role: 'assistant', content: '之前的回答' },
      ]);
      const session = new AgentSession(cfg, null, false, {
        userId: 'u1',
        memory: new MemoryStore(tmp),
        historyStore: store,
      });
      const msgs = historyOf(session);
      assert.equal(msgs.length, 3);
      assert.equal(msgs[0]!.role, 'system');
      assert.equal(msgs[1]!.content, '之前的问题');
      assert.equal(msgs[2]!.content, '之前的回答');
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  // ---------- AgentSession：clearHistory 同步清盘 ----------
  await checkAsync('AgentSession：clearHistory 清掉磁盘历史，重建不再恢复', async () => {
    const tmp = tmpHome('sessclear');
    try {
      const store = new SessionHistoryStore(tmp);
      const session = new AgentSession(cfg, null, false, {
        userId: 'u1',
        memory: new MemoryStore(tmp),
        historyStore: store,
      });
      try {
        await session.handleUserMessage('hi'); // LLM 不可达，失败弹回；磁盘应为空历史
      } catch {
        /* 预期失败 */
      }
      store.save('u1', [{ role: 'user', content: '旧历史' }]); // 模拟此前已落盘
      session.clearHistory();
      assert.deepEqual(store.load('u1'), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- AgentSession：失败轮次的 user 消息与 system note 不落盘 ----------
  await checkAsync('AgentSession：LLM 失败轮次的 user 消息弹回不落盘；注入的 system note 不落盘', async () => {
    const tmp = tmpHome('failturn');
    try {
      const store = new SessionHistoryStore(tmp);
      const session = new AgentSession(cfg, null, false, {
        userId: 'u1',
        memory: new MemoryStore(tmp),
        historyStore: store,
      });
      session.injectSystemNote('[看板事件通知] 外部事件');
      try {
        await session.handleUserMessage('这条不应落盘');
      } catch {
        /* LLM 不可达，预期失败 */
      }
      assert.deepEqual(store.load('u1'), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- AgentSession：成功轮次落盘（happy path 主链路） ----------
  await checkAsync('AgentSession：成功对话结束落盘，重建 store 可读回该轮 user/assistant', async () => {
    const tmp = tmpHome('happy');
    const llm = await startFakeLlm('这是回答');
    try {
      const store = new SessionHistoryStore(tmp);
      const session = new AgentSession({ ...cfg, llmBaseUrl: llm.baseUrl }, null, false, {
        userId: 'u1',
        memory: new MemoryStore(tmp),
        historyStore: store,
      });
      await session.handleUserMessage('你好');
      const restored = new SessionHistoryStore(tmp).load('u1');
      assert.deepEqual(
        restored.map((m) => m.role),
        ['user', 'assistant'],
      );
      assert.equal(restored[0]!.content, '你好');
      assert.equal(restored[1]!.content, '这是回答');
    } finally {
      await llm.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- SessionRouter：historyStore 透传给新建会话（接线） ----------
  check('SessionRouter：getOrCreate 新建会话时从 historyStore 恢复磁盘历史', (() => {
    const tmp = tmpHome('router');
    try {
      const store = new SessionHistoryStore(tmp);
      store.save('ou_x', [
        { role: 'user', content: '之前的对话' },
        { role: 'assistant', content: '之前的回复' },
      ]);
      const router = new SessionRouter(cfg, null, false, new MemoryStore(tmp), undefined, undefined, store);
      const msgs = historyOf(router.getOrCreate('ou_x'));
      assert.deepEqual(
        msgs.map((m) => m.role),
        ['system', 'user', 'assistant'],
      );
      assert.equal(msgs[1]!.content, '之前的对话');
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  // ---------- 版本不符 / 畸形 tool_calls ----------
  check('load：文件版本不符视为无历史（防旧假设解析新格式）', (() => {
    const tmp = tmpHome('version');
    try {
      const dir = path.join(tmp, 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'u1.json'),
        JSON.stringify({ version: 999, userId: 'u1', updatedAt: '', messages: [{ role: 'user', content: 'hi' }] }),
      );
      assert.deepEqual(new SessionHistoryStore(tmp).load('u1'), []);
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  check('load：畸形 tool_calls（缺 id/type/function.name）的 assistant 条目被丢弃', (() => {
    const tmp = tmpHome('badcalls');
    try {
      const dir = path.join(tmp, 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'u1.json'),
        JSON.stringify({
          version: 1,
          userId: 'u1',
          updatedAt: '',
          messages: [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: null, tool_calls: [{ function: { name: 't' } }] }, // 缺 id/type
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' }] }, // 缺 function.name
            { role: 'assistant', content: null, tool_calls: 'not-array' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } }],
            },
          ],
        }),
      );
      const loaded = new SessionHistoryStore(tmp).load('u1');
      assert.equal(loaded.length, 2); // user + 唯一合法的 assistant
      assert.equal(loaded[1]!.role, 'assistant');
      return true;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

  finish();
}

void main();
