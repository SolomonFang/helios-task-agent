import fs from 'fs';
import path from 'path';
import { defaultDataHome } from '../infra/paths';
import { writeFileAtomicPrivateSync } from '../infra/private-file';

/**
 * Dedupe registry: remembers which Feishu/Lark source URLs already became
 * kanban tasks, so「同步我的任务」run twice does not create duplicates.
 * Persisted to <home>/synced-sources.json, keyed per user.
 */

export interface SyncedSource {
  taskId: string;
  title: string;
  createdAt: string;
}

type RegistryData = Record<string, Record<string, SyncedSource>>;

/** 运行时校验单条映射：三个字段都必须为 string（盘上文件可能被手改/写坏）。 */
function isSyncedSource(v: unknown): v is SyncedSource {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.taskId === 'string' && typeof o.title === 'string' && typeof o.createdAt === 'string';
}

const SOURCE_URL_RE = /https?:\/\/[A-Za-z0-9.-]*(?:feishu\.cn|larksuite\.com|feishu\.net|feishu\.io)[^\s"'<>)\]，。；]*/g;

/** Extract Feishu/Lark source URLs from arbitrary text (title + description + args). */
export function extractSourceUrls(text: string): string[] {
  const matches = text.match(SOURCE_URL_RE) || [];
  return [...new Set(matches.map((u) => u.replace(/[/.]+$/, '')))];
}

/** Existence check before honoring a recorded mapping (self-heals after manual deletes). */
export async function kanbanTaskExists(kanbanUrl: string, taskId: string): Promise<boolean> {
  try {
    const base = kanbanUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/tasks/${taskId}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return false;
    if (!res.ok) return true; // unknown → conservative: keep blocking
    const json: unknown = await res.json();
    return Boolean(json && typeof json === 'object' && (json as { success?: unknown }).success === true);
  } catch {
    return true; // kanban unreachable → conservative: keep blocking
  }
}

export class SourceRegistry {
  readonly filePath: string;
  private data: RegistryData;
  /** 盘上文件的解析缓存：mtime 未变时 mergeFromDisk 复用，跳过全量 readFileSync + JSON.parse。 */
  private diskCache: { mtimeMs: number | null; data: RegistryData };

  constructor(homeDir?: string) {
    const root = homeDir || defaultDataHome();
    this.filePath = path.join(root, 'synced-sources.json');
    this.data = this.load();
    this.diskCache = { mtimeMs: this.statMtimeMs(), data: this.data };
  }

  /** 文件 mtime（毫秒）；文件不存在/读取失败返回 null（缓存同为 null 即视为未变）。 */
  private statMtimeMs(): number | null {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  private load(): RegistryData {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const raw: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      // 逐条校验：坏条目丢弃而不是整张表作废，也不让脏数据污染内存
      const out: RegistryData = {};
      for (const [uid, entries] of Object.entries(raw as Record<string, unknown>)) {
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        const clean: Record<string, SyncedSource> = {};
        for (const [url, e] of Object.entries(entries as Record<string, unknown>)) {
          if (isSyncedSource(e)) clean[url] = e;
        }
        if (Object.keys(clean).length) out[uid] = clean;
      }
      return out;
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      writeFileAtomicPrivateSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
      // 刚写的内容与内存一致：同步缓存，避免下一次 mergeFromDisk 立刻重读自己写的文件
      this.diskCache = { mtimeMs: this.statMtimeMs(), data: this.data };
    } catch {
      /* best-effort */
    }
  }

  /**
   * Reload disk and fold in keys written by other instances (CLI vs bot vs
   * sibling sessions share the file); our in-memory view wins on conflicts.
   * 按 mtime 缓存解析结果：文件未变时跳过重读与 JSON.parse，合并语义不变。
   */
  private mergeFromDisk(): void {
    const mtimeMs = this.statMtimeMs();
    if (!this.diskCache || this.diskCache.mtimeMs !== mtimeMs) {
      this.diskCache = { mtimeMs, data: this.load() };
    }
    for (const [uid, entries] of Object.entries(this.diskCache.data)) {
      this.data[uid] = { ...entries, ...(this.data[uid] || {}) };
    }
  }

  lookup(userId: string, url: string): SyncedSource | undefined {
    // 与 record/remove 一致先合并盘上数据：长驻进程的内存快照看不到 CLI 等其他
    // 实例新写入的映射，不合并会让重复建任务拦截失效
    this.mergeFromDisk();
    return this.data[userId]?.[url];
  }

  record(userId: string, url: string, entry: SyncedSource): void {
    this.mergeFromDisk();
    if (!this.data[userId]) this.data[userId] = {};
    this.data[userId]![url] = entry;
    this.persist();
  }

  remove(userId: string, url: string): void {
    // Merge first so persist does not stomp other instances' keys; deleting
    // after the merge guarantees the removed key cannot be resurrected by it.
    this.mergeFromDisk();
    if (this.data[userId] && url in this.data[userId]!) {
      delete this.data[userId]![url];
      this.persist();
    }
  }
}
