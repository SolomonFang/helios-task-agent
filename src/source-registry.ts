import fs from 'fs';
import path from 'path';
import { defaultDataHome } from './memory';

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
    const json = (await res.json()) as { success?: boolean };
    return json?.success === true;
  } catch {
    return true; // kanban unreachable → conservative: keep blocking
  }
}

export class SourceRegistry {
  readonly filePath: string;
  private data: RegistryData;

  constructor(homeDir?: string) {
    const root = homeDir || defaultDataHome();
    this.filePath = path.join(root, 'synced-sources.json');
    this.data = this.load();
  }

  private load(): RegistryData {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RegistryData;
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* best-effort */
    }
  }

  lookup(userId: string, url: string): SyncedSource | undefined {
    return this.data[userId]?.[url];
  }

  record(userId: string, url: string, entry: SyncedSource): void {
    if (!this.data[userId]) this.data[userId] = {};
    this.data[userId]![url] = entry;
    this.persist();
  }

  remove(userId: string, url: string): void {
    if (this.data[userId] && url in this.data[userId]!) {
      delete this.data[userId]![url];
      this.persist();
    }
  }
}
