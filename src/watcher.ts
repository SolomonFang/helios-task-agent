import fs from 'fs';
import path from 'path';

/**
 * Kanban watcher: polls the kanban REST API and pushes proactive Feishu
 * notifications when tasks finish / fail or new approvals appear.
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

export interface KanbanWatcherOptions {
  kanbanUrl: string;
  /** Limit polling to one project; otherwise all projects are watched. */
  projectId?: string;
  intervalMs?: number;
  statePath: string;
  notify: (text: string) => Promise<void>;
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
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
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
      this.state = current;
      this.persist();
      if (!prev) {
        this.opts.log?.(`基线已建立（${Object.keys(current.tasks).length} 个任务）`);
        return;
      }
      const events: string[] = [];
      for (const [id, cur] of Object.entries(current.tasks)) {
        const old = prev.tasks[id];
        if (!old) continue; // 新任务不打扰（创建流程本身已有反馈）
        const url = this.taskUrl(cur.projectId, id);
        if (cur.status !== old.status && (cur.status === 'done' || cur.status === 'cancelled')) {
          const label = cur.status === 'done' ? '✅ 看板任务已完成' : '🚫 看板任务已取消';
          const hint = cur.status === 'done' ? '\n回复「帮我 review」看结果，或「再跟它说一句…」继续迭代' : '';
          let extra = '';
          if (cur.status === 'done') {
            try {
              extra = KanbanWatcher.pickDetail(await this.api(`/tasks/${id}`));
            } catch {
              /* 详情拉取失败不阻断通知 */
            }
          }
          events.push(
            `${label}：《${cur.title}》（${old.status} → ${cur.status}）\n${url}${extra ? `\n${extra}` : ''}${hint}`,
          );
        }
        if (old.running && !cur.running && cur.failed) {
          events.push(
            `❌ 看板任务执行失败：《${cur.title}》，请到看板查看日志\n${url}\n回复「为什么失败」让它分析原因`,
          );
        }
      }
      const newApprovals = current.approvals.filter((a) => !prev.approvals.some((p) => p.id === a.id));
      if (newApprovals.length) {
        const lines = newApprovals
          .slice(0, 5)
          .map((a) => `· ${a.label}`)
          .join('\n');
        events.push(`⏳ 看板有 ${newApprovals.length} 个新的待审批项：\n${lines}\n回复「待审批」处理`);
      }
      for (const e of events) await this.opts.notify(e);
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
      return `结果摘要：${t.slice(0, 200)}${t.length > 200 ? '…' : ''}`;
    }
    return '';
  }

  private async fetchProjectIds(): Promise<string[]> {
    const list = (await this.api('/projects')) as Array<{ id?: string }>;
    return Array.isArray(list) ? list.map((p) => p.id || '').filter(Boolean) : [];
  }

  private taskUrl(projectId: string, taskId: string): string {
    const base = this.opts.kanbanUrl.replace(/\/+$/, '');
    return `${base}/local-projects/${projectId}/tasks/${taskId}`;
  }

  private async api(p: string): Promise<unknown> {
    const base = this.opts.kanbanUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/api${p}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { success?: boolean; data?: unknown; message?: string };
    if (json && json.success === true) return json.data;
    throw new Error(json?.message || 'kanban api error');
  }
}
