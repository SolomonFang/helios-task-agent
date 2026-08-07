/**
 * 飞书 bot 消息路由：斜杠命令、写操作确认应答、排队回执、敲键盘表情、
 * AI 审查按钮回调。bootstrap（向导/看板拉起/长连接建立）留在 bot.ts。
 */

import { FeishuChannel, splitText, type FeishuCardAction, type FeishuInboundMessage } from '../channels/feishu';
import { SessionRouter } from '../session-router';
import type { AgentSession } from '../session';
import { ConfirmationManager, isConfirmWord } from '../confirm';
import { runAiReview, ocrWillDeriveBotLlm } from '../kanban/ai-review';
import { isAllPass, writeReviewReport } from '../review-report';
import type { ReportServer } from '../report-server';
import { checkLarkCliAsync, checkOcrCliAsync } from '../deps';
import { wrapUntrusted } from '../guard';
import {
  buildMemoryLines,
  buildStatusLines,
  buildToolsLines,
  CLEARED_TEXT,
  confirmRevokedText,
  confirmStateText,
  handleSkillsCommand,
  llmFailureParts,
  parseCommand,
  plainPaint,
} from '../commands';
import type { AgentConfig, InboundMessage, ProgressInfo } from '../types';
import type { KanbanMcp } from '../kanban/mcp';
import type { McpSupervisor } from './supervisor';
import { MCP_FALLBACK_TEXT } from '../ui';
import { errMessage } from '../err';

/** 卡片按钮回调载荷（确认卡片 / AI 审查）。 */
type CardAction = FeishuCardAction;

/** AI 审查全局并发上限：每个审查是最长 15 分钟的子进程，不同 attempt 叠加会拖垮机器。 */
const AI_REVIEW_MAX_CONCURRENT = 2;

/** 单条用户消息长度上限：超长消息直接拒答，不送入 LLM（上下文爆炸 / 网关 400）。 */
export const MAX_USER_MESSAGE_CHARS = 8000;

/** 表情回执永久性错误判定：权限/能力缺失类错误重试不会自愈，降级禁用；其余（限流/网络抖动）视为瞬时，下条消息再试。 */
const REACTION_PERMANENT_RE = /permission|权限|not.?support|不支持|forbidden|invalid.?emoji/i;

/**
 * AI 审查结果卡片：头部按是否全部通过换色，正文按钮直达本机静态报告页。
 * 纯函数（不含流程与 IO），便于单测与复用。
 */
export function buildAiReviewCard(title: string, url: string, pass: boolean): Record<string, unknown> {
  return {
    header: {
      template: pass ? 'green' : 'blue',
      title: {
        tag: 'plain_text',
        content: pass ? `✅ AI 审查全部通过：《${title}》` : `🤖 AI 审查完成：《${title}》`,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: pass ? '🎉 真棒！本次变更未发现任何问题。' : '审查完成，详细意见见完整报告。',
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📄 查看完整报告' },
            type: 'primary',
            url,
            multi_url: { url, android_url: url, ios_url: url, pc_url: url },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: pass
              ? '已注入会话上下文，可直接继续追问。'
              : '已注入会话上下文，可直接回复「按审查意见修一下」。',
          },
          { tag: 'plain_text', content: '报告链接仅在运行本机器人的电脑上可达，进程重启后失效。' },
        ],
      },
    ],
  };
}

export interface BotHandlerDeps {
  channel: FeishuChannel;
  router: SessionRouter;
  confirmations: ConfirmationManager;
  cfg: AgentConfig;
  mcp: KanbanMcp;
  supervisor: McpSupervisor;
  reportServer: ReportServer | null;
  helpText: string;
}

export interface BotHandlers {
  /** 私聊消息入口（传给 channel.start）。 */
  handle: (msg: InboundMessage) => Promise<void>;
  /** 卡片按钮回调（确认卡片 / AI 审查）。 */
  onCardAction: (action: CardAction) => void;
}

