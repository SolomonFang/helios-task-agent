import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeFilePrivateSync } from './private-file';
import type { MemoryFile, UserMemory } from './types';

const MAX_NOTES = 50;
/** 单条 fact value / note 的长度上限：记忆每轮回注系统提示词，无上限会被超长文本撑爆上下文。 */
const MAX_ENTRY_LEN = 1000;
const FILE_VERSION = 1;

function clampEntry(s: string): string {
  return s.length > MAX_ENTRY_LEN ? `${s.slice(0, MAX_ENTRY_LEN)}…（已截断）` : s;
}

export function defaultDataHome(): string {
  return process.env.HELIOS_TASK_AGENT_HOME || path.join(os.homedir(), '.helios-task-agent');
}

function emptyUser(): UserMemory {
  return { facts: {}, notes: [], updatedAt: new Date().toISOString() };
}

function emptyFile(): MemoryFile {
  return { version: FILE_VERSION, users: {} };
}

export class MemoryStore {
  readonly filePath: string;
  private data: MemoryFile;
  /**
   * Journal of this instance's own mutations since the last persist:
   * fact upserts/deletes (null = deleted) and appended notes, per user.
   * persist() replays only these onto a fresh disk read, so stale in-memory
   * copies can neither clobber nor resurrect keys changed by other instances.
   */
  private changedFacts = new Map<string, Map<string, string | null>>();
  private addedNotes = new Map<string, string[]>();

  constructor(homeDir?: string) {
    const root = homeDir || defaultDataHome();
    this.filePath = path.join(root, 'memory.json');
    this.data = this.load();
  }

  private load(): MemoryFile {
    try {
      if (!fs.existsSync(this.filePath)) return emptyFile();
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<MemoryFile>;
      if (!raw || typeof raw !== 'object') return emptyFile();
      return {
        version: typeof raw.version === 'number' ? raw.version : FILE_VERSION,
        users: raw.users && typeof raw.users === 'object' ? raw.users : {},
      };
    } catch {
      return emptyFile();
    }
  }

  private journalFact(userId: string, key: string, value: string | null): void {
    let journal = this.changedFacts.get(userId);
    if (!journal) this.changedFacts.set(userId, (journal = new Map()));
    journal.set(key, value);
  }

  /**
   * Reload disk, replay this instance's journaled mutations onto it, then
   * write. The file is shared between the CLI, the bot, and concurrent bot
   * sessions, so a blind full-file overwrite would lose updates from other
   * instances; replaying only our own changes means a key another instance
   * wrote survives, and a key this instance deleted is applied as a delete
   * (never resurrected by stale memory). Best-effort: never throws.
   */
  private persist(): void {
    try {
      const merged = this.load();
      for (const [uid, journal] of this.changedFacts) {
        const user = merged.users[uid] || (merged.users[uid] = emptyUser());
        for (const [key, value] of journal) {
          if (value === null) delete user.facts[key];
          else user.facts[key] = value;
        }
        user.updatedAt = new Date().toISOString();
      }
      for (const [uid, notes] of this.addedNotes) {
        const user = merged.users[uid] || (merged.users[uid] = emptyUser());
        const existing = new Set(user.notes);
        for (const note of notes) {
          if (!existing.has(note)) user.notes.push(note);
        }
        if (user.notes.length > MAX_NOTES) user.notes = user.notes.slice(-MAX_NOTES);
        user.updatedAt = new Date().toISOString();
      }
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFilePrivateSync(tmp, JSON.stringify(merged, null, 2) + '\n');
      fs.renameSync(tmp, this.filePath);
      this.data = merged;
      this.changedFacts.clear();
      this.addedNotes.clear();
    } catch {
      /* best-effort */
    }
  }

  private touch(userId: string): UserMemory {
    if (!this.data.users[userId]) this.data.users[userId] = emptyUser();
    const user = this.data.users[userId]!;
    user.updatedAt = new Date().toISOString();
    return user;
  }

  getUser(userId: string): UserMemory {
    const user = this.data.users[userId];
    if (!user) return emptyUser();
    return {
      facts: { ...user.facts },
      notes: [...(user.notes || [])],
      updatedAt: user.updatedAt,
    };
  }

  getFact(userId: string, key: string): string | undefined {
    return this.data.users[userId]?.facts[key];
  }

  getFacts(userId: string): Record<string, string> {
    return { ...(this.data.users[userId]?.facts || {}) };
  }

  setFact(userId: string, key: string, value: string): UserMemory {
    const k = key.trim();
    if (!k) throw new Error('key 不能为空');
    const v = clampEntry(String(value));
    const user = this.touch(userId);
    user.facts[k] = v;
    this.journalFact(userId, k, v);
    this.persist();
    return this.getUser(userId);
  }

  deleteFact(userId: string, key: string): boolean {
    const user = this.data.users[userId];
    if (!user || !(key in user.facts)) return false;
    delete user.facts[key];
    user.updatedAt = new Date().toISOString();
    this.journalFact(userId, key, null);
    this.persist();
    return true;
  }

  addNote(userId: string, text: string): UserMemory {
    const note = clampEntry(text.trim());
    if (!note) throw new Error('note 不能为空');
    const user = this.touch(userId);
    user.notes.push(note);
    if (user.notes.length > MAX_NOTES) user.notes = user.notes.slice(-MAX_NOTES);
    const pending = this.addedNotes.get(userId);
    if (pending) pending.push(note);
    else this.addedNotes.set(userId, [note]);
    this.persist();
    return this.getUser(userId);
  }

  /** Human-readable dump for /memory and system prompt. */
  formatForPrompt(userId: string): string {
    const user = this.getUser(userId);
    const factEntries = Object.entries(user.facts);
    if (!factEntries.length && !user.notes.length) {
      return '（暂无记忆）';
    }
    const lines: string[] = [];
    if (factEntries.length) {
      lines.push('键值：');
      for (const [k, v] of factEntries) lines.push(`- ${k}: ${v}`);
    }
    if (user.notes.length) {
      lines.push('备注：');
      for (const n of user.notes) lines.push(`- ${n}`);
    }
    return lines.join('\n');
  }
}

export const SUGGESTED_MEMORY_KEYS = [
  'feishu_task_source',
  'feishu_chat_id',
  'preferred_project_id',
  'preferred_repo_id',
  'preferred_iteration',
] as const;
