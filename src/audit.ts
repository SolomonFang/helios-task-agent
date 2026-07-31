import fs from 'fs';
import path from 'path';
import { defaultDataHome } from './memory';
import { appendFilePrivateSync } from './private-file';

export type AuditDecision = 'approved' | 'denied' | 'blocked_dup' | 'no_gate' | 'error';

export interface AuditEntry {
  user: string;
  kind: string;
  summary: string;
  detail: string;
  decision: AuditDecision;
  ok?: boolean;
  resultSnippet?: string;
}

/** audit.log 超过 5MB 轮转为 audit.log.1（只保留 1 代，实现从简）。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Append one JSONL record to <home>/audit.log（超 5MB 先轮转）。Never throws — audit must not break the gate. */
export function auditLog(entry: AuditEntry, homeDir?: string): void {
  try {
    const file = path.join(homeDir || defaultDataHome(), 'audit.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 文件不存在或轮转失败都不阻断写入 */
    }
    const record = {
      ts: new Date().toISOString(),
      ...entry,
      detail: entry.detail.slice(0, 1000),
      resultSnippet: entry.resultSnippet?.slice(0, 500),
    };
    appendFilePrivateSync(file, JSON.stringify(record) + '\n');
  } catch {
    /* ignore */
  }
}
