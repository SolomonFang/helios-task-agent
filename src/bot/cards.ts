/**
 * 飞书交互卡片（卡片 JSON 2.0 schema）构建统一收口：
 * - 写操作确认卡片 / 确认终态卡片（buildConfirmCard / buildResolvedCard）
 * - 进度占位卡片 / 结果卡片 / 进度终态卡片（buildProgressCard / buildResultCard / buildProgressTerminalCard）
 * - AI 审查/诊断/重试「进行中」卡片（buildJobProcessingCard，按钮点击后同步换卡，按钮即时消失）
 * - 看板事件通知卡片（buildWatchEventCard，含停滞提醒与失败「AI 诊断」按钮）
 * - AI 审查结果卡片（buildAiReviewCard）
 * - 失败诊断结果卡片（buildDiagnosisCard，含「按诊断结论重试」按钮与重试后终态）
 *
 * 2.0 结构约定（对照官方 card-2.0-schema）：
 * - 根结构 {schema:'2.0', config, header, body:{elements}}；elements 平铺组件
 * - 按钮不用 1.0 的 action 容器（2.0 已废弃），逐个平铺 body.elements；
 *   回传 behaviors:[{type:'callback',value}]，跳转 behaviors:[{type:'open_url',…}]；
 *   主次规范：单按钮 primary_filled + width fill，多按钮首个 primary_filled、其余 default
 *   （例外：停止/取消为非破坏动作，一律 default 不做强焦点——红色只留给破坏性操作本身的警示）
 * - 2.0 无 note 组件：注脚一律 markdown + text_size:'notation'
 * - config：width_mode:'fill' + enable_forward:false + update_multi:true（cardkit 要求共享卡片）——
 *   卡片内含本机链接与写操作按钮，被转发后链接不可达、按钮语义越权，一律禁止转发
 * - 进度占位卡（buildProgressCard）带 streaming_mode 配置与 element_id 锚点（hta_main 正文 / hta_stop 按钮），
 *   供 CardKit 流式更新（打字机动画）；其余状态卡片不带 streaming 配置，整卡覆盖即关闭流式态
 */

import { batchScopeWord, kindLabel, type ConfirmRequest, type ConfirmSettle } from '../agent/guard';
import {
  WATCH_HINT_DONE,
  WATCH_HINT_FAILED_LOG,
  WATCH_HINT_REVIEW,
  WATCH_HINT_STALE,
  linkReachNote,
  type WatchEvent,
  type WatchEventKind,
} from '../kanban/watcher';
import { statusLabel } from '../kanban/summary';
import { DIAGNOSIS_CARD_MAX_CHARS } from '../kanban/failure-diagnosis';

/** 全部卡片的共同 config：宽屏（fill）+ 禁止转发 + 共享卡片（见文件头注释）。 */
function baseCardConfig(): Record<string, unknown> {
  return { width_mode: 'fill', enable_forward: false, update_multi: true };
}

/** 进度占位卡的流式配置：streaming_mode + 打字机节奏 + 会话列表预览文案（收尾整卡覆盖/ settings 关闭）。 */
function streamingCardConfig(): Record<string, unknown> {
  return {
    ...baseCardConfig(),
    streaming_mode: true,
    streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' },
    summary: { content: '（生成中…）' },
  };
}

/** 注脚组件（2.0 无 note）：markdown + notation 字号。 */
function noteEl(content: string): Record<string, unknown> {
  return { tag: 'markdown', content, text_size: 'notation' };
}

/** 正文富文本组件。elementId 供 CardKit 流式更新定位（进度卡固定 hta_main）。 */
function mdEl(content: string, elementId?: string): Record<string, unknown> {
  return elementId ? { tag: 'markdown', content, element_id: elementId } : { tag: 'markdown', content };
}

