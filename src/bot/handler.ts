/**
 * 飞书 bot 消息路由：斜杠命令、写操作确认应答、排队回执、敲键盘表情、
 * AI 审查按钮回调。bootstrap（向导/看板拉起/长连接建立）留在 bot.ts。
 */

import {
  FeishuChannel,
  ImageTooLargeError,
  splitText,
  type FeishuCardAction,
  type FeishuInboundMessage,
} from '../channels/feishu';
import { SessionRouter } from '../agent/session-router';
import type { AgentSession } from '../agent/session';
import { ConfirmationManager, isConfirmWord } from '../agent/confirm';
import { runAiReview, ocrWillDeriveBotLlm } from '../kanban/ai-review';
import { buildAiReviewCard } from '../channels/feishu-cards';
import { isAllPass, writeReviewReport } from '../report/review-report';
import type { ReportServer } from '../report/report-server';
import { checkLarkCliAsync, checkOcrCliAsync, checkHkDepsAsync, HK_CLI_INSTALL_HINT } from '../infra/deps';
import { wrapUntrusted } from '../agent/guard';
import {
  buildMemoryLines,
  buildStatusLines,
  buildToolsLines,
  clearedText,
  confirmRevokedText,
  confirmStateText,
  handleSkillsCommand,
  llmFailureParts,
  parseCommand,
  plainPaint,
} from '../commands';
import type { AgentConfig, InboundMessage, InlineImage, ProgressInfo } from '../types';
import type { KanbanMcp } from '../kanban/mcp';
import type { McpSupervisor } from './supervisor';
import { MCP_FALLBACK_TEXT } from '../infra/deps';
import { errMessage } from '../infra/err';

/** 卡片按钮回调载荷（确认卡片 / AI 审查）。 */
type CardAction = FeishuCardAction;

/** AI 审查全局并发上限：每个审查是最长 15 分钟的子进程，不同 attempt 叠加会拖垮机器。 */
const AI_REVIEW_MAX_CONCURRENT = 2;

/** 单条用户消息长度上限：超长消息直接拒答，不送入 LLM（上下文爆炸 / 网关 400）。 */
export const MAX_USER_MESSAGE_CHARS = 8000;

/** 进度占位消息静默期心跳间隔：超过该时长没有任何工具事件则刷新一次占位（LLM 长思考时用户分不清「在想」还是「死了」）。 */
export const PROGRESS_HEARTBEAT_MS = 10_000;

/** 图片消息大小上限（字节）：超限直接拒答，不送 LLM（base64 后约膨胀 1/3，撑爆上下文/网关）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 图片下载器：默认走飞书 SDK（FeishuChannel.downloadImage），单测注入 mock（不触网络）。 */
export type ImageFetcher = (messageId: string, imageKey: string) => Promise<{ data: Buffer; mimeType: string }>;

/**
 * 轮次内插消息追踪：确认卡片/批准回执等独立消息若插在「⏳ 处理中…」占位之后，
 * 最终回复不能再原地编辑占位（飞书编辑不改变消息位置，完成消息会停在卡片上方），
 * 需另发新消息落在时间线末尾。按 openId 计数，轮次开始 reset，投递前 has 判断。
 */
export interface RoundNoticeTracker {
  mark(openId: string): void;
  has(openId: string): boolean;
  reset(openId: string): void;
}

export function createRoundNoticeTracker(): RoundNoticeTracker {
  const counts = new Map<string, number>();
  return {
    mark: (openId) => counts.set(openId, (counts.get(openId) ?? 0) + 1),
    has: (openId) => (counts.get(openId) ?? 0) > 0,
    reset: (openId) => counts.delete(openId),
  };
}

/** 表情回执永久性错误判定：权限/能力缺失类错误重试不会自愈，降级禁用；其余（限流/网络抖动）视为瞬时，下条消息再试。 */
const REACTION_PERMANENT_RE = /permission|权限|not.?support|不支持|forbidden|invalid.?emoji/i;

/** 飞书长连接状态英文枚举 → 中文（/status 展示）；未列入的未知值回退原文。 */
const WS_STATE_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  failed: '连接失败',
  idle: '空闲',
};

