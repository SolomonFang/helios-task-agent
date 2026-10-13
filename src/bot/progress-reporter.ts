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
  BATCH_ACTIVE_NOTE,
  RESULT_CARD_MAX_BYTES,
  buildProgressCard,
  buildProgressTerminalCard,
  buildResultCard,
  progressMainText,
} from './cards';

/** 占位/投递实际用到的 channel 方法子集（fake channel 单测同样满足）。 */
export type ProgressChannel = Pick<
  FeishuChannel,
  | 'sendText'
  | 'updateText'
  | 'reply'
  | 'sendCard'
  | 'updateCard'
  | 'createCardEntity'
  | 'sendCardEntity'
  | 'updateCardEntity'
  | 'streamCardElement'
  | 'setCardStreaming'
>;

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
  /** 最终回复投递：有占位消息则替换之（超长自动拆分续发），占位缺失时回退 reply。resultUrl 提供时结果卡片带「📋 查看任务」跳转按钮。 */
  deliverReply: (
    msg: InboundMessage,
    progressId: string | undefined,
    reply: string,
    interleaved?: boolean,
    resultUrl?: string,
  ) => Promise<void>;
  /** 轮次中断收尾（/stop 与进度卡片「⏹ 停止」共用）：卡片模式换「已中断」终态卡片，文本模式保持原文案（失败回退 reply）。 */
  finalizeAborted: (progressId: string | undefined, msg: InboundMessage, text: string) => Promise<void>;
  /** 轮次失败收尾：卡片模式换「处理失败」终态卡片，文本模式保持「详见下方」文案（失败详情由调用方另行投递）。 */
  finalizeFailed: (progressId: string | undefined) => Promise<void>;
  /** 卡片模式占位是否存活且未收尾（hta_stop 轮次令牌校验用；文本占位/已终态返回 false）。 */
  isActiveProgress: (progressId: string) => boolean;
  /** 卡片模式占位是否已收尾（结果/中断/失败已落地；hta_stop 据此区分「竞态点击只 toast」与「陈旧卡片收终态」）。 */
  isSettledProgress: (progressId: string) => boolean;
  /** 写操作确认占用卡片：held 期间节流/心跳更新跳过（确认按钮不能被进度刷新覆盖）。 */
  holdCard: (progressId: string) => void;
  /** 确认终态后解除占用（批准/拒绝/超时/作废/中断各路径都要调到）。 */
  releaseCard: (progressId: string) => void;
  /** 确认占用期间的卡片绘制（确认卡/确认终态卡）：不受 held 拦截，入有序链保序；reject = 绘制失败（调用方降级）。 */
  paintConfirm: (progressId: string, card: Record<string, unknown>) => Promise<void>;
  /** 按轨迹当前步骤构建进度卡（确认批准后的同步换卡用）；轨迹不存在（文本占位等）返回 undefined。
   *  noteOverride 传入时（文本裁决的免问批准路径）在轨迹上记录批次标记，后续重建与结果卡注脚持续携带撤销指引。 */
  progressSnapshot: (progressId: string, currentLabel?: string, noteOverride?: string) => Record<string, unknown> | undefined;
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
  /**
   * 卡片被写操作确认占用（确认卡片原地画在进度卡上）：held 期间节流/心跳的非终态更新
   * 一律跳过——否则会覆盖掉确认按钮。确认绘制走 paintConfirm（不受 held 拦截），
   * 确认终态（批准/拒绝/超时/作废/中断）时由 bot 层 releaseCard 解除。
   */
  held?: boolean;
  /**
   * 卡片传输模式：cardkit = 卡片实体 + 流式更新（打字机动画，sequence 单调递增）；
   * message = 消息级整卡更新（CardKit 不可用时的降级，无动画）。
   */
  transport: 'cardkit' | 'message';
  /** CardKit 实体 id（cardkit 模式必有；卡片更新/流式/settings 都按 card_id 寻址）。 */
  cardId?: string;
  /** CardKit 更新序号（create 不计；update/content/settings 单调递增）。 */
  seq: number;
  /**
   * cardkit 模式：确认卡/终态卡整卡覆盖后，实体上的 hta_main 锚点与流式态已被替换；
   * 下一次进度更新必须整卡刷新（恢复 streaming 配置与锚点），不能走 streamCardElement。
   */
  needFullRefresh?: boolean;
  /**
   * 免问批准生效标记（文本裁决的 batch 路径经 progressSnapshot 的 noteOverride 记入）：
   * 批准时的 toast 只停留几秒，免问生效期间进度卡重建与结果卡注脚持续携带撤销指引（BATCH_ACTIVE_NOTE）。
   */
  batchActive?: boolean;
  /**
   * cardkit 模式最近一次流式推送的 hta_main 文本：步骤轨迹只展示最近几步，窗口滑动后
   * 新文本不再是旧文本的前缀扩展（打字机流式不变量被破坏），此时回退整卡更新。
   */
  streamedMain?: string;
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

  /** 整卡更新按传输模式分发：cardkit 走实体更新（sequence 递增），message 走消息更新。 */
  const applyCard = (track: CardTrack, progressId: string, card: Record<string, unknown>): Promise<void> =>
    track.transport === 'cardkit' && track.cardId
      ? channel.updateCardEntity(track.cardId, card, ++track.seq)
      : channel.updateCard(progressId, card);

  /** 非终态卡片更新入该占位的更新链（fire-and-forget 但保序，见 CardTrack.chain）；已收尾或被确认占用的占位不再更新。 */
  const enqueueCardUpdate = (progressId: string, card: Record<string, unknown>): void => {
    const track = cardTracks.get(progressId);
    if (!track || track.settled || track.held) return;
    track.chain = track.chain.then(() => applyCard(track, progressId, card)).catch(() => {});
  };

  /**
   * 进度步骤的流式文本更新（仅 cardkit 模式）：hta_main 元素全量文本，前缀扩展部分呈打字机动画；
   * message 模式回退整卡更新。步骤轨迹只展示最近几步，窗口滑动后新文本不再是旧文本的前缀扩展，
   * 同样回退整卡更新（与 needFullRefresh 同路）。入有序链、fire-and-forget（held/settled 跳过）。
   */
  const enqueueStepsStream = (progressId: string): void => {
    const track = cardTracks.get(progressId);
    if (!track || track.settled || track.held) return;
    const content = progressMainText({ steps: track.steps, current: track.current });
    if (
      track.transport === 'cardkit' &&
      track.cardId &&
      !track.needFullRefresh &&
      (!track.streamedMain || content.startsWith(track.streamedMain))
    ) {
      const cardId = track.cardId;
      track.streamedMain = content;
      track.chain = track.chain.then(() => channel.streamCardElement(cardId, 'hta_main', content, ++track.seq)).catch(() => {});
      return;
    }
    // 确认/终态整卡覆盖或步骤窗口滑动后的首次进度更新：整卡刷新恢复流式配置与 hta_main 锚点；
    // 免问生效期间注脚持续携带撤销指引（批次标记见 track.batchActive）
    track.needFullRefresh = false;
    track.streamedMain = content;
    enqueueCardUpdate(
      progressId,
      buildProgressCard({
        steps: track.steps,
        current: track.current,
        stopToken: progressId,
        noteOverride: track.batchActive ? `${BATCH_ACTIVE_NOTE} · 回复 /stop 也可中断` : undefined,
      }),
    );
  };

  /**
   * 确认占用期间的卡片绘制（确认卡/确认终态卡）：不受 held 拦截，仍入有序链保证与后续结果卡的先后顺序。
   * 返回的 Promise 暴露本次绘制的真实成败（确认卡画失败时调用方要降级独立卡片/文本）；
   * 链本体永不 reject（失败不阻断后续进度/结果更新）。
   */
  const paintConfirm = (progressId: string, card: Record<string, unknown>): Promise<void> => {
    const track = cardTracks.get(progressId);
    if (!track || track.settled) return Promise.resolve();
    // 确认/终态卡不含 hta_main 锚点与流式配置：整卡覆盖后标记，下一次进度更新强制整卡刷新恢复
    if (track.transport === 'cardkit') track.needFullRefresh = true;
    const painted = track.chain.then(() => applyCard(track, progressId, card));
    track.chain = painted.catch(() => {});
    return painted;
  };

  const holdCard = (progressId: string): void => {
    const track = cardTracks.get(progressId);
    if (track && !track.settled) track.held = true;
  };

  const releaseCard = (progressId: string): void => {
    const track = cardTracks.get(progressId);
    if (track) track.held = false;
  };

  /** 按轨迹当前步骤构建进度卡（确认批准后的同步换卡用）；轨迹不存在（文本占位等）返回 undefined。 */
  const progressSnapshot = (progressId: string, currentLabel?: string, noteOverride?: string): Record<string, unknown> | undefined => {
    const track = cardTracks.get(progressId);
    if (!track || track.settled) return undefined;
    // noteOverride 的唯一来源是文本裁决的免问批准路径（handler）：记入轨迹，后续重建与结果卡持续携带撤销指引
    if (noteOverride !== undefined) track.batchActive = true;
    return buildProgressCard({
      steps: track.steps,
      current: currentLabel ?? track.current,
      elapsedSec: Math.round((Date.now() - track.startedAt) / 1000),
      stopToken: progressId,
      noteOverride,
    });
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

  /**
   * 终态卡片绘制（结果/中断/失败/seeBelow 共用）：先 settle 排空在途更新；
   * cardkit 模式先关流式（会话预览从「生成中」恢复为正文；终态卡 JSON 不含 streaming 配置，双保险）。
   * reject 供调用方走既有降级（文本直发/reply 兜底）。
   */
  const paintTerminal = async (progressId: string, card: Record<string, unknown>): Promise<void> => {
    const track = cardTracks.get(progressId);
    if (!track) throw new Error('paintTerminal: 非卡片占位');
    await settleCard(progressId);
    if (track.transport === 'cardkit' && track.cardId) {
      await channel
        .setCardStreaming(track.cardId, false, ++track.seq)
        .catch((err) => console.error(`[feishu] 关闭卡片流式模式失败（继续收尾）: ${errMessage(err)}`));
      await channel.updateCardEntity(track.cardId, card, ++track.seq);
      return;
    }
    await channel.updateCard(progressId, card);
  };

  const sendPlaceholder = async (msg: InboundMessage): Promise<string | undefined> => {
    // settled 轨迹按 TTL 保留（陈旧停止按钮判定用，见 SETTLED_TRACK_TTL_MS），这里只清超期条目
    const now = Date.now();
    for (const [id, t] of cardTracks) {
      if (t.settled && now - (t.settledAt ?? 0) > SETTLED_TRACK_TTL_MS) cardTracks.delete(id);
    }
    // 优先 CardKit 流式卡片（打字机动画）：建实体 → 发消息引用实体 → 整卡更新注入停止按钮令牌
    //（令牌即 message_id，发送后才能拿到）。任一步失败降级普通卡片（消息传输，无动画）
    try {
      const entityId = await channel.createCardEntity(buildProgressCard({ steps: [] }));
      const messageId = await channel.sendCardEntity(msg.sessionId, entityId);
      // 缺 message_id 按失败处理（走下方降级链）：静默落入普通卡片分支会再发一张占位，双发
      if (!messageId) throw new Error('sendCardEntity 未返回 message_id');
      const track: CardTrack = {
        steps: [],
        startedAt: Date.now(),
        chain: Promise.resolve(),
        settled: false,
        transport: 'cardkit',
        cardId: entityId,
        seq: 0,
      };
      cardTracks.set(messageId, track);
      // 令牌注入失败则本轮停止按钮不可用（点击落入令牌不匹配分支，不会误伤），进度展示不受影响
      track.chain = track.chain
        .then(() => channel.updateCardEntity(entityId, buildProgressCard({ steps: [], stopToken: messageId }), ++track.seq))
        .catch((err) => console.error(`[feishu] 占位卡片令牌注入失败（本轮停止按钮不可用）: ${errMessage(err)}`));
      return messageId;
    } catch (err) {
      console.error(`[feishu] CardKit 流式卡片创建失败，降级普通卡片: ${errMessage(err)}`);
    }
    // 普通卡片占位（消息传输）：步骤轨迹可视化 + 「⏹ 停止」按钮；发送失败降级为旧文本占位
    try {
      const cardId = await channel.sendCard(msg.sessionId, buildProgressCard({ steps: [] }));
      if (cardId) {
        cardTracks.set(cardId, {
          steps: [],
          startedAt: Date.now(),
          chain: Promise.resolve(),
          settled: false,
          transport: 'message',
          seq: 0,
        });
        // 停止按钮的轮次令牌就是占位消息 id（发送后才能拿到）：补一次带令牌的更新
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
        // cardkit 模式流式更新步骤文本（打字机动画）；message 模式整卡更新
        enqueueStepsStream(progressId);
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
            // 免问生效期间注脚持续携带撤销指引；确认挂起时等待指引优先（更紧急，挂起解除后批次注脚随之恢复）
            noteOverride: track.batchActive && !confirmForm ? `${BATCH_ACTIVE_NOTE} · 回复 /stop 也可中断` : undefined,
          }),
        );
        return;
      }
      const text = confirmForm
        ? confirmForm.hasCard
          ? `⏳ 等待你处理下方的写操作确认…（点卡片按钮或回复${confirmForm.batchKey ? '「确认」/「取消」/「免问」' : '「确认」/「取消」'}；回复 /stop 可中断）`
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
    resultUrl?: string,
  ): Promise<void> => {
    const text = reply || '（无回复）';
    const chunks = splitText(text);
    const track = progressId ? cardTracks.get(progressId) : undefined;

    if (progressId && (interleaved || (track !== undefined && Buffer.byteLength(text, 'utf8') > RESULT_CARD_MAX_BYTES))) {
      // 占位无法承载正文的两类情况：轮次中插入了确认卡片等独立消息（原地改会时序颠倒）、
      // 或卡片模式下超长（超 RESULT_CARD_MAX_BYTES 不进卡片，飞书卡片请求体体积上限按字节计）。
      // 占位收尾为短终态（中性措辞：正文可能是「已中止」等，不宜恒称「已完成」），正文另发新消息落在时间线末尾（分段各自兜底）。
      if (track) {
        await paintTerminal(progressId, buildProgressTerminalCard('seeBelow')).catch((err) =>
          console.error(`[feishu] 占位收尾更新失败: ${errMessage(err)}`),
        );
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
      // 卡片模式短回复：原地换结果卡片（markdown 渲染），一条卡片承载全部内容、不再分段；
      // paintTerminal 先发终态前排空更新链（在途的心跳/节流更新若晚到会把结果卡刷回「处理中」），
      // cardkit 模式先关流式再整卡覆盖
      try {
        await paintTerminal(
          progressId,
          buildResultCard(
            text,
            { elapsedSec: Math.round((Date.now() - track.startedAt) / 1000) },
            // 免问生效期间结果卡注脚同样携带撤销指引（批准 toast 只停留几秒，注脚是持久载体）
            { url: resultUrl, extraNote: track.batchActive ? BATCH_ACTIVE_NOTE : undefined },
          ),
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
        await paintTerminal(progressId, buildProgressTerminalCard('seeBelow')).catch(() => {});
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
        await paintTerminal(progressId, buildProgressTerminalCard('deliverFailed')).catch(() => {});
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
    if (cardTracks.has(progressId)) {
      // 卡片占位：换「已中断」终态卡片（停止按钮随之消失；cardkit 模式先关流式）；更新失败回退文本 reply
      await paintTerminal(progressId, buildProgressTerminalCard('aborted')).catch(() =>
        channel.reply(msg, text).catch(() => {}),
      );
      return;
    }
    await channel.updateText(progressId, text).catch(() => channel.reply(msg, text).catch(() => {}));
  };

  const finalizeFailed = async (progressId: string | undefined): Promise<void> => {
    // 无 progressId 时无需动作：调用方随后会 reply 失败详情（用户面不静默）
    if (!progressId) return;
    if (cardTracks.has(progressId)) {
      await paintTerminal(progressId, buildProgressTerminalCard('failed')).catch(() => {});
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
    holdCard,
    releaseCard,
    paintConfirm,
    progressSnapshot,
  };
}
