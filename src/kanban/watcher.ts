import fs from 'fs';
import { writeFileAtomicPrivateSync } from '../infra/private-file';
import { errMessage } from '../infra/err';
import {
  apiGet,
  taskPageUrl,
  attemptDiffUrl,
  pickLatestAttempt,
  validateKanbanTaskRows,
  validateKanbanProjectRows,
  type KanbanTaskRow,
  type KanbanProjectRow,
} from './http';
import { statusLabel } from './summary';

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

/** 待重投事件：事件载荷 + 已送达 owner 集合（单通道回调用占位 owner ''）。 */
interface PendingWatchEvent {
  event: WatchEvent;
  delivered: string[];
  /** 首次进入重投队列的时间（ms epoch）：超 TTL 未送达即丢弃，防 owner 长期不可达时无界增长。 */
  enqueuedAt: number;
}

interface WatchState {
  tasks: Record<string, WatchTaskState>;
  approvals: WatchApproval[];
  /** 未全员送达的事件：eventId → 送达进度，随 state 文件持久化，下轮仅重投未送达组合。 */
  pending?: Record<string, PendingWatchEvent>;
}

export type WatchEventKind = 'review' | 'done' | 'cancelled' | 'failed' | 'approvals';

/** done 事件的统一后续指引（文本版与卡片版同源，改动只动一处）。 */
export const WATCH_HINT_DONE = '回复「帮我审一下」看结果，要继续改直接说';

/** failed 事件的统一后续指引。 */
export const WATCH_HINT_FAILED = '回复「为什么失败」分析原因';

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
  /** 待审批标签列表（kind === 'approvals'，最多 5 条截断）。 */
  items?: string[];
  /** 待审批真实总数（kind === 'approvals'，截断前计数；卡片标题计数用它，不用 items.length）。 */
  total?: number;
  /** 纯文本版本，与卡片内容等价。 */
  text: string;
}

