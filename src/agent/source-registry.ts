import fs from 'fs';
import path from 'path';
import { defaultDataHome } from '../infra/paths';
import { writeFileAtomicPrivateSync } from '../infra/private-file';
import { errMessage } from '../infra/err';

/**
 * Dedupe registry: remembers which Feishu/Lark source URLs already became
 * kanban tasks, so「同步我的任务」run twice does not create duplicates.
 * Persisted to <home>/synced-sources.json, keyed per user.
 *
 * 查重粒度为 (来源 URL, 项目)：同一来源文档涉及多个项目（如中控/APP/后端）时，
 * 每个项目各建一个任务不互斥；只有同 URL + 同项目才判定重复。项目维度的键为
 * projectId，缺省（无项目参数的旧数据/旧调用）统一挂在 '' 键下。
 */

export interface SyncedSource {
  taskId: string;
  title: string;
  createdAt: string;
}

/** data[uid][url][projectKey] = SyncedSource；projectKey 为 projectId，无项目信息时为 ''。 */
type RegistryData = Record<string, Record<string, Record<string, SyncedSource>>>;

/** 运行时校验单条映射：三个字段都必须为 string（盘上文件可能被手改/写坏）。 */
function isSyncedSource(v: unknown): v is SyncedSource {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.taskId === 'string' && typeof o.title === 'string' && typeof o.createdAt === 'string';
}

const SOURCE_URL_RE = /https?:\/\/[A-Za-z0-9.-]*(?:feishu\.cn|larksuite\.com|feishu\.net|feishu\.io)[^\s"'<>)\]，。；]*/g;

/** 单用户来源映射条数上限：超出时按 createdAt 淘汰最旧，防止盘上文件与内存 Map 无界增长。 */
const MAX_SOURCES_PER_USER = 1000;

/** Extract Feishu/Lark source URLs from arbitrary text (title + description + args). */
export function extractSourceUrls(text: string): string[] {
  const matches = text.match(SOURCE_URL_RE) || [];
  return [...new Set(matches.map((u) => u.replace(/[/.]+$/, '')))];
}

/**
 * 组合调用方 signal 与 8s 超时兜底：任一触发即中断（与 kanban/http.ts 同思路；
 * AbortSignal.any 需 Node 20.3+，engines 只要求 >=20，故手写等价组合——ctl 触发时
 * 摘掉调用方 signal 上的监听器，不随高频调用滞留）。
 */
function combinedFetchSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (signal.aborted) return signal;
  const ctl = new AbortController();
  const onCallerAbort = (): void => ctl.abort();
  signal.addEventListener('abort', onCallerAbort, { once: true });
  timeout.addEventListener('abort', () => ctl.abort(), { once: true });
  ctl.signal.addEventListener('abort', () => signal.removeEventListener('abort', onCallerAbort), { once: true });
  return ctl.signal;
}

