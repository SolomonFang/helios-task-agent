import fs from 'fs';
import path from 'path';
import { writeFilePrivateSync } from '../private-file';
import { apiGet, taskPageUrl, attemptDiffUrl, pickLatestAttempt } from './http';

/**
 * Kanban watcher: polls the kanban REST API and pushes proactive Feishu
 * notifications when tasks enter review / finish / fail or new approvals appear.
 * First successful poll only establishes a baseline (no notification storm).
 */

interface WatchTaskState {
  title: string;
  status: string;
  running: boolean;
  failed: boolean;
  projectId: string;
}

interface WatchApproval {
  id: string;
  label: string;
}

interface WatchState {
  tasks: Record<string, WatchTaskState>;
  approvals: WatchApproval[];
}

interface KanbanTaskRow {
  id?: string;
  title?: string;
  status?: string;
  has_in_progress_attempt?: boolean;
  last_attempt_failed?: boolean;
}

export type WatchEventKind = 'review' | 'done' | 'cancelled' | 'failed' | 'approvals';

/** 一条看板状态事件：结构化字段用于渲染飞书卡片，text 为纯文本版本（会话注入 + 卡片发送失败时降级）。 */
export interface WatchEvent {
  kind: WatchEventKind;
  /** 任务标题；approvals 事件为空串。 */
  title: string;
  /** 状态迁移描述，如 "todo → inreview"；review 的兜底场景为「跟进执行完成」。 */
  transition?: string;
  /** 主链接（review/done 优先 diff 视图，failed 为任务页）。 */
  url?: string;
  /** review 事件的最新 attempt id：卡片「AI 审查」按钮回传用。 */
  attemptId?: string;
  /** 结果摘要原文（已截断，无前缀）。 */
  extra?: string;
  /** 待审批标签列表（kind === 'approvals'）。 */
  items?: string[];
  /** 纯文本版本，与卡片内容等价。 */
  text: string;
}

export interface KanbanWatcherOptions {
  kanbanUrl: string;
  /** Limit polling to one project; otherwise all projects are watched. */
  projectId?: string;
  intervalMs?: number;
  statePath: string;
  notify: (event: WatchEvent) => Promise<void>;
  log?: (msg: string) => void;
}

export class KanbanWatcher {
  private readonly opts: KanbanWatcherOptions;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private state: WatchState | null;

  constructor(opts: KanbanWatcherOptions) {
    this.opts = opts;
    this.state = this.load();
  }

