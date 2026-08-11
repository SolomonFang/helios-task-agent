/**
 * Kanban task status metadata: the single source of truth for status keys and
 * their user-facing Chinese labels. Display extras (emoji / badge) live in the
 * renderers (e.g. report.ts) on top of this.
 */

/** 任务状态键（固定顺序：summary 计数与 report 分组排序共用）。 */
export const TASK_STATUS_KEYS = ['done', 'inreview', 'inprogress', 'todo', 'cancelled'] as const;

/** 状态键 → 用户可见中文；未知状态回退原文。 */
const STATUS_LABELS: Record<string, string> = {
  done: '已完成',
  inreview: '待审阅',
  inprogress: '进行中',
  todo: '待办',
  cancelled: '已取消',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