/** 进度占位的工具动作文案：内部工具名不直接暴露给用户，常见工具映射为中文动作，未知名称回落「调用工具」。 */
function toolActionLabel(name: string): string {
  if (name === 'repo_fs') return '读文件';
  if (name === 'hk_cli' || name.startsWith('kanban_')) return '看板操作';
  if (name === 'lark_cli') return '飞书操作';
  if (name === 'work_summary') return '生成报告';
  if (name.startsWith('memory_')) return '读写记忆';
  if (name.startsWith('skill_')) return '运行技能';
  return '调用工具';
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
  /** 测试注入用：替换 AI 审查执行器（默认 runAiReview 会拉起 ocr 子进程，单测不可行）。 */
  aiReviewRunner?: typeof runAiReview;
  /** 测试注入用：静默期心跳间隔（默认 PROGRESS_HEARTBEAT_MS）。 */
  progressHeartbeatMs?: number;
  /** 测试注入用：图片下载器（默认 channel.downloadImage 走飞书 SDK）。 */
  imageFetcher?: ImageFetcher;
  /** 轮次内插消息追踪（bot-main 在确认卡片/回执发送时 mark）；缺省时最终回复一律原地替换占位。 */
  roundNotices?: RoundNoticeTracker;
}

export interface BotHandlers {
  /** 私聊消息入口（传给 channel.start；通道为飞书实现，直接收 FeishuInboundMessage）。 */
  handle: (msg: FeishuInboundMessage) => Promise<void>;
  /** 卡片按钮回调（确认卡片 / AI 审查）。 */
  onCardAction: (action: CardAction) => void;
}

