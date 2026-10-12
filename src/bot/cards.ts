/**
 * 飞书交互卡片（legacy card schema）构建统一收口：
 * - 写操作确认卡片 / 确认终态卡片（buildConfirmCard / buildResolvedCard）
 * - 进度占位卡片 / 结果卡片 / 进度终态卡片（buildProgressCard / buildResultCard / buildProgressTerminalCard）
 * - AI 审查/诊断/重试「进行中」卡片（buildJobProcessingCard，按钮点击后同步换卡，按钮即时消失）
 * - 看板事件通知卡片（buildWatchEventCard，含停滞提醒与失败「AI 诊断」按钮）
 * - AI 审查结果卡片（buildAiReviewCard）
 * - 失败诊断结果卡片（buildDiagnosisCard，含「按诊断结论重试」按钮与重试后终态）
 * 共同约定（baseCardConfig）：宽屏模式 + enable_forward:false——卡片内含本机链接
 * 与写操作按钮，被转发后链接不可达、按钮语义越权，一律禁止转发。
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

/** 全部卡片的共同 config：宽屏 + 禁止转发（见文件头注释）。 */
function baseCardConfig(): Record<string, unknown> {
  return { wide_screen_mode: true, enable_forward: false };
}

/** lark_md 代码块包裹命令详情；三连反引号会破坏围栏，先转义。 */
function detailCodeBlock(detail: string): string {
  return '```\n' + detail.replace(/```/g, "'''") + '\n```';
}

/**
 * 嵌入 lark_md 的用户数据（任务标题等）：星号/反引号/括号全角化并中和 [ ] 链接语法，
 * 同时中和 ~~（删除线）、<font color>/<at id> 等类 HTML 标签语法（< > 全角化），
 * 避免误触加粗/代码/链接/删除线/标签解析破坏排版。
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

/** Interactive card shown for a pending write operation (legacy card schema). */
export function buildConfirmCard(req: ConfirmRequest, id: string, timeoutMs = 120000): Record<string, unknown> {
  const isLark = req.kind === 'lark';
  const kindText = kindLabel(req.kind);
  const timeoutSec = Math.round(timeoutMs / 1000);
  const actions: Record<string, unknown>[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 确认执行（仅此次）' },
      type: 'primary',
      value: { hta_confirm: id, decision: 'yes' },
    },
  ];
  if (req.batchKey) {
    actions.push({
      tag: 'button',
      // 粒度如实标注：对象级免问（删除/审批等）只说「同对象」，避免用户误以为整个类都放行
      text: { tag: 'plain_text', content: `🔁 ${batchScopeWord(req.batchScope)}免问（本会话）` },
      value: { hta_confirm: id, decision: 'batch' },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '✖️ 取消' },
    // 取消是安全操作，不用 danger 红——红色留给真正的破坏性动作本身（卡片 header 橙色已承担警示）
    value: { hta_confirm: id, decision: 'no' },
  });
  // 精简版注脚：有效期（含超时后果，与文本降级版口径一致）与文本回复方式合并为一行
  const replyHint = req.batchKey
    ? `${timeoutSec} 秒内有效（超时自动拒绝） · 回复「确认」/「${batchScopeWord(req.batchScope)}免问」/「取消」`
    : `${timeoutSec} 秒内有效（超时自动拒绝） · 回复「确认」/「取消」`;
  return {
    config: baseCardConfig(),
    header: {
      // 写操作确认一律橙色警示头（蓝色只用于纯信息场景，如待审批通知）；
      // 破坏性操作标题补「· 高危」，与 CLI 闸口（cli.ts confirmWrite）口径一致
      template: 'orange',
      title: { tag: 'plain_text', content: `${isLark ? '✉️' : '🔧'} ${kindText} · 写操作确认${req.destructive ? ' · 高危' : ''}` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${mdSafe(req.summary)}**` } },
      { tag: 'div', text: { tag: 'lark_md', content: detailCodeBlock(req.detail) } },
      { tag: 'action', actions },
      { tag: 'note', elements: [{ tag: 'plain_text', content: replyHint }] },
    ],
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
    config: baseCardConfig(),
    header: {
      template: m.template,
      title: { tag: 'plain_text', content: m.title },
    },
    elements: [
      // 终态卡片原地替换确认卡片，命令细节用户刚看过，不再重复展示
      { tag: 'div', text: { tag: 'lark_md', content: `**${mdSafe(req.summary)}**` } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `${m.note} · ${time}` }] },
    ],
  };
}

/**
 * 结果卡片正文的字节上限：飞书卡片请求体上限约 30KB（按字节计），取保守值；
 * 超长回复不进卡片，走「卡片收尾为 seeBelow 终态 + 文本分段」路径（内容不丢）。
 */
export const RESULT_CARD_MAX_BYTES = 28000;

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
}

/**
 * 等确认注脚按确认的实际展示形态分支：文本降级（无卡片）不提按钮（没有可点的卡片）；
 * 支持免问的确认补「免问」应答词（与排队回执/短应答提醒同口径）。
 */
function waitingConfirmNote(form: { hasCard: boolean; batchKey: boolean }): string {
  const answers = form.batchKey ? '「确认」/「取消」/「免问」' : '「确认」/「取消」';
  const how = form.hasCard
    ? `请先点上方确认卡片的按钮（或回复${answers}）`
    : `请回复${answers}（本次确认以文本方式发送，没有卡片按钮）`;
  return `${how} · 回复 /stop 也可中断`;
}

/**
 * 进度占位卡片（替代纯文本「⏳ 处理中…」）：蓝头 + 步骤轨迹，随工具调用原地更新；
 * 「⏹ 停止」按钮经 card.action.trigger 同步中断当前轮次（hta_stop）。
 */
export function buildProgressCard(state: ProgressCardState): Record<string, unknown> {
  const recent = state.steps.slice(-PROGRESS_CARD_MAX_STEPS);
  // 步骤标签来自 toolActionLabel 的内部文案，过 mdSafe 仅为纵深防御
  const lines = recent.map((s) => `✓ ${mdSafe(s)}`);
  if (state.current) lines.push(`⏳ ${mdSafe(state.current)}`);
  const confirmForm = state.waitingConfirm === true ? { hasCard: true, batchKey: false } : state.waitingConfirm;
  const note = confirmForm
    ? waitingConfirmNote(confirmForm)
    : typeof state.elapsedSec === 'number'
      ? `已等待 ${state.elapsedSec} 秒 · 回复 /stop 也可中断`
      : '回复 /stop 也可中断';
  return {
    config: baseCardConfig(),
    header: {
      template: state.waitingConfirm ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: state.waitingConfirm ? '⏳ 等待你处理上方的写操作确认' : '⏳ 处理中' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.length ? lines.join('\n') : '⏳ 正在理解需求…' } },
      {
        tag: 'action',
        actions: [{ tag: 'button', text: { tag: 'plain_text', content: '⏹ 停止' }, value: { hta_stop: state.stopToken ?? '' } }],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: note }] },
    ],
  };
}

/**
 * 结果卡片：正文为 LLM 回复的 lark_md 渲染——最小中和（同 diagnosisMdSafe 口径：
 * < > 全角化、~~ 中和；加粗/列表/代码块等排版保留）。
 * 头部措辞中性（「处理结束」）：正文可能是「（无回复）」「已达上限」等非成功内容，恒称「已完成」是谎称（T31 口径）。
 * legacy lark_md 只支持部分 Markdown：`#` 标题、`>` 引用、行内代码、表格等会原样显示
 * （可接受，不丢内容；不要指望它们被渲染）。
 */
export function buildResultCard(reply: string, meta?: { elapsedSec?: number }): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', text: { tag: 'lark_md', content: diagnosisMdSafe(reply || '（无回复）') } },
  ];
  if (meta?.elapsedSec !== undefined) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `总用时约 ${meta.elapsedSec} 秒` }] });
  }
  return {
    config: baseCardConfig(),
    header: { template: 'green', title: { tag: 'plain_text', content: '处理结束' } },
    elements,
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
    config: baseCardConfig(),
    header: { template: meta.template, title: { tag: 'plain_text', content: meta.title } },
    elements: [{ tag: 'note', elements: [{ tag: 'plain_text', content: meta.note }] }],
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
    review: { heading: '🤖 AI 审查进行中', note: '正在调用代码审查工具分析改动，完成后推送审查结果。' },
    diagnosis: { heading: '🔍 AI 诊断进行中', note: '正在采集失败信息并调用模型分析，完成后推送诊断结果。' },
    retry: { heading: '↻ 正在按诊断结论重试', note: '重试指令发送中，任务进展会继续推送；如长时间无进展，请到看板查看或手动重新发起。' },
  }[kind];
  const elements: Array<Record<string, unknown>> = [
    // 作业失败/中断时卡片不会自己再变（结果推送走新消息）：注脚如实兜底，别让用户死等卡片；
    // 作业是进程内状态，机器人重启后静默消亡，卡片不能永久谎称「进行中」
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${meta.note}\n结果或失败通知会以新消息推送。\n机器人重启会使本次作业中断且不通知，若长时间无结果请重新发起。`,
      },
    },
  ];
  if (url) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '📋 查看任务' },
          type: 'primary',
          url,
          multi_url: { url, android_url: url, ios_url: url, pc_url: url },
        },
      ],
    });
    // 看板链接跑在本机：注明可达范围（与 buildWatchEventCard 同口径）
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: linkReachNote(url) }] });
  }
  return {
    config: baseCardConfig(),
    header: { template: 'blue', title: { tag: 'plain_text', content: `${meta.heading}：《${title}》` } },
    elements,
  };
}

/** 看板事件通知的飞书卡片（legacy schema，与确认卡片风格一致：色头 + 摘要 + 链接按钮 + 提示注脚）。 */
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
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } });
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '回复「待审批」处理' }] });
  } else {
    // 任务标题来自看板数据，可能含 markdown 字符：用 plain_text 避免误解析（与审批列表同一处理）
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `《${e.title}》` } });
    if (e.projectName) {
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: `项目：${e.projectName}` } });
    }
    if (e.transition) {
      // 状态键翻成中文标签（进行中/待审阅/已完成…），未知状态回退原文；原文过 mdSafe 再进 lark_md 内联代码
      const hasArrow = e.transition.includes('→');
      const rendered = mdSafe(
        e.transition
          .split('→')
          .map((s) => statusLabel(s.trim()))
          .join(' → '),
      );
      // 无「→」时是 watcher 塞的进展短语（如「跟进执行完成」），不是状态流转，标签用「进展」
      const label = hasArrow ? '状态变更' : '进展';
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${label}** \`${rendered}\`` } });
    }
    if (e.kind === 'failed') {
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: WATCH_HINT_FAILED_LOG } });
    }
    if (e.extra) {
      // stale 的 extra 是停滞时长说明（自带完整语义），done 的 extra 是结果摘要
      const content = e.kind === 'stale' ? e.extra : `结果摘要：${e.extra}`;
      elements.push({ tag: 'div', text: { tag: 'plain_text', content } });
    }
    if (e.url) {
      const btn = e.kind === 'review' ? '🔍 人工审查' : e.kind === 'done' ? '👀 查看结果' : '📋 查看任务';
      const actions: Array<Record<string, unknown>> = [
        { tag: 'button', text: { tag: 'plain_text', content: btn }, type: 'primary', url: e.url },
      ];
      // AI 审查：回传按钮（card.action.trigger），bot 侧调 open-code-review 跑该 attempt 的 diff
      if (e.kind === 'review' && e.attemptId) {
        actions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '🤖 AI 审查' },
          // 标题超 50 字符截断时补省略号，下游《标题》展示不至于残缺得无声无息；
          // url 一并带上：点击后换成的「进行中」卡片据此保留「查看任务」入口
          value: { hta_review: e.attemptId, title: e.title.length > 50 ? `${e.title.slice(0, 50)}…` : e.title, url: e.url },
        });
      }
      // AI 诊断：回传按钮，bot 侧采集失败信息调 LLM 生成中文诊断（按钮语义同 AI 审查，点击即授权）
      if (e.kind === 'failed' && e.taskId) {
        actions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '🔍 AI 诊断' },
          value: {
            hta_diagnose: e.taskId,
            attempt: e.attemptId,
            title: e.title.length > 50 ? `${e.title.slice(0, 50)}…` : e.title,
            url: e.url,
          },
        });
      }
      elements.push({ tag: 'action', actions });
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
      elements.push({ tag: 'note', elements: notes.map((t) => ({ tag: 'plain_text', content: t })) });
    }
  }

  return {
    config: baseCardConfig(),
    header: { template: m.template, title: { tag: 'plain_text', content: m.title } },
    elements,
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
    config: baseCardConfig(),
    header: {
      template: pass ? 'green' : 'yellow',
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
          content: pass ? '本次变更未发现任何问题。' : '审查完成，详细意见见完整报告。',
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
              ? `可继续追问审查结论 · ${linkNote}`
              : `可回复「按审查意见修一下」 · ${linkNote}`,
          },
        ],
      },
    ],
  };
}

