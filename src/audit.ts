import fs from 'fs';
import path from 'path';
import { defaultDataHome } from './memory';

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

/** Append one JSONL record to <home>/audit.log. Never throws — audit must not break the gate. */
export function auditLog(entry: AuditEntry, homeDir?: string): void {
  try {
    const file = path.join(homeDir || defaultDataHome(), 'audit.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      ...entry,
      detail: entry.detail.slice(0, 1000),
      resultSnippet: entry.resultSnippet?.slice(0, 500),
    };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}
