import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeFilePrivateSync } from './private-file';
import type { MemoryFile, UserMemory } from './types';

const MAX_NOTES = 50;
const FILE_VERSION = 1;

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

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFilePrivateSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    fs.renameSync(tmp, this.filePath);
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
    const user = this.touch(userId);
    user.facts[k] = String(value);
    this.persist();
    return this.getUser(userId);
  }

  deleteFact(userId: string, key: string): boolean {
    const user = this.data.users[userId];
    if (!user || !(key in user.facts)) return false;
    delete user.facts[key];
    user.updatedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  addNote(userId: string, text: string): UserMemory {
    const note = text.trim();
    if (!note) throw new Error('note 不能为空');
    const user = this.touch(userId);
    user.notes.push(note);
    if (user.notes.length > MAX_NOTES) user.notes = user.notes.slice(-MAX_NOTES);
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
