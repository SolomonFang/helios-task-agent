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
    appendFilePrivateSync(file, JSON.stringify(record) + '\n');
  } catch {
    /* ignore */
  }
}