export interface KanbanWatcherOptions {
  kanbanUrl: string;
  /** Limit polling to one project; otherwise all projects are watched. */
  projectId?: string;
  intervalMs?: number;
  statePath: string;
  notify: (event: WatchEvent, eventId: string) => Promise<void>;
  /** 可选：推送目标 owner 列表。与 notifyOwner 同时提供时启用 (事件, owner) 粒度送达追踪。 */
  owners?: () => string[];
  /** 可选：单 owner 推送。缺省时回退 notify 整批推送（事件粒度追踪，占位 owner ''）。 */
  notifyOwner?: (event: WatchEvent, owner: string, eventId: string) => Promise<void>;
  /** 待重投条目的存活时间（默认 24h）：超时未送达丢弃并记日志，防 pending 无界增长。 */
  pendingTtlMs?: number;
  /** stop() 等待在途 tick 的兜底超时（默认 5s）：超时后照常返回，避免拖累整体退出。 */
  stopTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class KanbanWatcher {
  private readonly opts: KanbanWatcherOptions;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private state: WatchState | null;
  /** 最近一次落盘快照的序列化结果（tasks/approvals）：tick 里比较与写盘复用它，不再每轮重复 stringify。 */
  private lastSnapshotJson: { tasks: string; approvals: string } | null;

  constructor(opts: KanbanWatcherOptions) {
    this.opts = opts;
    this.state = this.load();
    this.lastSnapshotJson = this.state ? KanbanWatcher.serializeSnapshot(this.state) : null;
  }

  start(): void {
    const interval = Math.max(15000, this.opts.intervalMs ?? 60000);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  /**
   * 停止轮询并等待在途 tick 结束（带兜底超时）：否则 shutdown 后在途 tick
   * 仍可能向已关闭的 channel 推送。
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + (this.opts.stopTimeoutMs ?? 5000);
    while (this.polling && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.polling) this.opts.log?.('stop 等待在途轮询超时，继续关闭流程');
  }

  private load(): WatchState | null {
    try {
      if (!fs.existsSync(this.opts.statePath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8')) as Omit<WatchState, 'approvals' | 'pending'> & {
        approvals?: Array<string | WatchApproval>;
        pending?: Record<string, { event: WatchEvent; delivered?: unknown; enqueuedAt?: unknown }>;
      };
      if (!raw || typeof raw !== 'object' || !raw.tasks) return null;
      // 兼容旧格式（approvals 为 string[]）
      const approvals = Array.isArray(raw.approvals)
        ? raw.approvals
            .map((a) => (typeof a === 'string' ? { id: a, label: a } : a))
            .filter((a) => a && typeof a.id === 'string' && a.id)
        : [];
      // 兼容旧格式（无 pending 字段）；逐条宽松校验，坏条目丢弃（重推由旧快照 diff 兜底）
      let pending: WatchState['pending'];
      if (raw.pending && typeof raw.pending === 'object') {
        pending = {};
        for (const [id, p] of Object.entries(raw.pending)) {
          if (!p || typeof p !== 'object' || !p.event) continue;
          pending[id] = {
            event: p.event,
            delivered: Array.isArray(p.delivered) ? p.delivered.filter((o): o is string => typeof o === 'string') : [],
            // 旧格式无 enqueuedAt：从加载时刻起算一个完整 TTL，而非立即过期
            enqueuedAt: typeof p.enqueuedAt === 'number' && p.enqueuedAt > 0 ? p.enqueuedAt : Date.now(),
          };
        }
        if (!Object.keys(pending).length) pending = undefined;
      }
      return pending ? { tasks: raw.tasks, approvals, pending } : { tasks: raw.tasks, approvals };
    } catch {
      return null;
    }
  }

  /** 快照序列化（tasks/approvals 各一份，与 state 文件内的缩进口径一致）：每 tick 只算一次，比较与写盘复用。 */
  private static serializeSnapshot(state: WatchState): { tasks: string; approvals: string } {
    return { tasks: JSON.stringify(state.tasks, null, 2), approvals: JSON.stringify(state.approvals, null, 2) };
  }

  /** 落盘 state：由调用方已算好的快照序列化结果拼装（pending 增量序列化），不再整树重复 stringify。 */
  private persist(snapshotJson: { tasks: string; approvals: string }): void {
    try {
      // 与 JSON.stringify(state, null, 2) 等价的拼装：嵌套部分每行补两格缩进
      const indent = (json: string) => json.replace(/\n/g, '\n  ');
      const pending = this.state?.pending;
      const pendingPart = pending ? `,\n  "pending": ${indent(JSON.stringify(pending, null, 2))}` : '';
      writeFileAtomicPrivateSync(
        this.opts.statePath,
        `{\n  "tasks": ${indent(snapshotJson.tasks)},\n  "approvals": ${indent(snapshotJson.approvals)}${pendingPart}\n}\n`,
      );
      this.lastSnapshotJson = snapshotJson;
    } catch {
      /* best-effort */
    }
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const { state: current, approvalsUnknown } = await this.collect();
      const prev = this.state;
      if (prev) {
        // approvals 拉取失败 = 「未知」而非「空」：沿用上一轮快照，不把该字段推进为 []——
        // 否则恢复后 diff 会把全部 pending 审批当成「新的待审批」再推一遍
        if (approvalsUnknown) current.approvals = prev.approvals;
      }
      // 快照序列化每 tick 只算这一次：下方基线落盘、persistIfChanged 的比较与写盘都复用它
      const snapshotJson = KanbanWatcher.serializeSnapshot(current);
      if (!prev) {
        // 首轮 approvals 拉取失败（未知）时不落基线：[] 落盘后，下一轮端点恢复会把
        // 全部既有待审批 diff 成「新的待审批」推一遍，违背「首轮不刷通知」契约——
        // 延迟到下一轮 approvals 可达时再建基线
        if (approvalsUnknown) {
          this.opts.log?.('首轮 approvals 拉取失败，延迟到下一轮建立基线');
          return;
        }
        this.state = current;
        this.persist(snapshotJson);
        this.opts.log?.(`基线已建立（${Object.keys(current.tasks).length} 个任务）`);
        return;
      }
      const events = await this.diffEvents(current, prev);
      const { pending, pendingTouched, failed } = await this.deliverPending(events, prev.pending);
      const next: WatchState = { ...current };
      if (Object.keys(pending).length) next.pending = pending;
      this.state = next;
      this.persistIfChanged(prev, pendingTouched, snapshotJson);
      if (failed) {
        this.opts.log?.(`${failed} 个 (事件, owner) 组合推送失败，已记入待重投队列，下轮仅重试未送达组合`);
      }
    } catch (err) {
      this.opts.log?.(`轮询失败: ${errMessage(err)}`);
    } finally {
      this.polling = false;
    }
  }

  /** diff 两轮快照产出本轮新事件：新任务不打扰（创建流程本身已有反馈）。 */
  private async diffEvents(current: WatchState, prev: WatchState): Promise<Array<{ id: string; event: WatchEvent }>> {
    const events: Array<{ id: string; event: WatchEvent }> = [];
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
        // 纯文本版给用户看：状态键翻译成中文；transition 字段保留原始键（卡片渲染自行映射）
        const transitionText = enteredReview ? `${statusLabel(old.status)} → ${statusLabel(cur.status)}` : transition;
        const review = await this.reviewTarget(cur.projectId, id);
        events.push({
          id: `review:${id}:${transition}`,
          event: {
            kind: 'review',
            title: cur.title,
            transition,
            url: review.url,
            attemptId: review.attemptId,
            text: `🔍 看板任务待审阅：《${cur.title}》（${transitionText}）\n${review.url}\n点开链接人工审查 diff；没问题回复「标记完成」，要继续改直接说`,
          },
        });
        continue; // 待审阅已提示，同一 tick 不再重复其它状态通知
      }
      if (cur.status !== old.status && (cur.status === 'done' || cur.status === 'cancelled')) {
        const label = cur.status === 'done' ? '✅ 看板任务已完成' : '🚫 看板任务已取消';
        const hint = cur.status === 'done' ? `\n${WATCH_HINT_DONE}` : '';
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
          id: `${cur.status}:${id}`,
          event: {
            kind: cur.status === 'done' ? 'done' : 'cancelled',
            title: cur.title,
            transition: `${old.status} → ${cur.status}`,
            url: link,
            extra: extra || undefined,
            text: `${label}：《${cur.title}》（${statusLabel(old.status)} → ${statusLabel(cur.status)}）\n${link}${extra ? `\n结果摘要：${extra}` : ''}${hint}`,
          },
        });
      }
      // 失败判定用 failed 标志跳变（而非观测到 running 翻转）：两次轮询之间（或停机
      // 期间）启动并失败的任务 running 全程不可见，但 failed 会落进快照；已通知过的
      // 轮次 old.failed=true 不重推，重启后由首轮基线兜底不刷历史失败
      if (cur.failed && !old.failed && !cur.running) {
        events.push({
          id: `failed:${id}`,
          event: {
            kind: 'failed',
            title: cur.title,
            url,
            text: `❌ 看板任务执行失败：《${cur.title}》，请到看板查看日志\n${url}\n${WATCH_HINT_FAILED}`,
          },
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
        id: `approvals:${newApprovals.map((a) => a.id).join(',')}`,
        event: {
          kind: 'approvals',
          title: '',
          items: newApprovals.slice(0, 5).map((a) => a.label),
          total: newApprovals.length,
          text: `⏳ 看板有 ${newApprovals.length} 个新的待审批项：\n${lines}\n回复「待审批」处理`,
        },
      });
    }
    return events;
  }

  /** 合并本轮事件入重投队列，按 (事件, owner) 粒度投递未送达组合；返回仍需重投的队列、本轮是否碰过队列及失败计数。 */
  private async deliverPending(
    events: Array<{ id: string; event: WatchEvent }>,
    prevPending: WatchState['pending'],
  ): Promise<{ pending: Record<string, PendingWatchEvent>; pendingTouched: boolean; failed: number }> {
    // 事件粒度送达追踪：快照每轮都推进，未送达的 (事件, owner) 组合记入 pending 并随
    // state 文件持久化，下轮只重投未送达组合——一个 owner 长期不可达不再连累其他 owner
    // 被整批重推刷屏。进程重启后 pending 从 state 文件恢复继续重投；若写盘失败，盘上
    // 旧快照会在下次启动后重新 diff 出这些事件——重复优于丢失。
    const pending: Record<string, PendingWatchEvent> = { ...(prevPending ?? {}) };
    // TTL 兜底：owner 长期不可达时 pending 与 state 文件会单调增长——
    // 超期条目丢弃（该事件的推送就此放弃，快照已推进，不再重投）
    const pendingTtl = this.opts.pendingTtlMs ?? 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    for (const [pid, p] of Object.entries(pending)) {
      if (nowMs - p.enqueuedAt > pendingTtl) {
        delete pending[pid];
        this.opts.log?.(
          `待重投事件超期（${Math.round(pendingTtl / 3600000)}h）未送达，丢弃：${p.event.kind}《${p.event.title}》`,
        );
      }
    }
    for (const { id, event } of events) {
      // 同 id 已在重投队列（极少见：同一迁移在 pending 期间再次发生）：保留送达进度与首次入队时间，刷新载荷
      pending[id] = { event, delivered: pending[id]?.delivered ?? [], enqueuedAt: pending[id]?.enqueuedAt ?? nowMs };
    }
    const perOwner = Boolean(this.opts.notifyOwner && this.opts.owners);
    const ownerList = perOwner ? this.opts.owners!() : [''];
    // 无人认领期间（perOwner 且 owner 列表为空）跳过投递、保留全部 pending 下轮再投——
    // [].every(...) 恒 true 会把事件误判「全员已送达」并永久丢弃（对照 daily-brief 的
    // `if (!owners.length) return;` 语义）；超期条目仍由上方 TTL 兜底丢弃，不无界增长
    if (perOwner && ownerList.length === 0) {
      if (Object.keys(pending).length) {
        this.opts.log?.(`暂无认领 owner，${Object.keys(pending).length} 条事件保留待重投队列，下轮再投递`);
      }
      return { pending, pendingTouched: Object.keys(pending).length > 0, failed: 0 };
    }
    let failed = 0;
    for (const [pid, p] of Object.entries(pending)) {
      for (const owner of ownerList) {
        if (p.delivered.includes(owner)) continue;
        try {
          if (perOwner) await this.opts.notifyOwner!(p.event, owner, pid);
          else await this.opts.notify(p.event, pid);
          p.delivered.push(owner);
        } catch (err) {
          failed++;
          this.opts.log?.(
            `事件推送失败（${p.event.kind}《${p.event.title}》${owner ? ` → ${owner}` : ''}）: ${errMessage(err)}`,
          );
        }
      }
    }
    const pendingOut: Record<string, PendingWatchEvent> = {};
    for (const [id, p] of Object.entries(pending)) {
      if (!ownerList.every((o) => p.delivered.includes(o))) pendingOut[id] = p;
    }
    return {
      pending: pendingOut,
      pendingTouched: Object.keys(pending).length > 0,
      failed,
    };
  }

  /** 仅在快照有变化或本轮碰过待重投队列（含刚清零需落盘出队的）时写盘，无变化的空转 tick 不重复写 state 文件。 */
  private persistIfChanged(
    prev: WatchState,
    pendingTouched: boolean,
    snapshotJson: { tasks: string; approvals: string },
  ): void {
    const last = this.lastSnapshotJson;
    const snapshotChanged =
      !last || snapshotJson.tasks !== last.tasks || snapshotJson.approvals !== last.approvals;
    const touched = pendingTouched || Boolean(prev.pending && Object.keys(prev.pending).length);
    if (snapshotChanged || touched) this.persist(snapshotJson);
  }

  /** 拉取一轮快照；approvals 端点失败时 approvalsUnknown=true（调用方沿用旧快照，见 tick）。 */
  private async collect(): Promise<{ state: WatchState; approvalsUnknown: boolean }> {
    const projectIds = this.opts.projectId ? [this.opts.projectId] : await this.fetchProjectIds();
    const tasks: Record<string, WatchTaskState> = {};
    for (const pid of projectIds) {
      const raw = await this.api(`/tasks?project_id=${pid}`); // 网络错误照常上抛（tick 统一记轮询失败）
      let list: KanbanTaskRow[];
      try {
        list = validateKanbanTaskRows(`/tasks?project_id=${pid}`, raw);
      } catch (err) {
        // 返回形状不符按原 Array.isArray 兜底语义跳过该项目，但记日志留信号
        this.opts.log?.(errMessage(err));
        continue;
      }
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
    let approvalsUnknown = false;
    try {
      const raw = await this.api('/approvals');
      if (Array.isArray(raw)) {
        approvals = raw
          .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object' && !Array.isArray(a)))
          // 只看审批条目的状态字段：整行 JSON 匹配会把标题等任意字段里含 pending 的误算成待审批
          .filter((a) => /pending/i.test(String(a.status ?? a.state ?? '')))
          .map((a) => {
            const id = String(a.id || '');
            const label = String(a.title || a.task_title || a.name || a.summary || id);
            return { id, label };
          })
          .filter((a) => a.id);
      }
    } catch (err) {
      // approvals 端点可选，失败不阻断任务监控；但要记日志并标记「未知」，
      // 由 tick 沿用上一轮快照（按 [] 继续会把恢复后的全部 pending 误判为新审批）
      approvalsUnknown = true;
      this.opts.log?.(`approvals 拉取失败，本轮沿用上一轮审批快照: ${errMessage(err)}`);
    }
    return { state: { tasks, approvals }, approvalsUnknown };
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
    const raw = await this.api('/projects'); // 网络错误照常上抛
    let list: KanbanProjectRow[];
    try {
      list = validateKanbanProjectRows('/projects', raw);
    } catch (err) {
      // 形状不符按原 Array.isArray 兜底：视为无项目（记日志留信号）
      this.opts.log?.(errMessage(err));
      return [];
    }
    return list.map((p) => p.id || '').filter(Boolean);
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