export function createBotHandlers(deps: BotHandlerDeps): BotHandlers {
  const { channel, router, confirmations, cfg, mcp, supervisor, reportServer } = deps;
  const runReview = deps.aiReviewRunner ?? runAiReview;
  const progressHeartbeatMs = deps.progressHeartbeatMs ?? PROGRESS_HEARTBEAT_MS;
  const fetchImage: ImageFetcher =
    deps.imageFetcher ?? ((mid, key) => channel.downloadImage(mid, key, MAX_IMAGE_BYTES));

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
        .notifyOpenId(
          openId,
          `🤖 同时进行的 AI 审查已达上限（${AI_REVIEW_MAX_CONCURRENT} 个）：《${title}》本次未开始。请等现有审查完成后，重新点击看板通知卡片上的「AI 审查」。`,
        )
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
        runReview({
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
      // 投递段（报告写盘 / 卡片推送）与审查执行分开兜底：投递失败不是「AI 审查失败」，
      // 审查结果本身也不丢——降级为文本推送（截断 + 注明失败原因）
      try {
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
      } catch (deliverErr) {
        const dmsg = errMessage(deliverErr);
        console.error(`[review] 报告写盘/卡片推送失败，降级文本推送: ${dmsg}`);
        const excerpt = result.length > 3000 ? `${result.slice(0, 3000)}\n…（结果过长已截断）` : result;
        await channel
          .notifyOpenId(
            openId,
            `🤖 AI 审查结果：《${title}》\n⚠️ 报告写盘/卡片推送失败（${dmsg}），改为文本推送：\n${excerpt}`,
          )
          .catch((e) => {
            // 降级文本也失败：结果无法送达，只能落日志（不再往外抛，避免误报「AI 审查失败」）
            console.error(`[review] 降级文本推送也失败: ${errMessage(e)}`);
          });
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
        // 失败原因截断防超长推送；底层文案自带「重试」时不重复追加重试后缀
        const message = errMessage(err).slice(0, 200);
        const retryHint = message.includes('重试') ? '' : '\n可稍后重新点击卡片上的「AI 审查」重试。';
        await channel.notifyOpenId(openId, `⚠️ AI 审查失败：《${title}》\n${message}${retryHint}`).catch(() => {});
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
  const handleConfirmQuery = async (msg: InboundMessage, text: string): Promise<void> => {
    const session = router.getOrCreate(msg.senderId);
    // /confirm on 是历史别名；语义化写法 /confirm revoke。
    // 必须对完整 text 判定：parseCommand 只取第一个空白分词（恒为 '/confirm'），
    // 用 cmd === '/confirm revoke' 判的话该分支永不可达，撤销会静默失效（安全语义 bug）
    const lower = text.trim().toLowerCase();
    if (text === '恢复确认' || lower === '/confirm revoke' || lower === '/confirm on') {
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
    const wsState = channel.connectionState();
    const lines = await buildStatusLines(
      {
        model: cfg.llmModel,
        kanbanUrl: cfg.kanbanUrl,
        mcpOk: supervisor.isAlive,
        mcpToolCount: mcp.tools.length,
        mcpDownNote: `${MCP_FALLBACK_TEXT}，自动重连中`,
        larkOk,
        extra: [
          `代码审查工具：${ocrOk ? '正常' : '未安装（首次点「AI 审查」时自动下载，耗时稍长）'}`,
          `看板推送：${process.env.KANBAN_WATCH === '0' ? '关' : '开'}`,
          `飞书长连接：${wsState ? (WS_STATE_LABEL[wsState] ?? wsState) : '未启动'}，最近事件 ${
            lastEventAt ? new Date(lastEventAt).toLocaleString('zh-CN') : '暂无'
          }`,
        ],
      },
      plainPaint,
    );
    await channel.reply(msg, lines.join('\n'));
  };

  const handleTools = async (msg: InboundMessage): Promise<void> => {
    // hk_cli 降级链依赖缺失时「功能不受影响」是谎言：按探测结果条件化 downNote
    const hkMissing = await checkHkDepsAsync();
    const lines = buildToolsLines(
      {
        mcpOk: supervisor.isAlive && mcp.tools.length > 0,
        mcpTools: mcp.tools,
        // bot 会话恒持有 MemoryStore，memory_* 工具始终注册
        memoryEnabled: true,
        kanbanHeader: `看板工具（${mcp.tools.length} 个）`,
        downNote: hkMissing.length
          ? `看板工具：MCP 未连接，且备用通道缺少 ${hkMissing.join('、')}，看板读写暂不可用（${HK_CLI_INSTALL_HINT}）`
          : `看板工具：MCP 未连接，${MCP_FALLBACK_TEXT}，功能不受影响`,
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
    '/confirm': (msg, text) => handleConfirmQuery(msg, text),
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

  /** 进度反馈：占位消息随工具调用节流更新（飞书消息更新限流，2 秒内合并）；activity 供静默期心跳判断。 */
  const createProgressReporter = (
    progressId: string | undefined,
    activity: { lastEventAt: number },
  ): ((info: ProgressInfo) => void) => {
    let lastPush = 0;
    return (info: ProgressInfo) => {
      activity.lastEventAt = Date.now();
      if (!progressId) return;
      const now = activity.lastEventAt;
      if (now - lastPush < 2000) return; // 飞书消息更新限流
      lastPush = now;
      const text = info.type === 'tool' ? `⏳ 处理中…（${toolActionLabel(info.name)}）` : '⏳ 思考中…';
      void channel.updateText(progressId, text).catch(() => {});
    };
  };

  /**
   * 静默期心跳：LLM 长思考期间没有任何工具事件，占位消息原地不动，用户分不清「在想」还是「死了」。
   * 每 intervalMs 检查一次，静默超阈值则刷新占位并附已等待秒数；回复就绪即停（clearHeartbeat 在投递前调用）。
   */
  const startProgressHeartbeat = (progressId: string | undefined, activity: { lastEventAt: number }): (() => void) => {
    if (!progressId) return () => {};
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - activity.lastEventAt < progressHeartbeatMs) return;
      const secs = Math.round((Date.now() - startedAt) / 1000);
      void channel.updateText(progressId, `⏳ 仍在处理…（已等待 ${secs} 秒；/stop 可中断）`).catch(() => {});
    }, progressHeartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  };

  /** 最终回复投递：有占位消息则替换之（超长自动拆分续发），占位缺失时回退 reply。 */
  const deliverReply = async (
    msg: InboundMessage,
    progressId: string | undefined,
    reply: string,
    interleaved = false,
  ): Promise<void> => {
    const chunks = splitText(reply || '（无回复）');
    if (progressId && interleaved) {
      // 轮次中插入了确认卡片等独立消息：占位停在它们上方，原地改文案会时序颠倒。
      // 占位收尾为短终态，正文另发新消息落在时间线末尾（分段各自兜底，同下方续发策略）。
      await channel
        .updateText(progressId, '✅ 已完成，结果见下方 ⬇️')
        .catch((err) => console.error(`[feishu] 占位收尾更新失败: ${errMessage(err)}`));
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
          // 直发兜底成功：占位还停在「⏳ 处理中…」（心跳已清不再刷新），best-effort 收尾为终态
          await channel.updateText(progressId, '✅ 已完成，结果见下方 ⬇️').catch(() => {});
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
        await channel.updateText(progressId, '⚠️ 回复投递失败，请重试或稍后再问。').catch(() => {});
      }
    } else {
      await channel.reply(msg, reply || '（无回复）');
    }
  };

  /** 单个 agent 轮次：占位/进度/中断登记/回复投递/异常分级（中断与 LLM 失败文案不同）。 */
  const runAgentRound = async (
    msg: InboundMessage,
    session: AgentSession,
    text: string,
    image?: InlineImage,
  ): Promise<void> => {
    const openId = msg.senderId;
    // 轮次开始重置内插消息计数：之后确认卡片等独立消息发送时 mark，投递前据此决定回复是否另发新消息
    deps.roundNotices?.reset(openId);
    // 中断登记先于占位发送：否则 sendPlaceholder 的 await 窗口内 /stop 查不到本轮，
    // 回「没有正在执行的任务」但任务其实在跑且无法中断（失败路径清理由 finally 的 running.delete 兜底）
    const ctl = new AbortController();
    running.set(openId, ctl);
    // 进度反馈：占位消息随工具调用更新，完成后替换为最终回复（超长自动拆分）
    const progressId = await sendPlaceholder(msg);
    const activity = { lastEventAt: Date.now() };
    const onProgress = createProgressReporter(progressId, activity);
    const clearHeartbeat = startProgressHeartbeat(progressId, activity);
    // 登记轮次：MCP supervisor 重连前必须等轮次归零（close 会杀 in-flight 工具调用）
    await supervisor.enterTurn();
    try {
      const reply = await session.handleUserMessage(text, onProgress, ctl.signal, image);
      clearHeartbeat(); // 投递前停心跳：避免回复已就绪却被心跳刷回「仍在处理」
      await deliverReply(msg, progressId, reply, deps.roundNotices?.has(openId) ?? false);
    } catch (err) {
      clearHeartbeat();
      // 「占位即终态」：异常路径先把「处理中」占位收尾为终态文案，占位缺失/更新失败才回退 reply。
      // /stop 的回执已由 handleStop 发出（「已中断当前任务…」），这里只收尾占位，不重复回复。
      if (ctl.signal.aborted) {
        if (progressId) {
          await channel
            .updateText(progressId, '⏹ 已中断。')
            .catch(() => channel.reply(msg, '⏹ 已中断。').catch(() => {}));
        }
      } else {
        const message = errMessage(err);
        const parts = llmFailureParts(message, text, 'bot');
        const failText = [parts.head, parts.friendly, parts.tail].filter(Boolean).join('\n');
        if (progressId) {
          await channel
            .updateText(progressId, '⚠️ 处理失败，详见下方')
            .catch(() => {});
        }
        await channel.reply(msg, failText);
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
    image?: InlineImage,
  ): Promise<void> => {
    const session = router.getOrCreate(openId);

    if (cmd === '/memory') {
      await channel.reply(msg, buildMemoryLines(session, '你的记忆').join('\n'));
      return;
    }
    if (cmd === '/clear') {
      session.clearHistory();
      await channel.reply(msg, clearedText(session.activeBatchApprovals(), '回复「恢复确认」撤销免问'));
      return;
    }
    if (cmd) {
      await channel.reply(msg, `未知命令 ${cmd}，发送 /help 查看帮助。`);
      return;
    }

    await runAgentRound(msg, session, text, image);
  };

  /** 排队入口：排队上限拒收、排队/闸门回执、敲键盘表情、串行入队。 */
  const enqueueMessage = async (
    fmsg: FeishuInboundMessage,
    text: string,
    cmd: string | null,
    image?: InlineImage,
  ): Promise<void> => {
    const msg: InboundMessage = fmsg;
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
      // 回执带排队位置：queuedCount 为已排在前面的条数（不含正在执行的那条，由后半句覆盖）
      const ahead = router.queuedCount(openId);
      await channel.reply(
        msg,
        ahead > 0
          ? `📥 已收到并排队（前面还有 ${ahead} 条），当前任务完成后依次处理。`
          : '📥 已收到并排队，当前任务完成后依次处理。',
      );
    }
    // 即时回执：给用户消息加「敲键盘」表情，该条处理完成后移除；
    // 排在队列里时表情先行，用户立刻知道消息已被收到。
    const cleanupTyping = await trackTypingReaction(fmsg, openId);
    await router.enqueue(
      openId,
      async () => {
        try {
          await runQueuedMessage(msg, text, cmd, openId, image);
        } finally {
          await cleanupTyping();
        }
      },
      // 被 /stop 代际丢弃的消息不会执行上面的回调，其敲键盘表情由这个钩子即时清理
      // （/stop 的 pendingTyping 兜底清理覆盖竞态：先于钩子跑过时这里会跳过重复移除）
      () => void cleanupTyping(),
    );
  };

  /**
   * 图片消息（LLM_VISION=1 才进入本路径）：下载字节 → 10MB 上限 → base64 data URL →
   * 作为普通对话排入既有串行队列（占位/进度/心跳不变，不占确认闸门）。
   * 会话历史只存文本占位「[图片] 配文」，图片仅透传给当次 LLM 请求（不落盘、不进审计）。
   */
  const handleImageMessage = async (fmsg: FeishuInboundMessage): Promise<void> => {
    const msg: InboundMessage = fmsg;
    let img: { data: Buffer; mimeType: string };
    try {
      img = await fetchImage(fmsg.messageId, fmsg.imageKey!);
    } catch (err) {
      if (err instanceof ImageTooLargeError) {
        await channel.reply(msg, '⚠️ 图片太大了（超过 10MB 上限）：请压缩后再发，或把关键信息打字发给我。');
        return;
      }
      // 失败原因只进日志（可能含请求细节），给用户的是通用友好提示
      console.error(`[feishu] 图片下载失败: ${errMessage(err)}`);
      await channel.reply(msg, '⚠️ 图片下载失败了，请稍后重发；也可以把图片里的关键信息打字发给我。');
      return;
    }
    if (img.data.length > MAX_IMAGE_BYTES) {
      const mb = (img.data.length / 1024 / 1024).toFixed(1);
      await channel.reply(msg, `⚠️ 图片太大了（${mb}MB，上限 10MB）：请压缩后再发，或把关键信息打字发给我。`);
      return;
    }
    const caption = (msg.text || '').trim();
    // 随图文字同样受单条长度上限约束（理论上 image 消息无配文，防御异常客户端）
    if (caption.length > MAX_USER_MESSAGE_CHARS) {
      await channel.reply(
        msg,
        `⚠️ 这条消息太长了（${caption.length} 字符，上限 ${MAX_USER_MESSAGE_CHARS}）：请精简或拆成几条发送。`,
      );
      return;
    }
    const image: InlineImage = {
      dataUrl: `data:${img.mimeType};base64,${img.data.toString('base64')}`,
      prompt: caption || '请分析这张图片并回应。',
    };
    await enqueueMessage(fmsg, caption ? `[图片] ${caption}` : '[图片]', null, image);
  };

  /** 消息入口：类型/长度门禁 → 确认应答 → 即时命令分发 → 串行排队。 */
  const handle = async (fmsg: FeishuInboundMessage): Promise<void> => {
    const msg: InboundMessage = fmsg;

    if (fmsg.messageType && fmsg.messageType !== 'text' && fmsg.messageType !== 'post') {
      // 图片消息：仅 vision 开关打开时放行；image_key 解析失败说明这张图读不出来，让用户重发
      if (fmsg.messageType === 'image' && cfg.visionEnabled) {
        if (fmsg.imageKey) {
          await handleImageMessage(fmsg);
        } else {
          await channel.reply(msg, '这张图片读取失败，请重新发送。');
        }
        return;
      }
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

    await enqueueMessage(fmsg, text, cmd);
  };

  return { handle, onCardAction };
}