/** 纯文本组件（2.0 保留 div；外部数据防 markdown 误解析用）。 */
function textEl(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

/** 回调按钮（2.0：behaviors 回传；type 默认 default，主操作由调用方传 primary_filled）。 */
function callbackButton(text: string, value: Record<string, unknown>, type = 'default'): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

/** 跳转按钮（2.0：open_url 行为，四端 url 兜底）。 */
function linkButton(text: string, url: string, type = 'primary_filled'): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'fill',
    behaviors: [{ type: 'open_url', default_url: url, pc_url: url, ios_url: url, android_url: url }],
  };
}

/** markdown 代码块包裹命令详情；三连反引号会破坏围栏，先转义。 */
function detailCodeBlock(detail: string): string {
  return '```\n' + detail.replace(/```/g, "'''") + '\n```';
}

/**
 * 嵌入 markdown 的用户数据（任务标题等）：星号/反引号/括号全角化并中和 [ ] 链接语法，
 * 同时中和 ~~（删除线）、<font color>/<at id> 等类 HTML 标签语法（< > 全角化），
 * 避免误触加粗/代码/链接/删除线/标签解析破坏排版（2.0 markdown 这些语法是真渲染）。
 */
function mdSafe(s: string): string {
  return s
    .replace(/\*/g, '＊')
    .replace(/`/g, '｀')
    .replace(/~/g, '～')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）');
}

/** Interactive card shown for a pending write operation（卡片 JSON 2.0）。 */
export function buildConfirmCard(
  req: ConfirmRequest,
  id: string,
  timeoutMs = 120000,
  opts?: { stopToken?: string },
): Record<string, unknown> {
  const isLark = req.kind === 'lark';
  const kindText = kindLabel(req.kind);
  const timeoutSec = Math.round(timeoutMs / 1000);
  const buttons: Record<string, unknown>[] = [
    callbackButton('✅ 确认执行（仅此次）', { hta_confirm: id, decision: 'yes' }, 'primary_filled'),
  ];
  if (req.batchKey) {
    buttons.push(
      // 粒度如实标注：对象级免问（删除/审批等）只说「同对象」，避免用户误以为整个类都放行
      callbackButton(`🔁 ${batchScopeWord(req.batchScope)}免问（本会话）`, { hta_confirm: id, decision: 'batch' }),
    );
  }
  // 取消是安全操作，不用 danger 红——红色留给真正的破坏性动作本身（卡片 header 橙色已承担警示）
  buttons.push(callbackButton('✖️ 取消', { hta_confirm: id, decision: 'no' }));
  if (opts?.stopToken) {
    buttons.push({ ...callbackButton('⏹ 停止', { hta_stop: opts.stopToken }), element_id: 'hta_stop' });
  }
  // 精简版注脚：有效期（含超时后果，与文本降级版口径一致）与文本回复方式合并为一行
  const replyHint = req.batchKey
    ? `${timeoutSec} 秒内有效（超时自动拒绝） · 回复「确认」/「${batchScopeWord(req.batchScope)}免问」/「取消」`
    : `${timeoutSec} 秒内有效（超时自动拒绝） · 回复「确认」/「取消」`;
  // 「取消」只拒绝本次写操作，「停止」中断整个任务：两按钮并存时注脚点明区别
  const stopHint = opts?.stopToken ? ' · 「停止」会中断整个任务' : '';
  return {
    schema: '2.0',
    config: baseCardConfig(),
    header: {
      // 写操作确认一律橙色警示头（蓝色只用于纯信息场景，如待审批通知）；
      // 破坏性操作标题补「· 高危」，与 CLI 闸口（cli.ts confirmWrite）口径一致
      template: 'orange',
      title: { tag: 'plain_text', content: `${isLark ? '✉️' : '🔧'} ${kindText} · 写操作确认${req.destructive ? ' · 高危' : ''}` },
    },
    body: {
      direction: 'vertical',
      elements: [
        mdEl(`**${mdSafe(req.summary)}**`),
        mdEl(detailCodeBlock(req.detail)),
        ...buttons,
        noteEl(replyHint + stopHint),
      ],
    },
  };
}

/** 决策/超时/作废后的终态卡片（原地替换确认卡片；无按钮，避免误点与"没反应"）。 */
export function buildResolvedCard(req: ConfirmRequest, settle: ConfirmSettle): Record<string, unknown> {
  const kindText = kindLabel(req.kind);
  const meta: Record<ConfirmSettle, { template: string; title: string; note: string }> = {
    once: {
      template: 'green',
      title: `✅ ${kindText} · 写操作已批准（仅此次）`,
      note: '操作已放行，正在执行。',
    },
    batch: {
      template: 'green',
      title: `🔁 ${kindText} · 写操作已批准（${batchScopeWord(req.batchScope)}免问 · 本会话）`,
      note: '回复「恢复确认」可随时撤销免问；机器人重启后自动失效。',
    },
    denied: {
      template: 'red',
      title: `🚫 ${kindText} · 写操作已取消`,
      note: '操作未执行。',
    },
    timeout: {
      template: 'grey',
      title: `⏰ ${kindText} · 写操作确认超时`,
      note: '超时未处理，已自动拒绝，操作未执行。如仍需执行，直接再跟我说一声即可。',
    },
    superseded: {
      template: 'grey',
      title: `⚠️ ${kindText} · 写操作确认已作废`,
      note: '该确认已被新的写操作确认替代，请以最新卡片为准。',
    },
  };
  const m = meta[settle];
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  return {
    schema: '2.0',
    config: baseCardConfig(),
    header: {
      template: m.template,
      title: { tag: 'plain_text', content: m.title },
    },
    body: {
      direction: 'vertical',
      elements: [
        // 终态卡片原地替换确认卡片，命令细节用户刚看过，不再重复展示
        mdEl(`**${mdSafe(req.summary)}**`),
        noteEl(`${m.note} · ${time}`),
      ],
    },
  };
}

/**
 * 结果卡片正文的字节上限：飞书卡片请求体上限约 30KB（按字节计），取保守值；
 * 超长回复不进卡片，走「卡片收尾为 seeBelow 终态 + 文本分段」路径（内容不丢）。
 */
export const RESULT_CARD_MAX_BYTES = 28000;

/**
 * 免问生效期间进度卡/结果卡注脚持续携带的撤销指引：批准时的 toast 只停留几秒，
 * 注脚是持久载体（progress-reporter 在 track 上记 batchActive，重建与结果卡都带上）。
 */
export const BATCH_ACTIVE_NOTE = '免问生效中 · 回复「恢复确认」可撤销';

/** 进度卡片展示的最近步骤数上限：长任务的步骤轨迹不无限变长。 */
const PROGRESS_CARD_MAX_STEPS = 5;

/** 进度卡片状态：步骤轨迹（已完成 ✓ / 当前 ⏳）+ 已等待秒数；waitingConfirm 为写操作确认挂起变体。 */
export interface ProgressCardState {
  /** 已完成步骤（工具动作标签，按发生顺序；卡片内只展示最近 PROGRESS_CARD_MAX_STEPS 步）。 */
  steps: string[];
  /** 当前进行中的步骤；无 = 等待/思考中。 */
  current?: string;
  /** 已等待秒数（心跳刷新注脚用）；缺省不展示。 */
  elapsedSec?: number;
  /**
   * 写操作确认挂起变体：橙头如实提示等用户裁决（此时「仍在处理」是谎称）；停止按钮保留。
   * 携带挂起确认的展示形态（confirm.pendingForm）：文本降级（无卡片）的确认指引不能提按钮，
   * 支持免问的确认补「免问」应答词；true 为兼容写法，按有卡片、无免问处理。
   */
  waitingConfirm?: boolean | { hasCard: boolean; batchKey: boolean };
  /**
   * 停止按钮的轮次令牌（占位消息 id）：回调据此校验按钮属于当前轮次，
   * 重启后的旧卡片/上一轮的停止按钮杀不到新轮次；占位初帧尚无 id 时缺省（点击静默忽略）。
   */
  stopToken?: string;
  /** 注脚覆盖（合并场景文本裁决的免问撤销提示等）；缺省按 elapsedSec/waitingConfirm 默认注脚。 */
  noteOverride?: string;
}

/**
 * 进度卡正文（步骤轨迹文本）：buildProgressCard 的 hta_main 元素与 CardKit 流式更新共用同一份文本，
 * 前缀扩展（追加步骤行）触发打字机动画。
 */
export function progressMainText(state: Pick<ProgressCardState, 'steps' | 'current'>): string {
  const recent = state.steps.slice(-PROGRESS_CARD_MAX_STEPS);
  // 步骤标签来自 toolActionLabel 的内部文案，过 mdSafe 仅为纵深防御
  const lines = recent.map((s) => `✓ ${mdSafe(s)}`);
  if (state.current) lines.push(`⏳ ${mdSafe(state.current)}`);
  return lines.length ? lines.join('\n') : '⏳ 正在理解需求…';
}

/**
 * 等确认注脚按确认的实际展示形态分支：文本降级（无卡片）不提按钮（没有可点的卡片）；
 * 支持免问的确认补「免问」应答词（与排队回执/短应答提醒同口径）。
 */
function waitingConfirmNote(form: { hasCard: boolean; batchKey: boolean }): string {
  const answers = form.batchKey ? '「确认」/「取消」/「免问」' : '「确认」/「取消」';
  // 确认消息/卡片发于占位之后，真实方位是「下方」（合并场景确认原地画在占位上时 held 抑制更新，看不到本注脚）
  const how = form.hasCard
    ? `请先点下方确认卡片的按钮（或回复${answers}）`
    : `请回复${answers}（本次确认以文本方式发送，没有卡片按钮）`;
  return `${how} · 回复 /stop 也可中断`;
}

/**
 * 进度占位卡片（替代纯文本「⏳ 处理中…」）：蓝头 + 步骤轨迹，随工具调用原地更新；
 * 「⏹ 停止」按钮经 card.action.trigger 同步中断当前轮次（hta_stop）。
 * 带 streaming 配置与 hta_main/hta_stop 锚点：CardKit 流式更新（打字机动画）用；
 * 消息传输降级路径同样可发（streaming 配置在普通卡片上无害，终态卡整卡覆盖即清除）。
 */
export function buildProgressCard(state: ProgressCardState): Record<string, unknown> {
  const confirmForm = state.waitingConfirm === true ? { hasCard: true, batchKey: false } : state.waitingConfirm;
  const note =
    state.noteOverride ??
    (confirmForm
      ? waitingConfirmNote(confirmForm)
      : typeof state.elapsedSec === 'number'
        ? `已等待 ${state.elapsedSec} 秒 · 回复 /stop 也可中断`
        : '回复 /stop 也可中断');
  return {
    schema: '2.0',
    config: streamingCardConfig(),
    header: {
      template: state.waitingConfirm ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: state.waitingConfirm ? '⏳ 等待你处理下方的写操作确认' : '⏳ 处理中' },
    },
    body: {
      direction: 'vertical',
      elements: [
        mdEl(progressMainText(state), 'hta_main'),
        // 停止是非破坏动作（中断而非删除），与确认卡「✖️ 取消」同用 default，不用 danger 红
        { ...callbackButton('⏹ 停止', { hta_stop: state.stopToken ?? '' }), element_id: 'hta_stop' },
        noteEl(note),
      ],
    },
  };
}

/** 总用时人性化：≥120 秒换算成「N 分 N 秒」（三位数秒没有直觉）。 */
function elapsedText(sec: number): string {
  if (sec < 120) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min} 分 ${rest} 秒` : `${min} 分`;
}

/**
 * 结果卡片：正文为 LLM 回复的 markdown 渲染——最小中和（同 diagnosisMdSafe 口径：
 * < > 全角化、~~ 中和；加粗/列表/代码块等排版保留；2.0 markdown 额外支持表格/标题真渲染）。
 * 头部措辞中性（「处理结束」）：正文可能是「（无回复）」「已达上限」等非成功内容，恒称「已完成」是谎称（T31 口径）。
 */
export function buildResultCard(
  reply: string,
  meta?: { elapsedSec?: number },
  opts?: { url?: string; extraNote?: string },
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [mdEl(diagnosisMdSafe(reply || '（无回复）'))];
  if (opts?.url) {
    // 「查看任务」跳转看板任务页（单按钮：primary_filled + width fill，官方主次规范；命名与进行中/看板事件卡同口径）
    elements.push(linkButton('📋 查看任务', opts.url));
  }
  const notes: string[] = [];
  if (meta?.elapsedSec !== undefined) notes.push(`总用时约 ${elapsedText(meta.elapsedSec)}`);
  // 需持续携带的注脚（免问生效撤销指引等，见 BATCH_ACTIVE_NOTE）
  if (opts?.extraNote) notes.push(opts.extraNote);
  // 看板链接跑在本机：注明可达范围（与 buildJobProcessingCard/buildWatchEventCard 同口径）
  if (opts?.url) notes.push(linkReachNote(opts.url));
  if (notes.length) elements.push(noteEl(notes.join(' · ')));
  return {
    schema: '2.0',
    config: baseCardConfig(),
    header: { template: 'green', title: { tag: 'plain_text', content: '处理结束' } },
    body: { direction: 'vertical', elements },
  };
}

/**
 * 进度占位的终态卡片（无按钮，原地替换进度卡片）：
 * aborted = 用户中断；failed = 处理失败（详情另发消息）；seeBelow = 已完成但结果较长/轮次中有插入消息，正文在下方分段；
 * deliverFailed = 结果投递彻底失败（下方什么都没有，不得谎称「见下方」）；
 * stale = 陈旧进度卡片（机器人重启/上一轮次）被点到停止按钮时顺手收尾，不烂尾在「处理中」。
 */
export function buildProgressTerminalCard(kind: 'aborted' | 'failed' | 'seeBelow' | 'deliverFailed' | 'stale'): Record<string, unknown> {
  const meta = {
    aborted: { template: 'grey', title: '⏹ 已中断', note: '未完成的操作未执行，可继续对话。' },
    failed: { template: 'red', title: '⚠️ 处理失败', note: '失败详情见下方消息，可修正后重试。' },
    seeBelow: { template: 'green', title: '处理结束，结果见下方 ⬇️', note: '完整内容见下方消息。' },
    deliverFailed: { template: 'red', title: '⚠️ 回复投递失败', note: '请把刚才的问题再发一次。' },
    stale: { template: 'grey', title: '⏹ 该轮次已结束', note: '机器人可能已重启；如需中断当前任务，请用最新进度卡片上的「⏹ 停止」或回复 /stop。' },
  }[kind];
  return {
    schema: '2.0',
    config: baseCardConfig(),
    header: { template: meta.template, title: { tag: 'plain_text', content: meta.title } },
    body: { direction: 'vertical', elements: [noteEl(meta.note)] },
  };
}

/**
 * AI 审查/诊断/重试的「进行中」卡片：按钮点击后同步原地替换（按钮即时消失，不依赖异步 REST）。
 * 标题取自按钮 value（外部看板数据），header 用 plain_text 不经 markdown 解析；
 * url 存在时保留「📋 查看任务」链接按钮（进行中期间仍可跳转看板）。
 */
export function buildJobProcessingCard(
  title: string,
  kind: 'review' | 'diagnosis' | 'retry',
  url?: string,
): Record<string, unknown> {
  const meta = {
    review: { heading: '🤖 AI 审查进行中', note: '正在调用代码审查工具分析改动，完成后推送审查结果。', stuck: '若长时间无结果，可回复「重新审查这个任务」' },
    diagnosis: { heading: '🔍 AI 诊断进行中', note: '正在采集失败信息并调用模型分析，完成后推送诊断结果。', stuck: '若长时间无结果，可回复「为什么失败」重新诊断' },
    retry: { heading: '↻ 正在按诊断结论重试', note: '重试指令发送中，任务进展会继续推送。', stuck: '若长时间无进展，请到看板查看或手动重新发起' },
  }[kind];
  const elements: Array<Record<string, unknown>> = [
    // 作业失败/中断时卡片不会自己再变（结果推送走新消息）：注脚如实兜底并给出文本可达的出路，别让用户死等卡片；
    // 作业是进程内状态，机器人重启会中断作业（重启后补发中断通知），卡片不能永久谎称「进行中」
    mdEl(`${meta.note}\n结果或失败通知会以新消息推送。\n机器人重启会中断本次作业（重启后会推送中断通知），${meta.stuck}。`),
  ];
  if (url) {
    elements.push(linkButton('📋 查看任务', url));
    // 看板链接跑在本机：注明可达范围（与 buildWatchEventCard 同口径）
    elements.push(noteEl(linkReachNote(url)));
  }
  return {
    schema: '2.0',
    config: baseCardConfig(),
    header: { template: 'blue', title: { tag: 'plain_text', content: `${meta.heading}：《${title}》` } },
    body: { direction: 'vertical', elements },
  };
}

/** 看板事件通知的飞书卡片（2.0 schema，与确认卡片风格一致：色头 + 摘要 + 链接按钮 + 提示注脚）。 */
export function buildWatchEventCard(e: WatchEvent): Record<string, unknown> {
  const meta: Record<WatchEventKind, { template: string; title: string }> = {
    review: { template: 'yellow', title: '🔍 看板任务待审阅' },
    done: { template: 'green', title: '✅ 看板任务已完成' },
    cancelled: { template: 'grey', title: '🚫 看板任务已取消' },
    failed: { template: 'red', title: '❌ 看板任务执行失败' },
    // 计数用 total（watcher 推送前 items 已截断到 5 条，items.length 是截断后的数字）
    approvals: { template: 'blue', title: `⏳ 看板有 ${e.total ?? e.items?.length ?? 0} 个新的待审批项` },
    // 口径诚实：数据只有 updated_at，措辞是「久未更新」而非「停滞/卡死」
    stale: { template: 'orange', title: '⏰ 看板任务久未更新' },
  };
  const m = meta[e.kind];
  const elements: Array<Record<string, unknown>> = [];

  if (e.kind === 'approvals') {
    // 审批标签来自看板数据，用 plain_text 避免 markdown 字符误解析
    const items = e.items ?? [];
    const total = e.total ?? items.length;
    const lines = items.map((l) => `· ${l}`);
    // 列表被截断时补一行剩余数量，与标题计数对齐
    if (total > items.length) lines.push(`· …还有 ${total - items.length} 个`);
    elements.push(textEl(lines.join('\n')));
    elements.push({ tag: 'hr' });
    elements.push(noteEl('回复「待审批」处理'));
  } else {
    // 任务标题来自看板数据，可能含 markdown 字符：用 plain_text 避免误解析（与审批列表同一处理）
    elements.push(textEl(`《${e.title}》`));
    if (e.projectName) {
      elements.push(textEl(`项目：${e.projectName}`));
    }
    if (e.transition) {
      // 状态键翻成中文标签（进行中/待审阅/已完成…），未知状态回退原文；原文过 mdSafe 再进 markdown 内联代码
      const hasArrow = e.transition.includes('→');
      const rendered = mdSafe(
        e.transition
          .split('→')
          .map((s) => statusLabel(s.trim()))
          .join(' → '),
      );
      // 无「→」时是 watcher 塞的进展短语（如「跟进执行完成」），不是状态流转，标签用「进展」
      const label = hasArrow ? '状态变更' : '进展';
      elements.push(mdEl(`**${label}** \`${rendered}\``));
    }
    if (e.kind === 'failed') {
      elements.push(textEl(WATCH_HINT_FAILED_LOG));
    }
    if (e.extra) {
      // stale 的 extra 是停滞时长说明（自带完整语义），done 的 extra 是结果摘要
      const content = e.kind === 'stale' ? e.extra : `结果摘要：${e.extra}`;
      elements.push(textEl(content));
    }
    if (e.url) {
      // 跳转目标都是看板任务页：按钮命名统一「📋 查看任务」（同目标同文案）；
      // 主按钮（跳转）primary_filled，其余（回传按钮）default——官方主次规范
      elements.push(linkButton('📋 查看任务', e.url));
      // AI 审查：回传按钮（card.action.trigger），bot 侧调 open-code-review 跑该 attempt 的 diff
      if (e.kind === 'review' && e.attemptId) {
        elements.push(
          // 标题超 50 字符截断时补省略号，下游《标题》展示不至于残缺得无声无息；
          // url 一并带上：点击后换成的「进行中」卡片据此保留「查看任务」入口
          callbackButton('🤖 AI 审查', {
            hta_review: e.attemptId,
            title: e.title.length > 50 ? `${e.title.slice(0, 50)}…` : e.title,
            url: e.url,
          }),
        );
      }
      // AI 诊断：回传按钮，bot 侧采集失败信息调 LLM 生成中文诊断（按钮语义同 AI 审查，点击即授权）
      if (e.kind === 'failed' && e.taskId) {
        elements.push(
          callbackButton('🔍 AI 诊断', {
            hta_diagnose: e.taskId,
            attempt: e.attemptId,
            title: e.title.length > 50 ? `${e.title.slice(0, 50)}…` : e.title,
            url: e.url,
          }),
        );
      }
    }
    const hints: Partial<Record<WatchEventKind, string>> = {
      review: WATCH_HINT_REVIEW,
      done: WATCH_HINT_DONE,
      // 按钮是主路径（正式诊断 + 一键重试），回复「为什么失败」保留为备选表述（文本版无按钮，仍用 WATCH_HINT_FAILED）
      failed: '点上方「AI 诊断」自动分析失败原因；也可回复「为什么失败」',
      stale: WATCH_HINT_STALE,
    };
    // 看板链接跑在本机：注明可达范围，避免在别的网络或进程重启后点开报错
    const linkNote = e.url ? linkReachNote(e.url) : null;
    const notes = [hints[e.kind], e.url ? linkNote : null].filter(
      (t): t is string => Boolean(t),
    );
    if (notes.length) {
      elements.push({ tag: 'hr' });
      for (const t of notes) elements.push(noteEl(t));
    }
  }

  return {
    schema: '2.0',
    config: baseCardConfig(),
    header: { template: m.template, title: { tag: 'plain_text', content: m.title } },
    body: { direction: 'vertical', elements },
  };
}

/**
 * AI 审查结果卡片：头部按是否全部通过换色，正文按钮直达本机静态报告页。
 * 纯函数（不含流程与 IO），便于单测与复用。
 */
export function buildAiReviewCard(title: string, url: string, pass: boolean): Record<string, unknown> {
  // 链接可达性与 buildWatchEventCard 同口径（见 linkReachNote）
  const linkNote = linkReachNote(url);
  return {
    schema: '2.0',
    config: baseCardConfig(),
    header: {
      template: pass ? 'green' : 'yellow',
      title: {
        tag: 'plain_text',
        content: pass ? `✅ AI 审查全部通过：《${title}》` : `🤖 AI 审查完成：《${title}》`,
      },
    },
    body: {
      direction: 'vertical',
      elements: [
        mdEl(pass ? '本次变更未发现任何问题。' : '审查完成，详细意见见完整报告。'),
        linkButton('📄 查看完整报告', url),
        noteEl(pass ? `可继续追问审查结论 · ${linkNote}` : `可回复「按审查意见修一下」 · ${linkNote}`),
      ],
    },
  };
}

/** 按钮 value 里的标题与 hta_review 同口径：超 50 字符截断补省略号。 */
function buttonTitle(title: string): string {
  return title.length > 50 ? `${title.slice(0, 50)}…` : title;
}

/**
 * 诊断结论（LLM 输出）进 markdown 前的最小中和：诊断材料含失败日志/任务描述等外部可控数据，
 * 经 LLM 复述后 <font color>/<at id> 类标签与 ~~ 删除线会真实渲染（可伪造警示或钓鱼样式），
 * < > 全角化、~~ 中和；星号/括号等正常 markdown 排版保留（诊断三段式排版依赖加粗与列表）。
 */
function diagnosisMdSafe(s: string): string {
  return s.replace(/</g, '＜').replace(/>/g, '＞').replace(/~~/g, '～～');
}

/**
 * 失败诊断结果卡片：正文为 LLM 中文诊断（超长截断，完整结论已注入会话），
 * 带「↻ 按诊断结论重试」按钮（点击即显式授权，bot 以诊断结论作 follow-up 重启任务）。
 * settledAt 提供时为重试发起后的终态卡片（原地替换，按钮消失，参照确认卡片终态模式）；
 * followUpExcerpt 为已发送的 follow-up 指令摘要（双向截断，handler 侧生成）——
 * 重试指令直发执行方用户原本看不到，终态卡片留一份可见记录。
 * url 为看板任务链接（随诊断结果留存）：重试按钮带上它，点击后换成的「进行中」卡片与重试终态卡片据此保留「查看任务」入口。
 */
export function buildDiagnosisCard(
  title: string,
  diagnosis: string,
  taskId: string,
  opts?: { settledAt?: string; followUpExcerpt?: string; url?: string },
): Record<string, unknown> {
  const text = diagnosisMdSafe(
    diagnosis.length > DIAGNOSIS_CARD_MAX_CHARS
      ? `${diagnosis.slice(0, DIAGNOSIS_CARD_MAX_CHARS)}\n…（过长已截断，完整结论可直接追问）`
      : diagnosis,
  );
  const elements: Array<Record<string, unknown>> = [
    // 诊断结论是 LLM 输出（markdown 为预期格式）：最小中和后按 markdown 渲染（见 diagnosisMdSafe）
    mdEl(text),
  ];
  if (opts?.settledAt) {
    elements.push({ tag: 'hr' });
    if (opts.followUpExcerpt) {
      // 外部内容（LLM 诊断复述）用 plain_text，不经 markdown 渲染
      elements.push(textEl(`已发送的跟进指令：\n${opts.followUpExcerpt}`));
    }
    // 终态补看板入口（与进行中卡片同口径）：注脚里的「看板」有真实可达路径
    if (opts.url) {
      elements.push(linkButton('📋 查看任务', opts.url));
      elements.push(noteEl(linkReachNote(opts.url)));
    }
    const stuckTail = opts.url ? '如长时间无进展，点上方「查看任务」到看板跟进。' : '如长时间无进展，请到看板查看或手动重新发起。';
    elements.push(noteEl(`已于 ${opts.settledAt} 按以上结论发起重试，任务进展会继续推送；${stuckTail}`));
  } else {
    elements.push(
      callbackButton(
        '↻ 按诊断结论重试',
        { hta_retry: taskId, title: buttonTitle(title), ...(opts?.url ? { url: opts.url } : {}) },
        'primary_filled',
      ),
    );
    elements.push(noteEl('重试会把以上诊断结论作为跟进指令发给任务执行方（点击即发起，不再二次确认）'));
  }
  return {
    schema: '2.0',
    config: baseCardConfig(),
    header: {
      template: opts?.settledAt ? 'grey' : 'blue',
      title: {
        tag: 'plain_text',
        content: opts?.settledAt ? `↻ 已按诊断结论重试：《${title}》` : `🔍 AI 失败诊断：《${title}》`,
      },
    },
    body: { direction: 'vertical', elements },
  };
}
