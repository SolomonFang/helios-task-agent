// Unit tests（批次4：bot 与产品交互）: 纯逻辑 —— 无 LLM、无网络、无飞书连接。Run: npx tsx scripts/unit-bot.ts

import assert from 'node:assert/strict';
import { parseBotArgs } from '../src/bot';
import { UPDATE_YES_RE, UPDATE_YES_WORDS, promptVersionUpdate } from '../src/update-check';
import { FeishuChannel } from '../src/channels/feishu';

let failures = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
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
    await ch.stop();
    await ch.stop();
  });

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