/** 按钮 value 里的标题与 hta_review 同口径：超 50 字符截断补省略号。 */
function buttonTitle(title: string): string {
  return title.length > 50 ? `${title.slice(0, 50)}…` : title;
}

/**
 * 诊断结论（LLM 输出）进 lark_md 前的最小中和：诊断材料含失败日志/任务描述等外部可控数据，
 * 经 LLM 复述后 <font color>/<at id> 类标签与 ~~ 删除线会真实渲染（可伪造警示或钓鱼样式），
 * < > 全角化、~~ 中和；星号/括号等正常 markdown 排版保留（诊断三段式排版依赖加粗与列表）。
 * 注意 legacy lark_md 只支持部分 Markdown：`#` 标题、`>` 引用、行内代码、表格等会原样显示。
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
 * url 为看板任务链接（随诊断结果留存）：重试按钮带上它，点击后换成的「进行中」卡片据此保留「查看任务」入口。
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
    // 诊断结论是 LLM 输出（markdown 为预期格式）：最小中和后按 lark_md 渲染（见 diagnosisMdSafe）
    { tag: 'div', text: { tag: 'lark_md', content: text } },
  ];
  if (opts?.settledAt) {
    elements.push({ tag: 'hr' });
    if (opts.followUpExcerpt) {
      // 外部内容（LLM 诊断复述）用 plain_text，不经 lark_md 渲染
      elements.push({
        tag: 'div',
        text: { tag: 'plain_text', content: `已发送的跟进指令：\n${opts.followUpExcerpt}` },
      });
    }
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `已于 ${opts.settledAt} 按以上结论发起重试，任务进展会继续推送；如长时间无进展，请到看板查看或手动重新发起。` }],
    });
  } else {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '↻ 按诊断结论重试' },
          type: 'primary',
          value: { hta_retry: taskId, title: buttonTitle(title), ...(opts?.url ? { url: opts.url } : {}) },
        },
      ],
    });
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: '重试会把以上诊断结论作为跟进指令发给任务执行方（点击即发起，不再二次确认）' },
      ],
    });
  }
  return {
    config: baseCardConfig(),
    header: {
      template: opts?.settledAt ? 'grey' : 'blue',
      title: {
        tag: 'plain_text',
        content: opts?.settledAt ? `↻ 已按诊断结论重试：《${title}》` : `🔍 AI 失败诊断：《${title}》`,
      },
    },
    elements,
  };
}
