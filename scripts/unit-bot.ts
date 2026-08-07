// Unit tests（批次4：bot 与产品交互）: 纯逻辑 —— 无 LLM、无网络、无飞书连接。Run: npx tsx scripts/unit-bot.ts

import assert from 'node:assert/strict';
import * as Lark from '@larksuiteoapi/node-sdk';
import { parseBotArgs } from '../src/bot-main';
import { UPDATE_YES_RE, UPDATE_YES_WORDS, promptVersionUpdate } from '../src/update-check';
import { FeishuChannel, FEISHU_HTTP_TIMEOUT_MS } from '../src/channels/feishu';
import { check, checkAsync, finish } from './testkit';

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

  finish();
}

void main();
