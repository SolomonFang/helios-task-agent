/**
 * 进度占位消息与最终回复投递（自 handler.ts 抽出）：
 * 占位优先发进度卡片（步骤轨迹 + 「⏹ 停止」按钮），sendCard 失败降级为纯文本「⏳ 处理中…」；
 * 随工具调用节流更新、静默期心跳刷新、完成时原地替换为结果卡片/最终回复
 * （超长自动拆分续发；轮次内插卡片等独立消息时改发新消息保持时间线顺序）。
 * 卡片模式由内部轨迹表（cardTracks）记录，对外的占位 id 字符串签名不变。
 */

import { splitText, type FeishuChannel } from '../channels/feishu';
import { toolActionLabel } from '../commands';
import type { InboundMessage, ProgressInfo } from '../types';
import { errMessage } from '../infra/err';
import {
  RESULT_CARD_MAX_BYTES,
  buildProgressCard,
  buildProgressTerminalCard,
  buildResultCard,
} from './cards';

/** 占位/投递实际用到的 channel 方法子集（fake channel 单测同样满足）。 */
export type ProgressChannel = Pick<FeishuChannel, 'sendText' | 'updateText' | 'reply' | 'sendCard' | 'updateCard'>;

export interface ProgressKitDeps {
  channel: ProgressChannel;
  /** 静默期心跳间隔（测试注入缩短；默认 PROGRESS_HEARTBEAT_MS 由 handler 传入）。 */
  heartbeatMs: number;
  /** 写操作确认挂起查询（心跳文案分支）：返回挂起确认的展示形态（confirm.pendingForm），无挂起返回 null；挂起期间实际在等用户裁决，「仍在处理」是谎称。 */
  hasPendingConfirm: (openId: string) => { hasCard: boolean; batchKey: boolean } | null;
}

export interface ProgressKit {
  /** 进度占位消息：发送失败仅记日志，最终回复回退 reply 直发。 */
  sendPlaceholder: (msg: InboundMessage) => Promise<string | undefined>;
  /** 进度反馈：占位消息随工具调用节流更新（飞书消息更新限流，2 秒内合并）；activity 供静默期心跳判断。 */
  createProgressReporter: (
    progressId: string | undefined,
    activity: { lastEventAt: number },
  ) => (info: ProgressInfo) => void;
  /**
   * 静默期心跳：LLM 长思考期间没有任何工具事件，占位消息原地不动，用户分不清「在想」还是「死了」。
   * 每 intervalMs 检查一次，静默超阈值则刷新占位并附已等待秒数；回复就绪即停（clearHeartbeat 在投递前调用）。
   */
  startProgressHeartbeat: (
    progressId: string | undefined,
    activity: { lastEventAt: number },
    openId: string,
  ) => () => void;
  /** 最终回复投递：有占位消息则替换之（超长自动拆分续发），占位缺失时回退 reply。 */
  deliverReply: (
    msg: InboundMessage,
    progressId: string | undefined,
    reply: string,
    interleaved?: boolean,
  ) => Promise<void>;
  /** 轮次中断收尾（/stop 与进度卡片「⏹ 停止」共用）：卡片模式换「已中断」终态卡片，文本模式保持原文案（失败回退 reply）。 */
  finalizeAborted: (progressId: string | undefined, msg: InboundMessage, text: string) => Promise<void>;
  /** 轮次失败收尾：卡片模式换「处理失败」终态卡片，文本模式保持「详见下方」文案（失败详情由调用方另行投递）。 */
  finalizeFailed: (progressId: string | undefined) => Promise<void>;
  /** 卡片模式占位是否存活且未收尾（hta_stop 轮次令牌校验用；文本占位/已终态返回 false）。 */
  isActiveProgress: (progressId: string) => boolean;
  /** 卡片模式占位是否已收尾（结果/中断/失败已落地；hta_stop 据此区分「竞态点击只 toast」与「陈旧卡片收终态」）。 */
  isSettledProgress: (progressId: string) => boolean;
}

/** 卡片模式占位的内部轨迹：步骤（心跳/收尾据此重渲染卡片）与起始时间（结果卡片总用时）。 */
interface CardTrack {
  steps: string[];
  current?: string;
  startedAt: number;
  /**
   * 该占位的更新链：心跳/节流的 updateCard 都是 fire-and-forget，REST 到达顺序无保证，
   * 终态（结果卡/中断卡）可能被晚到的心跳覆盖且永不恢复——非终态更新一律入链保序，
   * 终态发送前 await 排空（见 settleCard）。
   */
  chain: Promise<void>;
  /** 终态已发：此后心跳/节流不再入链（往已完成的卡片上刷「处理中」是倒退）。 */
  settled: boolean;
  /** 终态落地时间：settled 轨迹按 TTL 保留（见 SETTLED_TRACK_TTL_MS），供陈旧停止按钮判定。 */
  settledAt?: number;
}

