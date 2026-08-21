/**
 * 飞书交互卡片（legacy card schema）构建统一收口：
 * - 写操作确认卡片 / 确认终态卡片（buildConfirmCard / buildResolvedCard）
 * - 看板事件通知卡片（buildWatchEventCard）
 * - AI 审查结果卡片（buildAiReviewCard）
 * 共同约定（baseCardConfig）：宽屏模式 + enable_forward:false——卡片内含本机链接
 * 与写操作按钮，被转发后链接不可达、按钮语义越权，一律禁止转发。
 */

import { kindLabel, type ConfirmRequest, type ConfirmSettle } from '../agent/guard';
import { WATCH_HINT_DONE, WATCH_HINT_FAILED, type WatchEvent, type WatchEventKind } from '../kanban/watcher';
import { statusLabel } from '../kanban/summary';
import { isLoopbackUrl } from '../infra/url-utils';

/** 全部卡片的共同 config：宽屏 + 禁止转发（见文件头注释）。 */
function baseCardConfig(): Record<string, unknown> {
  return { wide_screen_mode: true, enable_forward: false };
}

/** lark_md 代码块包裹命令详情；三连反引号会破坏围栏，先转义。 */
function detailCodeBlock(detail: string): string {
  return '```\n' + detail.replace(/```/g, "'''") + '\n```';
}

/** 嵌入 lark_md 的用户数据（任务标题等）：星号/反引号全角化并中和 [ ]( ) 链接语法，避免误触加粗/代码/链接解析破坏排版。 */
function mdSafe(s: string): string {
  return s
    .replace(/\*/g, '＊')
    .replace(/`/g, '｀')
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
      text: { tag: 'plain_text', content: '🔁 同类免问（本会话）' },
      value: { hta_confirm: id, decision: 'batch' },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '✖️ 取消' },
    // 取消是安全操作，不用 danger 红——红色留给真正的破坏性动作本身（卡片 header 橙色已承担警示）
    value: { hta_confirm: id, decision: 'no' },
  });
  // 精简版注脚：有效期与文本回复方式合并为一行（操作类型已在标题体现，不再单列 fields）
  const replyHint = req.batchKey
    ? `${timeoutSec} 秒内有效 · 回复「确认」/「同类免问」/「取消」`
    : `${timeoutSec} 秒内有效 · 回复「确认」/「取消」`;
  return {
    config: baseCardConfig(),
    header: {
      // 写操作确认一律橙色警示头（蓝色只用于纯信息场景，如待审批通知）
      template: 'orange',
      title: { tag: 'plain_text', content: `${isLark ? '✉️' : '🔧'} ${kindText} · 写操作确认` },
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
      title: `🔁 ${kindText} · 写操作已批准（同类免问 · 本会话）`,
      note: '回复「恢复确认」可随时撤销免问；重启后自动失效。',
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

/** 看板事件通知的飞书卡片（legacy schema，与确认卡片风格一致：色头 + 摘要 + 链接按钮 + 提示注脚）。 */
export function buildWatchEventCard(e: WatchEvent): Record<string, unknown> {
  const meta: Record<WatchEventKind, { template: string; title: string }> = {
    review: { template: 'yellow', title: '🔍 看板任务待审阅' },
    done: { template: 'green', title: '✅ 看板任务已完成' },
    cancelled: { template: 'grey', title: '🚫 看板任务已取消' },
    failed: { template: 'red', title: '❌ 看板任务执行失败' },
    // 计数用 total（watcher 推送前 items 已截断到 5 条，items.length 是截断后的数字）
    approvals: { template: 'blue', title: `⏳ 看板有 ${e.total ?? e.items?.length ?? 0} 个新的待审批项` },
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
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: '请到看板查看日志定位问题。' } });
    }
    if (e.extra) {
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: `结果摘要：${e.extra}` } });
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
          value: { hta_review: e.attemptId, title: e.title.slice(0, 50) },
        });
      }
      elements.push({ tag: 'action', actions });
    }
    const hints: Partial<Record<WatchEventKind, string>> = {
      review: '没问题回复「标记完成」；要继续改直接说',
      done: WATCH_HINT_DONE,
      failed: WATCH_HINT_FAILED,
    };
    // 看板链接跑在本机：注明可达范围，避免在别的网络或进程重启后点开报错；
    // loopback（localhost/127.x/::1）连同一局域网都不可达，注脚需区分
    const linkNote =
      e.url && isLoopbackUrl(e.url)
        ? '链接仅本机可达（手机/局域网打不开），重启后失效。'
        : '链接仅本机所在网络可达，重启后失效。';
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
  // 链接可达性与 buildWatchEventCard 同口径：report-server 绑 0.0.0.0/局域网地址时手机/局域网可达，
  // 仅 loopback（localhost/127.x/::1）才是「仅本机可达」
  const linkNote = isLoopbackUrl(url)
    ? '链接仅本机可达（手机/局域网打不开），重启后失效。'
    : '链接仅本机所在网络可达，重启后失效。';
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
