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

interface WatchState {
  tasks: Record<string, WatchTaskState>;
  approvals: string[];
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
      const raw = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8')) as WatchState;
      return raw && typeof raw === 'object' && raw.tasks ? raw : null;
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
          events.push(`${label}：《${cur.title}》（${old.status} → ${cur.status}）\n${url}`);
        }
        if (old.running && !cur.running && cur.failed) {
          events.push(`❌ 看板任务执行失败：《${cur.title}》，请到看板查看日志\n${url}`);
        }
      }
      const newApprovals = current.approvals.filter((a) => !prev.approvals.includes(a));
      if (newApprovals.length) {
        events.push(`⏳ 看板有 ${newApprovals.length} 个新的待审批项，回复「待审批」处理`);
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
    let approvals: string[] = [];
    try {
      const list = (await this.api('/approvals')) as Array<{ id?: string }>;
      if (Array.isArray(list)) {
        approvals = list
          .filter((a) => /pending/i.test(JSON.stringify(a)))
          .map((a) => String(a.id || ''))
          .filter(Boolean);
      }
    } catch {
      /* approvals 端点可选，失败不阻断任务监控 */
    }
    return { tasks, approvals };
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