  start(): void {
    const interval = Math.max(15000, this.opts.intervalMs ?? 60000);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private load(): WatchState | null {
    try {
      if (!fs.existsSync(this.opts.statePath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8')) as Omit<WatchState, 'approvals'> & {
        approvals?: Array<string | WatchApproval>;
      };
      if (!raw || typeof raw !== 'object' || !raw.tasks) return null;
      // 兼容旧格式（approvals 为 string[]）
      const approvals = Array.isArray(raw.approvals)
        ? raw.approvals
            .map((a) => (typeof a === 'string' ? { id: a, label: a } : a))
            .filter((a) => a && typeof a.id === 'string' && a.id)
        : [];
      return { tasks: raw.tasks, approvals };
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.${process.pid}.tmp`;
      writeFilePrivateSync(tmp, JSON.stringify(this.state, null, 2) + '\n');
      fs.renameSync(tmp, this.opts.statePath);
    } catch {
      /* best-effort */
    }
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const current = await this.collect();
      const prev = this.state;
      if (!prev) {
        this.state = current;
        this.persist();
        this.opts.log?.(`基线已建立（${Object.keys(current.tasks).length} 个任务）`);
        return;
      }
      const events: WatchEvent[] = [];
      for (const [id, cur] of Object.entries(current.tasks)) {
        const old = prev.tasks[id];
        if (!old) continue; // 新任务不打扰（创建流程本身已有反馈）
        const url = this.taskUrl(cur.projectId, id);
        // 进入待审阅：状态变为 inreview，或状态停在 inreview 但跟进已跑完（running 翻转兜底）
        const enteredReview = cur.status === 'inreview' && old.status !== 'inreview' && !cur.failed;
        const finishedInReview =
          cur.status === 'inreview' && old.status === 'inreview' && old.running && !cur.running && !cur.failed;
        if (enteredReview || finishedInReview) {
          const transition = enteredReview ? `${old.status} → ${cur.status}` : '跟进执行完成';
          const review = await this.reviewTarget(cur.projectId, id);
          events.push({
            kind: 'review',
            title: cur.title,
            transition,
            url: review.url,
            attemptId: review.attemptId,
            text: `🔍 看板任务待审阅：《${cur.title}》（${transition}）\n${review.url}\n点开链接人工审查 diff，或点卡片「AI 审查」让 AI 先过一遍；没问题回复「标记完成」，要继续改直接说`,
          });
          continue; // 待审阅已提示，同一 tick 不再重复其它状态通知
        }
        if (cur.status !== old.status && (cur.status === 'done' || cur.status === 'cancelled')) {
          const label = cur.status === 'done' ? '✅ 看板任务已完成' : '🚫 看板任务已取消';
          const hint = cur.status === 'done' ? '\n回复「帮我审一下」看结果，或「再跟它说一句…」继续迭代' : '';
          let extra = '';
          let link = url;
          if (cur.status === 'done') {
            link = (await this.reviewTarget(cur.projectId, id)).url;
            try {
              extra = KanbanWatcher.pickDetail(await this.api(`/tasks/${id}`));
            } catch {
              /* 详情拉取失败不阻断通知 */
            }
          }
          events.push({
            kind: cur.status === 'done' ? 'done' : 'cancelled',
            title: cur.title,
            transition: `${old.status} → ${cur.status}`,
            url: link,
            extra: extra || undefined,
            text: `${label}：《${cur.title}》（${old.status} → ${cur.status}）\n${link}${extra ? `\n结果摘要：${extra}` : ''}${hint}`,
          });
        }
        if (old.running && !cur.running && cur.failed) {
          events.push({
            kind: 'failed',
            title: cur.title,
            url,
            text: `❌ 看板任务执行失败：《${cur.title}》，请到看板查看日志\n${url}\n回复「为什么失败」让它分析原因`,
          });
        }
      }
      const newApprovals = current.approvals.filter((a) => !prev.approvals.some((p) => p.id === a.id));
      if (newApprovals.length) {
        const lines = newApprovals
          .slice(0, 5)
          .map((a) => `· ${a.label}`)
          .join('\n');
        events.push({
          kind: 'approvals',
          title: '',
          items: newApprovals.slice(0, 5).map((a) => a.label),
          text: `⏳ 看板有 ${newApprovals.length} 个新的待审批项：\n${lines}\n回复「待审批」处理`,
        });
      }
      // 推送失败不推进 state：下一轮基于旧快照重新 diff，事件不丢。
      // 代价是部分送达的事件可能重复推送——重复优于丢失。
      let delivered = true;
      for (const e of events) {
        try {
          await this.opts.notify(e);
        } catch (err) {
          delivered = false;
          this.opts.log?.(
            `事件推送失败（${e.kind}《${e.title}》）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (delivered) {
        this.state = current;
        this.persist();
      } else {
        this.opts.log?.('存在推送失败，状态快照未推进，下轮将重试未送达事件');
      }
    } catch (err) {
      this.opts.log?.(`轮询失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private async collect(): Promise<WatchState> {
    const projectIds = this.opts.projectId ? [this.opts.projectId] : await this.fetchProjectIds();
    const tasks: Record<string, WatchTaskState> = {};
    for (const pid of projectIds) {
      const list = (await this.api(`/tasks?project_id=${pid}`)) as KanbanTaskRow[];
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        if (!t.id) continue;
        tasks[t.id] = {
          title: t.title || '',
          status: t.status || '',
          running: Boolean(t.has_in_progress_attempt),
          failed: Boolean(t.last_attempt_failed),
          projectId: pid,
        };
      }
    }
    let approvals: WatchApproval[] = [];
    try {
      const list = (await this.api('/approvals')) as Array<Record<string, unknown>>;
      if (Array.isArray(list)) {
        approvals = list
          .filter((a) => /pending/i.test(JSON.stringify(a)))
          .map((a) => {
            const id = String(a.id || '');
            const label = String(a.title || a.task_title || a.name || a.summary || id);
            return { id, label };
          })
          .filter((a) => a.id);
      }
    } catch {
      /* approvals 端点可选，失败不阻断任务监控 */
    }
    return { tasks, approvals };
  }

  /** 宽松提取任务详情里的可读摘要（看板版本间字段可能不同，取不到就静默兜底）。 */
  private static pickDetail(detail: unknown): string {
    if (!detail || typeof detail !== 'object') return '';
    const o = detail as Record<string, unknown>;
    const summary = o.last_attempt_summary ?? o.summary ?? o.result ?? o.last_attempt_output;
    if (typeof summary === 'string' && summary.trim()) {
      const t = summary.trim();
      return `${t.slice(0, 200)}${t.length > 200 ? '…' : ''}`;
    }
    return '';
  }

  private async fetchProjectIds(): Promise<string[]> {
    const list = (await this.api('/projects')) as Array<{ id?: string }>;
    return Array.isArray(list) ? list.map((p) => p.id || '').filter(Boolean) : [];
  }

  private taskUrl(projectId: string, taskId: string): string {
    return taskPageUrl(this.opts.kanbanUrl, projectId, taskId);
  }

  /** 最新 attempt 的 diff 视图地址与 attempt id；取不到 attempt 时回退任务页。 */
  private async reviewTarget(projectId: string, taskId: string): Promise<{ url: string; attemptId?: string }> {
    const base = this.taskUrl(projectId, taskId);
    try {
      const latest = pickLatestAttempt(await this.api(`/task-attempts?task_id=${taskId}`));
      if (!latest) return { url: base };
      return { url: attemptDiffUrl(base, latest.id), attemptId: latest.id };
    } catch {
      return { url: base }; // attempts 拉取失败不阻断通知，回退任务页
    }
  }

  private async api(p: string): Promise<unknown> {
    return apiGet(this.opts.kanbanUrl, p);
  }
}

/** 判断 URL 主机是否为 loopback（localhost / 127.x / ::1）：推送链接在手机上不可达的场景识别用。 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || h.startsWith('127.');
  } catch {
    return false;
  }
}

/** 看板事件通知的飞书卡片（legacy schema，与确认卡片风格一致：色头 + 摘要 + 链接按钮 + 提示注脚）。 */
export function buildWatchEventCard(e: WatchEvent): Record<string, unknown> {
  const meta: Record<WatchEventKind, { template: string; title: string }> = {
    review: { template: 'yellow', title: '🔍 看板任务待审阅' },
    done: { template: 'green', title: '✅ 看板任务已完成' },
    cancelled: { template: 'grey', title: '🚫 看板任务已取消' },
    failed: { template: 'red', title: '❌ 看板任务执行失败' },
    approvals: { template: 'blue', title: `⏳ 看板有 ${e.items?.length ?? 0} 个新的待审批项` },
  };
  const m = meta[e.kind];
  const elements: Array<Record<string, unknown>> = [];

  if (e.kind === 'approvals') {
    // 审批标签来自看板数据，用 plain_text 避免 markdown 字符误解析
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: (e.items ?? []).map((l) => `· ${l}`).join('\n') } });
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '回复「待审批」处理' }] });
  } else {
    // 任务标题来自看板数据，可能含 markdown 字符：用 plain_text 避免误解析（与审批列表同一处理）
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `《${e.title}》` } });
    if (e.transition) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**状态变更** \`${e.transition}\`` } });
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
      review: '「AI 审查」让 AI 先过一遍 diff；没问题回复「标记完成」，要继续改直接说',
      done: '回复「帮我审一下」看结果，或「再跟它说一句…」继续迭代',
      failed: '回复「为什么失败」让它分析原因',
    };
    // 看板链接跑在本机：注明可达范围，避免在别的网络或进程重启后点开报错；
    // loopback（localhost/127.x/::1）连同一局域网都不可达，注脚需区分
    const linkNote =
      e.url && isLoopbackUrl(e.url)
        ? '链接仅在运行本机器人的电脑上可达（本机地址，手机/局域网打不开），进程重启后失效。'
        : '链接仅在运行本机器人的电脑所在网络可达，进程重启后失效。';
    const notes = [hints[e.kind], e.url ? linkNote : null].filter(
      (t): t is string => Boolean(t),
    );
    if (notes.length) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'note', elements: notes.map((t) => ({ tag: 'plain_text', content: t })) });
    }
  }

  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: m.template, title: { tag: 'plain_text', content: m.title } },
    elements,
  };
}