/** Existence check before honoring a recorded mapping (self-heals after manual deletes). */
export async function kanbanTaskExists(kanbanUrl: string, taskId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const base = kanbanUrl.replace(/\/+$/, '');
    // taskId 来自盘上文件（可能被手改），编码后才拼进 URL，防止注入路径段
    const res = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`, {
      signal: combinedFetchSignal(signal, 8000),
    });
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
  /**
   * 盘上文件的解析缓存：内容指纹（mtimeNs:size）未变时 mergeFromDisk 复用，
   * 跳过全量 readFileSync + JSON.parse。不能只用 mtime：文件系统时间戳粒度有限
   * （CI 上快速连写可落同一刻度），叠加 size 才能识别同刻度内的内容变化。
   */
  private diskCache: { fingerprint: string | null; data: RegistryData };

  constructor(homeDir?: string) {
    const root = homeDir || defaultDataHome();
    this.filePath = path.join(root, 'synced-sources.json');
    this.data = this.load();
    this.diskCache = { fingerprint: this.statFingerprint(), data: this.data };
  }

  /** 内容指纹（mtimeNs:size）；文件不存在/读取失败返回 null（缓存同为 null 即视为未变）。 */
  private statFingerprint(): string | null {
    try {
      const s = fs.statSync(this.filePath, { bigint: true });
      return `${s.mtimeNs}:${s.size}`;
    } catch {
      return null;
    }
  }

  /**
   * 解析单 URL 下的记录集。兼容两种盘上格式：
   * - 旧格式：url → SyncedSource（无项目维度），迁移为 { '': entry }；
   * - 新格式：url → { projectKey: SyncedSource }。
   */
  private static parseUrlBucket(v: unknown): Record<string, SyncedSource> | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (isSyncedSource(v)) return { '': v };
    const out: Record<string, SyncedSource> = {};
    for (const [projectKey, e] of Object.entries(v as Record<string, unknown>)) {
      if (isSyncedSource(e)) out[projectKey] = e;
    }
    return Object.keys(out).length ? out : null;
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
        const clean: Record<string, Record<string, SyncedSource>> = {};
        for (const [url, v] of Object.entries(entries as Record<string, unknown>)) {
          const bucket = SourceRegistry.parseUrlBucket(v);
          if (bucket) clean[url] = bucket;
        }
        if (Object.keys(clean).length) out[uid] = clean;
      }
      return out;
    } catch {
      return {};
    }
  }

  private persist(): void {
    // 条数上限：淘汰每用户 createdAt 最旧的记录（按 (url, projectKey) 单条计）。
    // 与 remove 一样，淘汰结果可能被持有旧内存快照的其他实例在下一次 persist 时
    // 复活（取舍见 mergeFromDisk 注释）。
    for (const entries of Object.values(this.data)) {
      const flat: { url: string; projectKey: string; createdAt: string }[] = [];
      for (const [url, bucket] of Object.entries(entries)) {
        for (const [projectKey, e] of Object.entries(bucket)) flat.push({ url, projectKey, createdAt: e.createdAt });
      }
      if (flat.length <= MAX_SOURCES_PER_USER) continue;
      flat.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const item of flat.slice(0, flat.length - MAX_SOURCES_PER_USER)) {
        delete entries[item.url]![item.projectKey];
        if (!Object.keys(entries[item.url]!).length) delete entries[item.url];
      }
    }
    try {
      writeFileAtomicPrivateSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
      // 刚写的内容与内存一致：同步缓存，避免下一次 mergeFromDisk 立刻重读自己写的文件
      this.diskCache = { fingerprint: this.statFingerprint(), data: this.data };
    } catch (err) {
      // best-effort，但必须可观测：静默失败会让跨进程去重无声失效
      console.warn(`[source-registry] 查重映射落盘失败（跨进程去重可能失效）：${errMessage(err)}`);
    }
  }

  /**
   * Reload disk and fold in keys written by other instances (CLI vs bot vs
   * sibling sessions share the file); our in-memory view wins on conflicts.
   * 按内容指纹缓存解析结果：文件未变时跳过重读与 JSON.parse，合并语义不变。
   * 取舍：本实例 remove/上限淘汰掉的 key，可能被仍持有旧内存快照的其他实例在
   * 下一次 persist 时复活——跨实例去重本就是 best-effort，接受这一点换取无锁实现。
   */
  private mergeFromDisk(): void {
    const fingerprint = this.statFingerprint();
    if (this.diskCache.fingerprint !== fingerprint) {
      this.diskCache = { fingerprint, data: this.load() };
    }
    for (const [uid, entries] of Object.entries(this.diskCache.data)) {
      const mine = this.data[uid] || {};
      const merged: Record<string, Record<string, SyncedSource>> = { ...entries };
      for (const [url, bucket] of Object.entries(mine)) {
        // 两级合并：同 URL 下按 projectKey 逐条合并，内存视图优先
        merged[url] = { ...(entries[url] || {}), ...bucket };
      }
      this.data[uid] = merged;
    }
  }

  /**
   * 查重：命中返回记录与命中的 projectKey。
   * - 传 projectId：仅同 URL + 同项目判定重复（同来源跨项目各建一个任务不互斥）；
   * - 不传 projectId：优先 '' 键（同为无项目创建），否则任一记录兜底拦截——
   *   无项目参数时无法判定落到哪个项目，保守视为重复。
   */
  find(userId: string, url: string, projectId?: string): { projectKey: string; entry: SyncedSource } | undefined {
    // 与 record/remove 一致先合并盘上数据：长驻进程的内存快照看不到 CLI 等其他
    // 实例新写入的映射，不合并会让重复建任务拦截失效
    this.mergeFromDisk();
    const bucket = this.data[userId]?.[url];
    if (!bucket) return undefined;
    if (projectId) {
      const entry = bucket[projectId];
      return entry ? { projectKey: projectId, entry } : undefined;
    }
    if (bucket['']) return { projectKey: '', entry: bucket[''] };
    const [projectKey, entry] = Object.entries(bucket)[0] || [];
    return entry ? { projectKey: projectKey!, entry } : undefined;
  }

  lookup(userId: string, url: string, projectId?: string): SyncedSource | undefined {
    return this.find(userId, url, projectId)?.entry;
  }

  record(userId: string, url: string, entry: SyncedSource, projectId?: string): void {
    this.mergeFromDisk();
    if (!this.data[userId]) this.data[userId] = {};
    if (!this.data[userId]![url]) this.data[userId]![url] = {};
    this.data[userId]![url]![projectId || ''] = entry;
    this.persist();
  }

  /**
   * 传 projectKey（含 ''）只删该键；不传则删除整个 URL 桶。
   * Merge first so persist does not stomp other instances' keys; deleting
   * after the merge guarantees the removed key cannot be resurrected by it.
   */
  remove(userId: string, url: string, projectKey?: string): void {
    this.mergeFromDisk();
    const entries = this.data[userId];
    if (!entries || !(url in entries)) return;
    if (projectKey === undefined) {
      delete entries[url];
    } else {
      delete entries[url]![projectKey];
      if (!Object.keys(entries[url]!).length) delete entries[url];
    }
    this.persist();
  }
}
