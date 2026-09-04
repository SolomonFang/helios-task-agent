import type { ToolHandler } from '../../types';
import {
  formatLocal,
  parseTriggerAt,
  remainingText,
  type ReminderStore,
} from '../reminder';
import { passGate, type ConfirmFn } from '../guard';
import { auditLog, type AuditDecision } from '../../infra/audit';
import { errMessage } from '../../infra/err';
import { summarizeBothEnds } from './shared';

/**
 * reminder_* handler 组：自然语言定时提醒（到点经 runner 主动推送）。
 * 创建/取消是用户自有数据的写操作，与 memory_* 同口径一律过确认闸门（项目约定：所有写都过闸）；
 * 查询为只读，不过闸。
 */
export function makeReminderHandlers({
  uid,
  reminders,
  confirm,
  auditHome,
}: {
  uid: string;
  reminders: ReminderStore;
  confirm?: ConfirmFn;
  auditHome?: string;
}): Array<[string, ToolHandler]> {
  const reminderSet: ToolHandler = async (raw) => {
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) return '参数错误：text 不能为空';
    const at = typeof raw.at === 'string' ? raw.at : undefined;
    const inMinutes = typeof raw.in_minutes === 'number' ? raw.in_minutes : undefined;
    let triggerAt: number;
    try {
      triggerAt = parseTriggerAt({ at, inMinutes }, new Date());
    } catch (err) {
      return errMessage(err);
    }
    const timeText = formatLocal(triggerAt);
    // 创建提醒是写操作（写入持久化文件，到点会主动推送打扰用户）：与 memory_set 同口径过确认闸门
    const summary = `创建提醒「${text.slice(0, 50)}」（${timeText}）`;
    const detail = summarizeBothEnds(`内容：${text}\n触发时间：${timeText}（本地时间）`);
    const gate = await passGate(
      { kind: 'reminder', summary, detail, batchKey: 'reminder:set', batchScope: 'kind' },
      confirm,
    );
    if (!gate.allowed) {
      auditLog({ user: uid, kind: 'reminder', summary, detail, decision: gate.reason as AuditDecision }, auditHome);
      return gate.message;
    }
    try {
      const reminder = reminders.add(uid, text, triggerAt);
      auditLog({ user: uid, kind: 'reminder', summary, detail, decision: 'approved' }, auditHome);
      return JSON.stringify({
        ok: true,
        id: reminder.id,
        text: reminder.text,
        triggerAt: timeText,
        remaining: remainingText(reminder.triggerAt, Date.now()),
        hint: '到点会主动推送提醒。请向用户复述确认的时刻与内容。',
      });
    } catch (err) {
      // add 在上限/写盘失败时抛异常：失败落审计并如实回报，不谎报 ok:true
      auditLog({ user: uid, kind: 'reminder', summary, detail, decision: 'approved', ok: false }, auditHome);
      return `创建提醒失败：${errMessage(err)}`;
    }
  };

  const reminderList: ToolHandler = async () => {
    const pending = reminders.list(uid);
    if (!pending.length) return '当前没有待触发的提醒。';
    const nowMs = Date.now();
    return JSON.stringify({
      count: pending.length,
      reminders: pending.map((r, i) => ({
        序号: i + 1,
        id: r.id,
        text: r.text,
        triggerAt: formatLocal(r.triggerAt),
        remaining: remainingText(r.triggerAt, nowMs),
      })),
    });
  };

  const reminderCancel: ToolHandler = async (raw) => {
    const ref = typeof raw.ref === 'string' ? raw.ref.trim() : typeof raw.ref === 'number' ? String(raw.ref) : '';
    if (!ref) return '参数错误：ref 不能为空（传 reminder_list 返回的序号或 id）';
    const target = reminders.find(uid, ref);
    if (!target) return `未找到待触发的提醒「${ref}」（可先用 reminder_list 查看序号）`;
    // 取消是删除性写操作：过确认闸门；免问按对象绑定（防借一次授权取消任意提醒）
    const summary = `取消提醒「${target.text.slice(0, 50)}」（${formatLocal(target.triggerAt)}）`;
    const detail = `内容：${target.text}\n触发时间：${formatLocal(target.triggerAt)}（本地时间）`;
    const gate = await passGate(
      { kind: 'reminder', summary, detail, batchKey: `reminder:cancel:${target.id}`, batchScope: 'object', destructive: true },
      confirm,
    );
    if (!gate.allowed) {
      auditLog({ user: uid, kind: 'reminder', summary, detail, decision: gate.reason as AuditDecision }, auditHome);
      return gate.message;
    }
    try {
      const cancelled = reminders.cancel(uid, ref);
      auditLog({ user: uid, kind: 'reminder', summary, detail, decision: 'approved', ok: Boolean(cancelled) }, auditHome);
      if (!cancelled) return `未找到待触发的提醒「${ref}」（可能刚已触发或已被取消）`;
      return JSON.stringify({ ok: true, id: cancelled.id, text: cancelled.text });
    } catch (err) {
      // cancel 在写盘失败时抛异常：失败落审计并如实回报，不谎报 ok:true
      auditLog({ user: uid, kind: 'reminder', summary, detail, decision: 'approved', ok: false }, auditHome);
      return `取消提醒失败：${errMessage(err)}`;
    }
  };

  return [
    ['reminder_set', reminderSet],
    ['reminder_list', reminderList],
    ['reminder_cancel', reminderCancel],
  ];
}
