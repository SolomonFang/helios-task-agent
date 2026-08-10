/**
 * 会话历史持久化单测（SessionHistoryStore + AgentSession 接线）：
 * 落盘→重建恢复；坏 JSON 宽容；/clear 清盘；文件名穿越防护；目录文件数上限清理；
 * system note 不落盘；失败轮次的 user 消息不落盘。
 * 运行：tsx scripts/unit-session-store.ts
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionHistoryStore } from '../src/agent/session-store';
import { AgentSession } from '../src/agent/session';
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

  finish();
}

void main();
