import type { ToolHandler } from '../../types';
import type { MemoryStore } from '../memory';
import { normalizeFactKey } from '../memory';
import { passGate, type ConfirmFn } from '../guard';
import { auditLog } from '../../infra/audit';
import { errMessage } from '../../infra/err';
import { summarizeBothEnds } from './shared';

/** memory_* handler 组：写/删/备注回注系统提示词（持久化注入通道），一律过确认闸门。 */
export function makeMemoryHandlers({
  uid,
  memory,
  confirm,
  auditHome,
  onMemoryChange,
}: {
  uid: string;
  memory: MemoryStore;
  confirm?: ConfirmFn;
  auditHome?: string;
  onMemoryChange?: () => void;
}): Array<[string, ToolHandler]> {
  const memorySet: ToolHandler = async (raw) => {
    const key = typeof raw.key === 'string' ? raw.key : '';
    if (!key.trim()) return '参数错误：key 不能为空';
    // 与空 key 同口径：缺失/非字符串/空 value 直接报参数错误，不静默写空串
    if (typeof raw.value !== 'string' || !raw.value) return '参数错误：value 不能为空';
    const value = raw.value;
    // 记忆会原样回注系统提示词（持久化注入通道）：写操作一律过确认闸门，展示 key 与 value
    const summary = `写入记忆「${key.trim()}」：${value.slice(0, 100)}`;
    const detail = summarizeBothEnds(`memory_set(key=${key.trim()}, value=${value})`);
    const gate = await passGate(
      { kind: 'memory', summary, detail, batchKey: 'memory:set', batchScope: 'kind', destructive: true },
      confirm,
    );
    if (!gate.allowed) {
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: gate.reason }, auditHome);
      return gate.message;
    }
    try {
      const user = memory.setFact(uid, key, value);
      onMemoryChange?.();
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: 'approved' }, auditHome);
      // echo 实际存储值（经 clampEntry + 标记中和，可能与入参不同），key 用归一化后的存储键
      const storedKey = normalizeFactKey(key);
      return JSON.stringify({ ok: true, key: storedKey, value: user.facts[storedKey], facts: user.facts });
    } catch (err) {
      // setFact 在 persist 失败时抛异常：失败落审计并如实回报，不谎报 ok:true
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: 'approved', ok: false }, auditHome);
      return `memory_set 失败：${errMessage(err)}`;
    }
  };

  const memoryGet: ToolHandler = async (raw) => {
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (key) {
      const value = memory.getFact(uid, key);
      return value === undefined
        ? JSON.stringify({ key, value: null, found: false })
        : JSON.stringify({ key, value, found: true });
    }
    const user = memory.getUser(uid);
    return JSON.stringify({ facts: user.facts, notes: user.notes, updatedAt: user.updatedAt });
  };

  const memoryDelete: ToolHandler = async (raw) => {
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!key) return '参数错误：key 不能为空';
    // 删除同样可被注入利用（先删合法来源再写伪造值），与写入一样过确认闸门
    const summary = `删除记忆「${key}」`;
    const detail = `memory_delete(key=${key})`;
    const gate = await passGate(
      { kind: 'memory', summary, detail, batchKey: 'memory:delete', batchScope: 'kind', destructive: true },
      confirm,
    );
    if (!gate.allowed) {
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: gate.reason }, auditHome);
      return gate.message;
    }
    try {
      const ok = memory.deleteFact(uid, key);
      if (ok) onMemoryChange?.();
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: 'approved', ok }, auditHome);
      return JSON.stringify({ ok, key });
    } catch (err) {
      // deleteFact 在 persist 失败时抛异常：失败落审计并如实回报，不谎报 ok:true
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: 'approved', ok: false }, auditHome);
      return `memory_delete 失败：${errMessage(err)}`;
    }
  };

  const memoryNote: ToolHandler = async (raw) => {
    const text = typeof raw.text === 'string' ? raw.text : '';
    // 备注同样回注系统提示词，与 memory_set 同级风险，过确认闸门
    const summary = `追加记忆备注：${text.slice(0, 100)}`;
    const detail = summarizeBothEnds(`memory_note(text=${text})`);
    const gate = await passGate(
      { kind: 'memory', summary, detail, batchKey: 'memory:note', batchScope: 'kind', destructive: true },
      confirm,
    );
    if (!gate.allowed) {
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: gate.reason }, auditHome);
      return gate.message;
    }
    try {
      const user = memory.addNote(uid, text);
      onMemoryChange?.();
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: 'approved' }, auditHome);
      return JSON.stringify({ ok: true, notes: user.notes });
    } catch (err) {
      // addNote 在 persist 失败时抛异常：失败落审计并如实回报，不谎报 ok:true
      auditLog({ user: uid, kind: 'memory', summary, detail, decision: 'approved', ok: false }, auditHome);
      return `memory_note 失败：${errMessage(err)}`;
    }
  };

  return [
    ['memory_set', memorySet],
    ['memory_get', memoryGet],
    ['memory_delete', memoryDelete],
    ['memory_note', memoryNote],
  ];
}
