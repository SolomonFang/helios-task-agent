// feishu WS 事件过滤纯函数单测：p2p 私聊限定 / bot 发送者忽略 / message_id 去重（含 TTL 上限）/
// 卡片回调 open_id 白名单 / owner 认领 fail-closed。不触飞书 SDK 网络层。Run: npx tsx scripts/unit-feishu-filter.ts

import assert from 'node:assert/strict';
import {
  createAccessChecker,
  createMessageDedupe,
  FeishuChannel,
  filterIncomingMessage,
  GROUP_MENTION_COOLDOWN_MS,
  groupMentionChatId,
  groupMentionInCooldown,
  isCardActionAllowed,
  resolveAccess,
  type FeishuReceivePayload,
} from '../src/channels/feishu';
import { checkAsync, finish } from './testkit';

/** 构造一条最小合法 p2p 私聊文本消息事件。 */
function mkP2pMessage(overrides: Partial<FeishuReceivePayload> = {}): FeishuReceivePayload {
  return {
    sender: { sender_id: { open_id: 'ou_user1' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '你好' }),
    },
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ---------- 入口过滤：仅 p2p 私聊 + 真人发送者 + 必填字段 ----------
  await checkAsync('filter：群聊（非 p2p）消息被丢弃', async () => {
    const group = mkP2pMessage();
    group.message!.chat_type = 'group';
    assert.equal(filterIncomingMessage(group), null, '群聊消息应被丢弃');
  });

  // ---------- 群 @ 回执判定（groupMentionChatId） ----------
  await checkAsync('群 @ 回执：群里 @ 机器人返回 chat_id，其余情况不回', async () => {
    const bot = 'ou_bot';
    const mentionBot = mkP2pMessage();
    mentionBot.message!.chat_type = 'group';
    mentionBot.message!.mentions = [{ key: '@_user_1', id: { open_id: bot }, name: '机器人' }];
    assert.equal(groupMentionChatId(mentionBot, bot), 'oc_1', '群里 @ 机器人应回执');

    const mentionOther = mkP2pMessage();
    mentionOther.message!.chat_type = 'group';
    mentionOther.message!.mentions = [{ key: '@_user_1', id: { open_id: 'ou_someone' }, name: '某人' }];
    assert.equal(groupMentionChatId(mentionOther, bot), null, '@ 的是别人不应回执');

    const noMention = mkP2pMessage();
    noMention.message!.chat_type = 'group';
    assert.equal(groupMentionChatId(noMention, bot), null, '群里未 @ 不应回执');

    const p2pMention = mkP2pMessage();
    p2pMention.message!.mentions = [{ key: '@_user_1', id: { open_id: bot } }];
    assert.equal(groupMentionChatId(p2pMention, bot), null, 'p2p 私聊不走群回执');

    assert.equal(groupMentionChatId(mentionBot, ''), null, 'bot open_id 未知时不回执');

    const botSender = mentionBot;
    botSender.sender!.sender_type = 'app';
    assert.equal(groupMentionChatId(botSender, bot), null, 'bot 发送者不回执（防互 @ 死循环）');
  });

  // ---------- 群 @ 回执 24h 冷却（groupMentionInCooldown） ----------
  await checkAsync('群 @ 回执冷却：24h 内跳过，过期后可再回；未知群不在冷却', async () => {
    const replied = new Map<string, number>();
    const t0 = GROUP_MENTION_COOLDOWN_MS * 2;
    assert.equal(groupMentionInCooldown(replied, 'oc_1', t0), false, '未回过的群不在冷却');
    replied.set('oc_1', t0);
    assert.equal(groupMentionInCooldown(replied, 'oc_1', t0 + 1000), true, '24h 内应跳过');
    assert.equal(groupMentionInCooldown(replied, 'oc_1', t0 + GROUP_MENTION_COOLDOWN_MS - 1), true, '冷却边界内应跳过');
    assert.equal(groupMentionInCooldown(replied, 'oc_1', t0 + GROUP_MENTION_COOLDOWN_MS), false, '满 24h 后可再回');
    assert.equal(groupMentionInCooldown(replied, 'oc_2', t0 + 1000), false, '其他群不受影响');
  });

  await checkAsync('filter：bot/系统发送者被忽略，真人放行', async () => {
    for (const senderType of ['app', 'bot', 'anonymous', 'unknown']) {
      const data = mkP2pMessage();
      data.sender!.sender_type = senderType;
      assert.equal(filterIncomingMessage(data), null, `sender_type=${senderType} 应被忽略`);
    }
    // sender_type 缺失视为不可信，同样丢弃（不再按真人放行）
    const noType = mkP2pMessage();
    delete noType.sender!.sender_type;
    assert.equal(filterIncomingMessage(noType), null, 'sender_type 缺失应丢弃');
    // sender 整体缺失同样丢弃
    const noSender = mkP2pMessage();
    delete noSender.sender;
    assert.equal(filterIncomingMessage(noSender), null, 'sender 缺失应丢弃');
  });

  await checkAsync('filter：缺 chat_id / message_id / open_id 的事件被丢弃', async () => {
    const noChat = mkP2pMessage();
    delete noChat.message!.chat_id;
    assert.equal(filterIncomingMessage(noChat), null, '缺 chat_id 应丢弃');
    const noMid = mkP2pMessage();
    delete noMid.message!.message_id;
    assert.equal(filterIncomingMessage(noMid), null, '缺 message_id 应丢弃');
    const noOpenId = mkP2pMessage();
    noOpenId.sender!.sender_id = {};
    assert.equal(filterIncomingMessage(noOpenId), null, '缺 open_id 应丢弃');
    assert.equal(filterIncomingMessage({}), null, '空事件应丢弃');
  });

  await checkAsync('filter：合法 p2p 私聊消息提取出全部字段', async () => {
    const f = filterIncomingMessage(mkP2pMessage());
    assert.ok(f);
    assert.equal(f.chatId, 'oc_1');
    assert.equal(f.messageId, 'om_1');
    assert.equal(f.openId, 'ou_user1');
    assert.equal(f.messageType, 'text');
    const noType = mkP2pMessage();
    delete noType.message!.message_type;
    assert.equal(filterIncomingMessage(noType)!.messageType, 'unknown', '缺 message_type 应回退 unknown');
  });

  // ---------- message_id 去重（含 TTL 上限行为） ----------
  await checkAsync('dedupe：重复投递的 message_id 被去重', async () => {
    const d = createMessageDedupe(60_000);
    assert.equal(d.isDuplicate('om_1', 1000), false, '首次投递应放行');
    assert.equal(d.isDuplicate('om_1', 2000), true, '重复投递应判重');
    assert.equal(d.isDuplicate('om_2', 2000), false, '不同 message_id 应放行');
  });

  await checkAsync('dedupe：TTL 过期条目被 prune 清理后可再次放行（去重表上限）', async () => {
    const d = createMessageDedupe(60_000);
    d.isDuplicate('om_1', 1000);
    // TTL 内 prune 不清条目，仍判重
    d.prune(60_000);
    assert.equal(d.isDuplicate('om_1', 60_000), true, 'TTL 内应仍判重');
    // 超过 TTL 后 prune 清掉条目，同一 id 可再次放行
    d.prune(62_000);
    assert.equal(d.isDuplicate('om_1', 62_000), false, 'TTL 过期清理后应再次放行');
  });

  // ---------- 卡片回调 open_id 白名单 ----------
  await checkAsync('卡片回调：白名单内 open_id 放行，白名单外拒绝', async () => {
    const allowed = ['ou_owner'];
    assert.equal(isCardActionAllowed({ operator: { open_id: 'ou_owner' } }, allowed), true, '白名单内应放行');
    assert.equal(isCardActionAllowed({ operator: { open_id: 'ou_stranger' } }, allowed), false, '白名单外应拒绝');
  });

  await checkAsync('卡片回调：缺 operator / 空 open_id 拒绝（陌生人不得触发 AI 审查）', async () => {
    const allowed = ['ou_owner'];
    assert.equal(isCardActionAllowed({}, allowed), false, '缺 operator 应拒绝');
    assert.equal(isCardActionAllowed({ operator: {} }, allowed), false, '缺 open_id 应拒绝');
    assert.equal(isCardActionAllowed({ operator: { open_id: '' } }, allowed), false, '空 open_id 应拒绝');
  });

  // ---------- 接入判定：白名单 / owner 认领 / fail-closed ----------
  await checkAsync('access：白名单内用户放行，名单外拒绝', async () => {
    const access = createAccessChecker(['ou_owner']);
    const blocked = new Set<string>();
    const allow = resolveAccess(access, blocked, 'ou_owner', { persistClaim: () => true });
    assert.equal(allow.decision, 'allow');
    assert.equal(allow.claimed, false, '已配置白名单不应触发认领');
    const deny = resolveAccess(access, blocked, 'ou_stranger', { persistClaim: () => true });
    assert.equal(deny.decision, 'deny');
    assert.equal(deny.claimed, false);
  });

  await checkAsync('access：空白名单首个用户认领成功并放行，之后名单外用户拒绝', async () => {
    const access = createAccessChecker([]);
    const blocked = new Set<string>();
    const first = resolveAccess(access, blocked, 'ou_first', { persistClaim: () => true });
    assert.equal(first.decision, 'allow');
    assert.equal(first.claimed, true, '首个用户应触发认领');
    assert.equal(first.claimRevoked, false);
    assert.deepEqual(access.list(), ['ou_first'], '认领后应进入白名单');
    const second = resolveAccess(access, blocked, 'ou_second', { persistClaim: () => true });
    assert.equal(second.decision, 'deny', '认领完成后其他用户应拒绝');
    assert.equal(second.claimed, false);
  });

  await checkAsync('access：认领未持久化（返回 false）fail-closed 撤销并阻断', async () => {
    const access = createAccessChecker([]);
    const blocked = new Set<string>();
    const r = resolveAccess(access, blocked, 'ou_first', { persistClaim: () => false });
    assert.equal(r.decision, 'deny', '未持久化应拒绝');
    assert.equal(r.claimed, true);
    assert.equal(r.claimRevoked, true, '应撤销内存放行');
    assert.deepEqual(access.list(), [], '撤销后白名单应为空');
    assert.ok(blocked.has('ou_first'), '应加入阻断集');
    // 阻断集中的用户即使之后出现在白名单语义下也一律拒绝
    const again = resolveAccess(access, blocked, 'ou_first', { persistClaim: () => true });
    assert.equal(again.decision, 'deny', '阻断集中的用户应始终拒绝');
  });

  await checkAsync('access：认领 hook 抛异常同样 fail-closed，并回报错误文案', async () => {
    const access = createAccessChecker([]);
    const blocked = new Set<string>();
    const errors: string[] = [];
    const r = resolveAccess(access, blocked, 'ou_first', {
      persistClaim: () => {
        throw new Error('disk full');
      },
      onClaimError: (msg) => errors.push(msg),
    });
    assert.equal(r.decision, 'deny', 'hook 抛错应拒绝');
    assert.equal(r.claimRevoked, true, 'hook 抛错应撤销放行');
    assert.deepEqual(access.list(), [], '撤销后白名单应为空');
    assert.ok(blocked.has('ou_first'), '应加入阻断集');
    assert.deepEqual(errors, ['disk full'], '应回报 hook 错误文案');
  });

  await checkAsync('access：阻断集超 1000 上限时整体清空（无界增长防护）', async () => {
    const access = createAccessChecker([]);
    const blocked = new Set<string>();
    for (let i = 0; i < 1000; i++) blocked.add(`ou_old${i}`);
    const r = resolveAccess(access, blocked, 'ou_new', { persistClaim: () => false });
    assert.equal(r.claimRevoked, true);
    assert.equal(blocked.size, 1, '超上限应整体清空后仅保留新条目');
    assert.ok(blocked.has('ou_new'));
    assert.ok(!blocked.has('ou_old0'), '老条目应被清空');
  });

  // ---------- 群 @ 回执冷却竞态（maybeReplyGroupMention）：并发同群 @ 只发一条；失败回补可重试 ----------
  type GroupMentioner = { maybeReplyGroupMention: (d: FeishuReceivePayload) => Promise<void> };
  const mkGroupMention = (): FeishuReceivePayload => {
    const data = mkP2pMessage();
    data.message!.chat_type = 'group';
    data.message!.mentions = [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '机器人' }];
    return data;
  };
  /** stub 飞书 client（与 unit-bot 同一收窄手法）：bot open_id 固定 ou_bot，发消息行为由调用方定制。 */
  const stubChannelClient = (
    ch: FeishuChannel,
    create: () => Promise<{ code: number; msg?: string; data?: { message_id: string } }>,
  ): void => {
    (ch as unknown as { client: unknown }).client = {
      request: async () => ({ bot: { open_id: 'ou_bot' } }),
      im: { v1: { message: { create } } },
    };
  };

  await checkAsync('群 @ 回执：并发同群 @ 事件只发一条指引（冷却先写后发）', async () => {
    const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] });
    let sent = 0;
    let releaseFirst!: () => void;
    const firstHang = new Promise<void>((r) => (releaseFirst = r));
    stubChannelClient(ch, async () => {
      sent++;
      if (sent === 1) await firstHang; // 第一条挂在发送窗口里，制造并发
      return { code: 0, data: { message_id: `m-${sent}` } };
    });
    const mention = (ch as unknown as GroupMentioner).maybeReplyGroupMention.bind(ch);
    const p1 = mention(mkGroupMention());
    await new Promise((r) => setTimeout(r, 20)); // 等第一条进入 sendText 挂起
    const p2 = mention(mkGroupMention());
    releaseFirst();
    await Promise.all([p1, p2]);
    assert.equal(sent, 1, '并发同群 @ 应只发一条指引');
  });

  await checkAsync('群 @ 回执：发送失败回补冷却额度，下个群事件可重试', async () => {
    const origWarn = console.warn;
    console.warn = () => {}; // 发送失败会记日志，测试期间静音
    try {
      const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: [] });
      let sent = 0;
      let fail = true;
      stubChannelClient(ch, async () => {
        if (fail) return { code: 500, msg: 'boom' };
        sent++;
        return { code: 0, data: { message_id: `m-${sent}` } };
      });
      const mention = (ch as unknown as GroupMentioner).maybeReplyGroupMention.bind(ch);
      await mention(mkGroupMention()); // 发送失败：不占冷却
      assert.equal(sent, 0);
      fail = false;
      await mention(mkGroupMention()); // 失败已回补：重试成功
      assert.equal(sent, 1, '失败回补后下个事件应可重试发送');
      await mention(mkGroupMention()); // 成功后冷却期内不再发
      assert.equal(sent, 1, '成功后冷却期内应跳过');
    } finally {
      console.warn = origWarn;
    }
  });

  finish();
}

void main();
