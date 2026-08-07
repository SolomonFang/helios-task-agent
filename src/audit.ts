import fs from 'fs';
import path from 'path';
import { defaultDataHome } from './paths';
import { appendFilePrivateSync } from './private-file';

export type AuditDecision = 'approved' | 'denied' | 'blocked_dup' | 'no_gate' | 'error';

/**
 * kind 取值约定：kanban / hk / lark / memory / skill 为写闸门决策记录；
 * lark_read / repo_fs_read 为读路径外发审计（数据发给 LLM 的动作留痕）——只记 summary/目标，
 * 绝不写 resultSnippet（读回内容），避免审计文件变成敏感数据副本；
 * 被敏感文件 denylist / 仓库白名单拒绝的读尝试记 decision: 'denied'。
 * kind 为自由字符串，新增取值向后兼容：旧审计文件无需迁移即可继续读取。
 */
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

/**
 * 写操作 resultSnippet / detail 落盘前的轻量脱敏：工具输出若含 token/密钥字段，
 * 不应原样留在审计日志。启发式覆盖三类常见形态——
 * 1. JSON 键值对：键名含 token/secret/key/password/authorization 的值替换为 ***；
 * 2. Bearer 认证头：Bearer xxx → Bearer ***；
 * 3. CLI 标志参数：--token xxx / --app-secret=xxx → --token ***（detail 含完整命令行，如 auth login --token xxx）。
 * 不保证完备（只是缓解），读路径本就不记读回内容（见上面的 kind 约定）。
 */
export function redactSnippet(text: string): string {
  return text
    .replace(
      /("(?:[^"\\]|\\.)*(?:token|secret|key|password|authorization)(?:[^"\\]|\\.)*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"***"',
    )
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***')
    .replace(/(--?[\w-]*(?:token|secret|key|password)[\w-]*)([ =])[^\s]+/gi, '$1$2***');
}

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
      // detail 含完整命令行 / memory value（如 auth login --token xxx）：与 resultSnippet 一样先脱敏再落盘
      detail: redactSnippet(entry.detail).slice(0, 1000),
      resultSnippet:
        entry.resultSnippet === undefined ? undefined : redactSnippet(entry.resultSnippet).slice(0, 500),
    };
    appendFilePrivateSync(file, JSON.stringify(record) + '\n');
  } catch {
    /* ignore */
  }
}