export function createBotHandlers(deps: BotHandlerDeps): BotHandlers {
  const { channel, router, confirmations, cfg, mcp, supervisor, reportServer } = deps;

  /** 每用户当前运行中的 agent 轮次（/stop 中断用）。 */
  const running = new Map<string, AbortController>();
  /** 敲键盘表情回执是否因权限等原因不可用（失败后不再重试，降级为仅占位消息）。 */
  let reactionUnsupported = false;
  /** 每用户尚未移除的敲键盘表情（/stop 丢弃排队消息时回调不会执行，需兜底清理）。 */
  const pendingTyping = new Map<string, { messageId: string; reactionId: string }[]>();
  /** 进行中的 AI 审查（按 attempt 去重，防止连点按钮）；携带发起人与 AbortController，/stop 可中断。 */
  const aiReviewRunning = new Map<string, { openId: string; ctl: AbortController }>();
  /** 首次 AI 审查的 LLM 配置告知是否已发送（每进程一次，避免刷屏）。 */
  let aiReviewLlmNoticed = false;

  /** 执行 AI 审查（open-code-review）并把结果推回飞书；同时注入会话上下文便于追问/修复。 */
  const handleAiReview = async (openId: string, attemptId: string, title: string): Promise<void> => {
    if (aiReviewRunning.has(attemptId)) {
      await channel.notifyOpenId(openId, `🤖 《${title}》的 AI 审查正在进行中，请稍候…`).catch(() => {});
      return;
    }
    // 全局并发上限：超出时拒收并提示稍后再试（按 attempt 去重挡不住不同 attempt 的叠加）
    if (aiReviewRunning.size >= AI_REVIEW_MAX_CONCURRENT) {
      await channel
        .notifyOpenId(openId, `🤖 同时进行的 AI 审查已达上限（${AI_REVIEW_MAX_CONCURRENT} 个），请等现有审查完成后再试：《${title}》`)
        .catch(() => {});
      return;
    }
    const ctl = new AbortController();
    aiReviewRunning.set(attemptId, { openId, ctl });
    try {
      // 首次触发时告知：AI 审查由第三方 open-code-review 执行，且将复用机器人主 LLM 配置
      // （仅在实际会派生主 key 时提示；用户已自配 OCR_LLM_URL / OCR 配置文件则不打扰）
      let llmNotice = '';
      if (!aiReviewLlmNoticed && ocrWillDeriveBotLlm()) {
        aiReviewLlmNoticed = true;
        llmNotice =
          '\n⚠️ 安全提示：AI 审查由第三方工具 open-code-review 执行，将把机器人 LLM 配置（含 API key）以 OCR_LLM_* 环境变量交给它；' +
          '如需隔离，请配置 AI 审查专用 key（OCR_LLM_TOKEN）或用 ocr config provider 单独配置。';
      }
      await channel.notifyOpenId(
        openId,
        `🤖 AI 审查已开始：《${title}》\n正在调用 open-code-review 分析 diff，完成后推送结果（首次使用需自动下载代码审查工具，耗时稍长）。${llmNotice}`,
      );
      // /stop 可中断：竞速胜出后立即向用户收尾返回；signal 同时透传给 runAiReview，
      // 底层 ocr 子进程随 abort 被 execFile 立即 kill，不必等自身 15 分钟超时。
      // （Promise.race 已给 runAiReview 挂上反应，其后续 settle 不会成未处理 rejection。）
      const result = await Promise.race([
        runAiReview({
          kanbanUrl: cfg.kanbanUrl,
          attemptId,
          title,
          llm: { baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, model: cfg.llmModel },
          signal: ctl.signal,
        }),
        new Promise<never>((_, reject) => {
          ctl.signal.addEventListener('abort', () => reject(new Error('已中断')), { once: true });
        }),
      ]);
      if (reportServer) {
        // 完整结果写入 HTML 报告，飞书推卡片（按钮直达静态报告页，进程存活期间有效）
        const name = writeReviewReport({
          title,
          attemptId,
          generatedAt: new Date().toLocaleString('zh-CN'),
          text: result,
        });
        const url = `${reportServer.baseUrl}/${name}`;
        await channel.notifyCardOpenId(openId, buildAiReviewCard(title, url, isAllPass(result)));
      } else {
        await channel.notifyOpenId(openId, `🤖 AI 审查结果：《${title}》\n${result}`);
      }
      // 注入会话：用户追问「按审查意见修一下」时 agent 有上下文
      // （审查结果含被审仓库代码，属外部内容，UNTRUSTED 包裹；注入发生在轮边界）
      try {
        router
          .getOrCreate(openId)
          .injectSystemNote(
            `[AI 审查完成 ${new Date().toLocaleString('zh-CN')}]\n《${title}》\n${wrapUntrusted(result.slice(0, 1500))}`,
          );
      } catch {
        /* ignore */
      }
    } catch (err) {
      if (ctl.signal.aborted) {
        await channel.notifyOpenId(openId, `⏹ AI 审查已中断：《${title}》`).catch(() => {});
      } else {
        const message = errMessage(err);
        await channel.notifyOpenId(openId, `⚠️ AI 审查失败：《${title}》\n${message}`).catch(() => {});
      }
    } finally {
      aiReviewRunning.delete(attemptId);
    }
  };

  const onCardAction = (action: CardAction): void => {
    const openId = action.operator?.open_id || '';
    const value = action.action?.value || {};
    if (!openId) return;
    // 「AI 审查」按钮：异步执行并立即返回（ocr 审查耗时可达数分钟，回调需快速 ACK）
    if (value.hta_review) {
      void handleAiReview(openId, String(value.hta_review), String(value.title || ''));
      return;
    }
    if (!value.hta_confirm) return;
    const result = confirmations.resolveFromCard(openId, String(value.hta_confirm), String(value.decision || ''));
    if (result === 'approved') void channel.notifyOpenId(openId, '✅ 已批准，正在执行…').catch(() => {});
    else if (result === 'approved_batch')
      void channel
        .notifyOpenId(openId, '✅ 已批准；同类写操作本会话内免问，正在执行…（回复「恢复确认」可随时撤销）')
        .catch(() => {});
    else if (result === 'denied') void channel.notifyOpenId(openId, '已取消，操作未执行。').catch(() => {});
    else void channel.notifyOpenId(openId, '该确认已处理或已过期，无需重复操作。').catch(() => {});
  };

  /** /stop：中断当前轮次与 AI 审查、取消写操作闸门、丢弃排队消息并兜底清理其敲键盘表情。 */
  const handleStop = async (msg: InboundMessage): Promise<void> => {
    const ctl = running.get(msg.senderId);
    const gateCancelled = confirmations.cancel(msg.senderId);
    const dropped = router.cancelQueued(msg.senderId);
    // AI 审查在串行队列外运行（卡片回调触发），单独登记单独中断
    let reviewsAborted = 0;
    for (const r of aiReviewRunning.values()) {
      if (r.openId === msg.senderId && !r.ctl.signal.aborted) {
        r.ctl.abort();
        reviewsAborted++;
      }
    }
    // 被丢弃的排队消息不会执行回调，其敲键盘表情在这里兜底移除（含正在中断的那条）
    const stray = pendingTyping.get(msg.senderId);
    if (stray?.length) {
      pendingTyping.delete(msg.senderId);
      for (const r of stray) void channel.removeReaction(r.messageId, r.reactionId).catch(() => {});
    }
    if (ctl) {
      ctl.abort();
      running.delete(msg.senderId);
    }
    const stopped: string[] = [];
    if (ctl) stopped.push('已中断当前任务');
    if (reviewsAborted) stopped.push(`已中断 ${reviewsAborted} 个 AI 审查`);
    if (gateCancelled) stopped.push('待确认的写操作已一并取消');
    if (dropped) stopped.push(`已丢弃 ${dropped} 条排队消息`);
    if (stopped.length) {
      await channel.reply(msg, `⏹ ${stopped.join('，')}。`);
    } else {
      await channel.reply(msg, '当前没有正在执行的任务。');
    }
  };

  /** 「同类免问」查询/撤销。 */
  const handleConfirmQuery = async (msg: InboundMessage, text: string, cmd: string | null): Promise<void> => {
    const session = router.getOrCreate(msg.senderId);
    // /confirm on 是历史别名；语义化写法 /confirm revoke
    if (text === '恢复确认' || cmd === '/confirm revoke' || text.toLowerCase() === '/confirm on') {
      const n = session.revokeBatchApprovals();
      await channel.reply(
        msg,
        n ? `✅ ${confirmRevokedText(n, '')}` : confirmRevokedText(0, '当前没有生效中的「同类免问」，无需撤销。'),
      );
    } else {
      await channel.reply(msg, confirmStateText(session.activeBatchApprovals(), '回复「恢复确认」撤销'));
    }
  };

  const handleStatus = async (msg: InboundMessage): Promise<void> => {
    const lastEventAt = channel.lastEventAt();
    // 依赖探测全部异步（execFileSync 串在事件循环里最坏阻塞十几秒）
    const [larkOk, ocrOk] = await Promise.all([checkLarkCliAsync(), checkOcrCliAsync()]);
    const lines = await buildStatusLines(
      {
        model: cfg.llmModel,
        kanbanUrl: cfg.kanbanUrl,
        mcpOk: supervisor.isAlive,
        mcpToolCount: mcp.tools.length,
        mcpDownNote: `${MCP_FALLBACK_TEXT}，自动重连中`,
        larkOk,
        extra: [
          `代码审查工具: ${ocrOk ? 'ok' : '未安装（点「AI 审查」时自动 npx 拉取，首次较慢）'}`,
          `看板推送: ${process.env.KANBAN_WATCH === '0' ? '关' : '开'}`,
          `飞书长连接: ${channel.connectionState() ?? '未启动'}，最近事件 ${
            lastEventAt ? new Date(lastEventAt).toLocaleString('zh-CN') : '暂无'
          }`,
        ],
      },
      plainPaint,
    );
    await channel.reply(msg, lines.join('\n'));
  };

  const handleTools = async (msg: InboundMessage): Promise<void> => {
    const lines = buildToolsLines(
      {
        mcpOk: supervisor.isAlive && mcp.tools.length > 0,
        mcpTools: mcp.tools,
        kanbanHeader: `看板工具（MCP，${mcp.tools.length} 个）`,
        downNote: `看板工具：MCP 未连接（${MCP_FALLBACK_TEXT}，功能不受影响）`,
        localHeader: '本地工具',
        bullet: '· ',
      },
      plainPaint,
    );
    await channel.reply(msg, lines.join('\n'));
  };

  const handleSkills = async (msg: InboundMessage, text: string): Promise<void> => {
    // 子命令参数（install 路径等）区分大小写，传原始 text
    const lines = handleSkillsCommand(text, { header: '已安装技能', bullet: '· ', headerWhenEmpty: true }, plainPaint);
    await channel.reply(msg, lines.join('\n'));
  };

  /** 即时命令表（不进串行队列，否则 /stop 会排在它要中断的任务后面，/confirm 撤销等当前任务结束才生效就晚了）。 */
  const instantCommands: Record<string, (msg: InboundMessage, text: string, cmd: string | null) => Promise<void>> = {
    '/help': async (msg) => channel.reply(msg, deps.helpText),
    '/stop': (msg) => handleStop(msg),
    '/confirm': (msg, text, cmd) => handleConfirmQuery(msg, text, cmd),
    '/status': (msg) => handleStatus(msg),
    '/tools': (msg) => handleTools(msg),
    '/skills': (msg, text) => handleSkills(msg, text),
  };

  /** 即时命令分发：命中则执行并返回 true。「恢复确认」是纯文本写法，与 /confirm 同路。 */
  const dispatchInstantCommand = async (
    msg: InboundMessage,
    text: string,
    cmd: string | null,
  ): Promise<boolean> => {
    const key = cmd === '/confirm' || text === '恢复确认' ? '/confirm' : cmd;
    const fn = key ? instantCommands[key] : undefined;
    if (!fn) return false;
    await fn(msg, text, cmd);
    return true;
  };

  /** 写操作确认的文字应答：已裁决/确认词兜底均终结消息（返回 true），不再进入队列。 */
  const handleConfirmationReply = async (msg: InboundMessage, text: string): Promise<boolean> => {
    confirmations.noteChat(msg.senderId, msg.sessionId);
    const answer = confirmations.resolveFromText(msg.senderId, text);
    if (answer === 'approved') {
      await channel.reply(msg, '✅ 已批准，正在执行…');
      return true;
    }
    if (answer === 'approved_batch') {
      await channel.reply(msg, '✅ 已批准；同类写操作本会话内免问，正在执行…（回复「恢复确认」可随时撤销）');
      return true;
    }
    if (answer === 'denied') {
      await channel.reply(msg, '已取消，操作未执行。');
      return true;
    }
    // 确认词但无 pending（已超时/已处理）：即时提示，不要落入普通对话发给 LLM
    if (!confirmations.hasPending(msg.senderId) && isConfirmWord(text)) {
      await channel.reply(msg, '当前没有待确认的写操作（可能已超时自动拒绝、被取消或被新操作替代）。如仍需执行，请重新描述你的需求。');
      return true;
    }
    return false;
  };

  /**
   * 即时回执：给用户消息加「敲键盘」表情并登记追踪，返回幂等清理函数
   * （该条处理完毕或被 /stop 代际丢弃时调用；onDropped 兜底了「丢弃回调不执行 finally」的漏洞）。
   * 失败分级：永久性错误（缺权限/不支持）降级为静默且不再重试；瞬时错误（限流/网络）下条消息再试。
   */
  const trackTypingReaction = async (
    fmsg: FeishuInboundMessage,
    openId: string,
  ): Promise<() => Promise<void>> => {
    let typingReactionId: string | undefined;
    if (!reactionUnsupported) {
      try {
        typingReactionId = await channel.addReaction(fmsg.messageId, 'Typing');
        if (typingReactionId) {
          const list = pendingTyping.get(openId) || [];
          list.push({ messageId: fmsg.messageId, reactionId: typingReactionId });
          pendingTyping.set(openId, list);
        }
      } catch (err) {
        const message = errMessage(err);
        if (REACTION_PERMANENT_RE.test(message)) {
          reactionUnsupported = true;
          console.warn(`[feishu] 敲键盘表情回执不可用，已降级为仅占位消息: ${message}`);
        } else {
          console.warn(`[feishu] 敲键盘表情回执失败（瞬时错误，下条消息重试）: ${message}`);
        }
      }
    }
    return async () => {
      if (!typingReactionId) return;
      const rid = typingReactionId;
      typingReactionId = undefined;
      const list = pendingTyping.get(openId);
      const tracked = list?.some((r) => r.reactionId === rid) ?? false;
      if (list) {
        const rest = list.filter((r) => r.reactionId !== rid);
        if (rest.length) pendingTyping.set(openId, rest);
        else pendingTyping.delete(openId);
      }
      // 仍在追踪表内才发移除请求（/stop 的兜底清理已移除过时跳过，避免重复调用）
      if (tracked) await channel.removeReaction(fmsg.messageId, rid).catch(() => {});
    };
  };

  /** 进度占位消息：发送失败仅记日志，最终回复回退 reply 直发。 */
  const sendPlaceholder = async (msg: InboundMessage): Promise<string | undefined> => {
    try {
      return await channel.sendText(msg.sessionId, '⏳ 处理中…');
    } catch (err) {
      const message = errMessage(err);
      console.error(`[feishu] 占位消息发送失败: ${message}`);
      return undefined;
    }
  };

  /** 进度反馈：占位消息随工具调用节流更新（飞书消息更新限流，2 秒内合并）。 */
  const createProgressReporter = (progressId: string | undefined): ((info: ProgressInfo) => void) => {
    let lastPush = 0;
    return (info: ProgressInfo) => {
      if (!progressId) return;
      const now = Date.now();
      if (now - lastPush < 2000) return; // 飞书消息更新限流
      lastPush = now;
      const text = info.type === 'tool' ? `⏳ 处理中…（调用工具 ${info.name}）` : '⏳ 思考中…';
      void channel.updateText(progressId, text).catch(() => {});
    };
  };

  /** 最终回复投递：有占位消息则替换之（超长自动拆分续发），占位缺失时回退 reply。 */
  const deliverReply = async (msg: InboundMessage, progressId: string | undefined, reply: string): Promise<void> => {
    const chunks = splitText(reply || '（无回复）');
    if (progressId) {
      try {
        await channel.updateText(progressId, chunks[0]!);
      } catch {
        await channel.sendText(msg.sessionId, chunks[0]!);
      }
      for (const chunk of chunks.slice(1)) await channel.sendText(msg.sessionId, chunk);
    } else {
      await channel.reply(msg, reply || '（无回复）');
    }
  };

  /** 单个 agent 轮次：占位/进度/中断登记/回复投递/异常分级（中断与 LLM 失败文案不同）。 */
  const runAgentRound = async (msg: InboundMessage, session: AgentSession, text: string): Promise<void> => {
    const openId = msg.senderId;
    // 进度反馈：占位消息随工具调用更新，完成后替换为最终回复（超长自动拆分）
    const progressId = await sendPlaceholder(msg);
    const onProgress = createProgressReporter(progressId);
    const ctl = new AbortController();
    running.set(openId, ctl);
    // 登记轮次：MCP supervisor 重连前必须等轮次归零（close 会杀 in-flight 工具调用）
    await supervisor.enterTurn();
    try {
      const reply = await session.handleUserMessage(text, onProgress, ctl.signal);
      await deliverReply(msg, progressId, reply);
    } catch (err) {
      if (ctl.signal.aborted) {
        await channel.reply(msg, '⏹ 已中断。');
      } else {
        const message = errMessage(err);
        const parts = llmFailureParts(message, text, 'bot');
        await channel.reply(msg, [parts.head, parts.friendly, parts.tail].filter(Boolean).join('\n'));
      }
    } finally {
      supervisor.exitTurn();
      running.delete(openId);
    }
  };

  /** 串行队列内执行一条消息：队列内命令（/memory、/clear、未知命令）与普通对话。 */
  const runQueuedMessage = async (
    msg: InboundMessage,
    text: string,
    cmd: string | null,
    openId: string,
  ): Promise<void> => {
    const session = router.getOrCreate(openId);

    if (cmd === '/memory') {
      await channel.reply(msg, buildMemoryLines(session, '你的记忆').join('\n'));
      return;
    }
    if (cmd === '/clear') {
      session.clearHistory();
      await channel.reply(msg, CLEARED_TEXT);
      return;
    }
    if (cmd) {
      await channel.reply(msg, `未知命令 ${cmd}，发送 /help 查看帮助。`);
      return;
    }

    await runAgentRound(msg, session, text);
  };

  /** 排队入口：排队上限拒收、排队/闸门回执、敲键盘表情、串行入队。 */
  const enqueueMessage = async (
    msg: InboundMessage,
    fmsg: FeishuInboundMessage,
    text: string,
    cmd: string | null,
  ): Promise<void> => {
    const openId = msg.senderId;
    // 排队上限：积压已满时直接拒收（在加敲键盘表情之前，避免残留表情无人清理）
    if (router.queueFull(openId)) {
      await channel.reply(msg, '⚠️ 排队消息已满，请等前面的任务处理完再发（或先 /stop 清空队列）。');
      return;
    }
    // 回执：闸门挂起或已有任务在跑时立即告知，避免"消息发出去没反应"
    if (confirmations.hasPending(openId)) {
      await channel.reply(
        msg,
        '⚠️ 有未处理的写操作确认卡片：请先点按钮（或回复「确认」/「取消」，超时自动拒绝）。本条消息已排队，会按顺序处理。',
      );
    } else if (router.busy(openId)) {
      await channel.reply(msg, '📥 已收到并排队：当前任务完成后依次处理。');
    }
    // 即时回执：给用户消息加「敲键盘」表情，该条处理完成后移除；
    // 排在队列里时表情先行，用户立刻知道消息已被收到。
    const cleanupTyping = await trackTypingReaction(fmsg, openId);
    await router.enqueue(
      openId,
      async () => {
        try {
          await runQueuedMessage(msg, text, cmd, openId);
        } finally {
          await cleanupTyping();
        }
      },
      // 被 /stop 代际丢弃的消息不会执行上面的回调，其敲键盘表情由这个钩子即时清理
      // （/stop 的 pendingTyping 兜底清理覆盖竞态：先于钩子跑过时这里会跳过重复移除）
      () => void cleanupTyping(),
    );
  };

  /** 消息入口：类型/长度门禁 → 确认应答 → 即时命令分发 → 串行排队。 */
  const handle = async (msg: InboundMessage): Promise<void> => {
    const fmsg = msg as FeishuInboundMessage;

    if (fmsg.messageType && fmsg.messageType !== 'text' && fmsg.messageType !== 'post') {
      await channel.reply(msg, '暂只支持文字消息：图片/文件等内容，请把关键信息打字或粘贴成文字发给我。');
      return;
    }

    const text = (msg.text || '').trim();
    if (!text) {
      await channel.reply(msg, '请发送文字内容。');
      return;
    }
    // 超长消息直接拒答：不排队、不送 LLM（撑爆上下文 / 网关 400）
    if (text.length > MAX_USER_MESSAGE_CHARS) {
      await channel.reply(
        msg,
        `⚠️ 这条消息太长了（${text.length} 字符，上限 ${MAX_USER_MESSAGE_CHARS}）：请精简或拆成几条发送。`,
      );
      return;
    }

    // 写操作确认应答优先处理：闸门在等答复，若进串行队列会死锁
    if (await handleConfirmationReply(msg, text)) return;

    const cmd = parseCommand(text);
    if (await dispatchInstantCommand(msg, text, cmd)) return;

    await enqueueMessage(msg, fmsg, text, cmd);
  };

  return { handle, onCardAction };
}