/**
 * settled 轨迹的保留时长：须长过「结果卡已发出但客户端未重渲染，用户点了停止按钮 → 回调到达」
 * 的网络在途。若无差别立即清理，回调到达时 isSettledProgress 查无、落入 stale 分支同步换卡，
 * 会把刚投递的结果卡覆盖成「该轮次已结束」（答案被销毁）。
 */
const SETTLED_TRACK_TTL_MS = 60_000;

export function createProgressKit(deps: ProgressKitDeps): ProgressKit {
  const { channel, heartbeatMs, hasPendingConfirm } = deps;
  /** 占位 id → 卡片轨迹：在表即卡片模式（sendCard 成功）；文本占位不在表，全程走原文案路径。 */
  const cardTracks = new Map<string, CardTrack>();

  /** 非终态卡片更新入该占位的更新链（fire-and-forget 但保序，见 CardTrack.chain）；已收尾的占位不再更新。 */
  const enqueueCardUpdate = (progressId: string, card: Record<string, unknown>): void => {
    const track = cardTracks.get(progressId);
    if (!track || track.settled) return;
    track.chain = track.chain.then(() => channel.updateCard(progressId, card)).catch(() => {});
  };

  /** 卡片模式终态发送前置：标记 settled（心跳/节流即刻停更）并排空在途更新链，保证终态最后到达。 */
  const settleCard = async (progressId: string): Promise<boolean> => {
    const track = cardTracks.get(progressId);
    if (!track) return false;
    track.settled = true;
    track.settledAt = Date.now();
    await track.chain;
    return true;
  };

  const sendPlaceholder = async (msg: InboundMessage): Promise<string | undefined> => {
    // settled 轨迹按 TTL 保留（陈旧停止按钮判定用，见 SETTLED_TRACK_TTL_MS），这里只清超期条目
    const now = Date.now();
    for (const [id, t] of cardTracks) {
      if (t.settled && now - (t.settledAt ?? 0) > SETTLED_TRACK_TTL_MS) cardTracks.delete(id);
    }
    // 卡片占位优先：步骤轨迹可视化 + 「⏹ 停止」按钮；发送失败（或未取得 message id）降级为旧文本占位
    try {
      const cardId = await channel.sendCard(msg.sessionId, buildProgressCard({ steps: [] }));
      if (cardId) {
        cardTracks.set(cardId, { steps: [], startedAt: Date.now(), chain: Promise.resolve(), settled: false });
        // 停止按钮的轮次令牌就是占位消息 id（发送后才能拿到）：补一次带令牌的更新；
        // 失败则本轮停止按钮不可用（点击落入令牌不匹配分支，不会误伤），进度展示不受影响
        await channel
          .updateCard(cardId, buildProgressCard({ steps: [], stopToken: cardId }))
          .catch((err) => console.error(`[feishu] 占位卡片令牌注入失败（本轮停止按钮不可用）: ${errMessage(err)}`));
        return cardId;
      }
    } catch (err) {
      console.error(`[feishu] 占位卡片发送失败，降级文本占位: ${errMessage(err)}`);
    }
    try {
      return await channel.sendText(msg.sessionId, '⏳ 处理中…');
    } catch (err) {
      const message = errMessage(err);
      console.error(`[feishu] 占位消息发送失败: ${message}`);
      return undefined;
    }
  };

  const createProgressReporter = (
    progressId: string | undefined,
    activity: { lastEventAt: number },
  ): ((info: ProgressInfo) => void) => {
    let lastPush = 0;
    return (info: ProgressInfo) => {
      activity.lastEventAt = Date.now();
      if (!progressId) return;
      const track = cardTracks.get(progressId);
      if (track) {
        // 思考事件不改变卡片内容（卡片已呈加载态），不浪费更新额度
        if (info.type !== 'tool') return;
        // 步骤轨迹：新工具事件把上一个「当前步骤」归入已完成（卡片内只展示最近几步）
        if (track.current) track.steps.push(track.current);
        track.current = toolActionLabel(info.name);
        const now = activity.lastEventAt;
        if (now - lastPush < 2000) return; // 飞书消息更新限流
        lastPush = now;
        enqueueCardUpdate(progressId, buildProgressCard({ steps: track.steps, current: track.current, stopToken: progressId }));
        return;
      }
      const now = activity.lastEventAt;
      if (now - lastPush < 2000) return; // 飞书消息更新限流
      lastPush = now;
      const text = info.type === 'tool' ? `⏳ 处理中…（${toolActionLabel(info.name)}）` : '⏳ 思考中…';
      void channel.updateText(progressId, text).catch(() => {});
    };
  };

  const startProgressHeartbeat = (
    progressId: string | undefined,
    activity: { lastEventAt: number },
    openId: string,
  ): (() => void) => {
    if (!progressId) return () => {};
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - activity.lastEventAt < heartbeatMs) return;
      const track = cardTracks.get(progressId);
      // 确认挂起期间实际在等用户裁决：换 waitingConfirm 橙头变体（蓝头「处理中」是谎称）；
      // 指引按确认实际形态分支（文本降级不提按钮，支持免问补应答词），/stop 中断两条路径都保留
      const confirmForm = hasPendingConfirm(openId);
      if (track) {
        enqueueCardUpdate(
          progressId,
          buildProgressCard({
            steps: track.steps,
            current: track.current,
            elapsedSec: Math.round((Date.now() - startedAt) / 1000),
            waitingConfirm: confirmForm ?? undefined,
            stopToken: progressId,
          }),
        );
        return;
      }
      const text = confirmForm
        ? confirmForm.hasCard
          ? `⏳ 等待你处理上方的写操作确认…（点卡片按钮或回复${confirmForm.batchKey ? '「确认」/「取消」/「免问」' : '「确认」/「取消」'}；回复 /stop 可中断）`
          : `⏳ 等待你回复写操作确认（${confirmForm.batchKey ? '「确认」/「取消」/「免问」' : '「确认」/「取消」'}；回复 /stop 可中断）…`
        : `⏳ 仍在处理…（已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒；/stop 可中断）`;
      void channel.updateText(progressId, text).catch(() => {});
    }, heartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  };

  const deliverReply = async (
    msg: InboundMessage,
    progressId: string | undefined,
    reply: string,
    interleaved = false,
  ): Promise<void> => {
    const text = reply || '（无回复）';
    const chunks = splitText(text);
    const track = progressId ? cardTracks.get(progressId) : undefined;

    if (progressId && (interleaved || (track !== undefined && Buffer.byteLength(text, 'utf8') > RESULT_CARD_MAX_BYTES))) {
      // 占位无法承载正文的两类情况：轮次中插入了确认卡片等独立消息（原地改会时序颠倒）、
      // 或卡片模式下超长（超 RESULT_CARD_MAX_BYTES 不进卡片，飞书卡片请求体体积上限按字节计）。
      // 占位收尾为短终态（中性措辞：正文可能是「已中止」等，不宜恒称「已完成」），正文另发新消息落在时间线末尾（分段各自兜底）。
      if (track) {
        await settleCard(progressId);
        await channel
          .updateCard(progressId, buildProgressTerminalCard('seeBelow'))
          .catch((err) => console.error(`[feishu] 占位收尾更新失败: ${errMessage(err)}`));
      } else {
        await channel
          .updateText(progressId, '处理结束，结果见下方 ⬇️')
          .catch((err) => console.error(`[feishu] 占位收尾更新失败: ${errMessage(err)}`));
      }
      let chunkFailed = false;
      for (const chunk of chunks) {
        try {
          await channel.sendText(msg.sessionId, chunk);
        } catch (err) {
          chunkFailed = true;
          console.error(`[feishu] 回复分段失败（后续分段继续投递）: ${errMessage(err)}`);
        }
      }
      if (chunkFailed) {
        await channel
          .sendText(msg.sessionId, '⚠️ 上方回复有部分内容发送失败，可能不完整，可再问一次。')
          .catch((err) => console.error(`[feishu] 分段失败提示也未送达: ${errMessage(err)}`));
      }
      return;
    }

    if (progressId && track) {
      // 卡片模式短回复：原地换结果卡片（lark_md 渲染），一条卡片承载全部内容、不再分段；
      // 先发终态前排空更新链：在途的心跳/节流更新若晚到会把结果卡刷回「处理中」
      await settleCard(progressId);
      try {
        await channel.updateCard(
          progressId,
          buildResultCard(text, { elapsedSec: Math.round((Date.now() - track.startedAt) / 1000) }),
        );
        return;
      } catch (err) {
        console.error(`[feishu] 结果卡片更新失败，降级为文本投递: ${errMessage(err)}`);
      }
      // 降级链同文本模式口径：首段直发 + 占位 best-effort 收尾为终态（占位是卡片，收尾也用卡片），
      // 续发分段逐段独立兜底；首段也失败则把占位卡片收尾为投递失败终态（下方什么都没有，不得谎称「见下方」）
      let firstDelivered = false;
      try {
        await channel.sendText(msg.sessionId, chunks[0]!);
        firstDelivered = true;
        await channel.updateCard(progressId, buildProgressTerminalCard('seeBelow')).catch(() => {});
      } catch (err2) {
        console.error(`[feishu] 首段直接发送也失败: ${errMessage(err2)}`);
      }
      let chunkFailed = false;
      for (const chunk of chunks.slice(1)) {
        try {
          await channel.sendText(msg.sessionId, chunk);
        } catch (err) {
          chunkFailed = true;
          console.error(`[feishu] 回复续发分段失败（后续分段继续投递）: ${errMessage(err)}`);
        }
      }
      if (chunkFailed) {
        await channel
          .sendText(msg.sessionId, '⚠️ 上方回复有部分内容发送失败，可能不完整，可再问一次。')
          .catch((err) => console.error(`[feishu] 分段失败提示也未送达: ${errMessage(err)}`));
      }
      if (!firstDelivered) {
        await channel.updateCard(progressId, buildProgressTerminalCard('deliverFailed')).catch(() => {});
      }
      return;
    }

    if (progressId) {
      let firstDelivered = false;
      try {
        await channel.updateText(progressId, chunks[0]!);
        firstDelivered = true;
      } catch (err) {
        console.error(`[feishu] 首段更新占位消息失败，尝试直接发送: ${errMessage(err)}`);
        try {
          await channel.sendText(msg.sessionId, chunks[0]!);
          firstDelivered = true;
          // 直发兜底成功：占位还停在「⏳ 处理中…」（心跳已清不再刷新），best-effort 收尾为终态；
          // 措辞中性（与 seeBelow 终态卡片同口径）：正文可能是「（无回复）」等非成功内容，不恒称「已完成」
          await channel.updateText(progressId, '处理结束，结果见下方 ⬇️').catch(() => {});
        } catch (err2) {
          console.error(`[feishu] 首段直接发送也失败: ${errMessage(err2)}`);
        }
      }
      // 续发逐段独立兜底：一段失败记日志继续发后续段，不再让剩余段静默丢失；
      // 任一段失败后最后补发一条提示，否则用户拿到残文却不知情
      let chunkFailed = false;
      for (const chunk of chunks.slice(1)) {
        try {
          await channel.sendText(msg.sessionId, chunk);
        } catch (err) {
          chunkFailed = true;
          console.error(`[feishu] 回复续发分段失败（后续分段继续投递）: ${errMessage(err)}`);
        }
      }
      if (chunkFailed) {
        await channel
          .sendText(msg.sessionId, '⚠️ 上方回复有部分内容发送失败，可能不完整，可再问一次。')
          .catch((err) => console.error(`[feishu] 分段失败提示也未送达: ${errMessage(err)}`));
      }
      if (!firstDelivered) {
        // 首段彻底失败：占位消息还停在「处理中」，尽量更新为失败提示，别让用户干等
        await channel.updateText(progressId, '⚠️ 回复投递失败，请把刚才的问题再发一次。').catch(() => {});
      }
    } else {
      await channel.reply(msg, text);
    }
  };

  const finalizeAborted = async (
    progressId: string | undefined,
    msg: InboundMessage,
    text: string,
  ): Promise<void> => {
    // 缺 progressId（占位发送失败）时不再 reply 兜底：中断回执由 /stop 的 reply / 停止按钮的 toast 承担，
    // abort 必经 stopUserWork，这里再投递几乎必然重复
    if (!progressId) return;
    if (await settleCard(progressId)) {
      // 卡片占位：换「已中断」终态卡片（停止按钮随之消失）；更新失败回退文本 reply
      await channel
        .updateCard(progressId, buildProgressTerminalCard('aborted'))
        .catch(() => channel.reply(msg, text).catch(() => {}));
      return;
    }
    await channel.updateText(progressId, text).catch(() => channel.reply(msg, text).catch(() => {}));
  };

  const finalizeFailed = async (progressId: string | undefined): Promise<void> => {
    // 无 progressId 时无需动作：调用方随后会 reply 失败详情（用户面不静默）
    if (!progressId) return;
    if (await settleCard(progressId)) {
      await channel.updateCard(progressId, buildProgressTerminalCard('failed')).catch(() => {});
      return;
    }
    await channel.updateText(progressId, '⚠️ 处理失败，详见下方').catch(() => {});
  };

  const isActiveProgress = (progressId: string): boolean => {
    const t = cardTracks.get(progressId);
    return Boolean(t && !t.settled);
  };

  // 只认 TTL 内的 settled 条目：超期条目等同查无（hta_stop 落入 stale 分支收终态，语义一致）
  const isSettledProgress = (progressId: string): boolean => {
    const t = cardTracks.get(progressId);
    return Boolean(t?.settled && Date.now() - (t.settledAt ?? 0) <= SETTLED_TRACK_TTL_MS);
  };

  return {
    sendPlaceholder,
    createProgressReporter,
    startProgressHeartbeat,
    deliverReply,
    finalizeAborted,
    finalizeFailed,
    isActiveProgress,
    isSettledProgress,
  };
}
