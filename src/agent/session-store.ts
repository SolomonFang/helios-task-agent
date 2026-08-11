import fs from 'fs';
import path from 'path';
import { defaultDataHome } from '../infra/paths';
import type { ChatMessage } from '../types';

/** 目录内会话历史文件总数上限：超出按 mtime 删最老，防长驻 bot 无界增长。 */
const DEFAULT_MAX_FILES = 100;
const FILE_VERSION = 1;
/** prune 节流：最多每隔这么久做一次目录扫描清理（每次 save 都 readdir+逐个 stat 太贵）。 */
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

/**
 * writeFileAtomicPrivateSync 的异步版本（tmp+rename 原子写、目录 0700、文件 0600 语义一致）。
 * private-file.ts 的同步实现供 config/memory 等同步路径共用；会话落盘每轮都发生，走异步不阻塞事件循环。
 */
async function writeFileAtomicPrivate(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.chmod(dir, 0o700);
  } catch {
    /* best-effort */
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.promises.chmod(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  await fs.promises.rename(tmp, filePath);
}

interface SessionHistoryFile {
  version: number;
  userId: string;
  updatedAt: string;
  /** 仅 user/assistant/tool；system prompt 与注入的 system note 不落盘。 */
  messages: ChatMessage[];
}

/**
 * open_id / 用户标识转安全文件名：白名单字符原样保留，其余折叠为 '-'，
 * 再剥掉首尾的点与横线（防 '../evil' 这类穿越、隐藏文件与 '..' 本体）。
 */
function safeFileName(userId: string): string {
  const name = userId.replace(/[^\w.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return `${name || 'user'}.json`;
}

/** tool_call 最小结构校验：缺 id/type/function.name 的畸形条目会让网关每轮 400，直接判非法。 */
function isValidToolCall(tc: unknown): boolean {
  if (!tc || typeof tc !== 'object') return false;
  const t = tc as { id?: unknown; type?: unknown; function?: unknown };
  if (typeof t.id !== 'string' || t.type !== 'function') return false;
  const fn = t.function as { name?: unknown } | undefined;
  return !!fn && typeof fn === 'object' && typeof fn.name === 'string';
}

/** 宽容校验：只接受结构基本合法的 user/assistant/tool 消息，坏条目直接丢弃。 */
function isPersistable(m: unknown): m is ChatMessage {
  if (!m || typeof m !== 'object') return false;
  const msg = m as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
  if (msg.role === 'user') return typeof msg.content === 'string';
  if (msg.role === 'tool') return typeof msg.tool_call_id === 'string' && typeof msg.content === 'string';
  if (msg.role === 'assistant') {
    if (msg.content != null && typeof msg.content !== 'string') return false;
    if (msg.tool_calls == null) return true;
    return Array.isArray(msg.tool_calls) && msg.tool_calls.every(isValidToolCall);
  }
  return false;
}

/**
 * 会话历史落盘：数据目录下 sessions/ 每用户一个文件（0600，目录 0700）。
 * 只持久化 user/assistant/tool：system prompt 每次启动重建；注入的 system note
 * （看板事件/AI 审查结果等 UNTRUSTED 外部内容）重启后已过期、会由 watcher 重推，不落盘。
 *
 * 多实例权衡（有意简化，区别于 memory.ts 的 journal 合并）：假设同一用户的会话同一时刻
 * 只在一个实例（CLI 或 bot）里活跃，因此采用「启动时加载 + 最后写入胜出」。并发写同一
 * 用户时后写覆盖先写，可能丢另一实例的最近轮次——可接受，不引入锁文件。
 */
export class SessionHistoryStore {
  readonly dir: string;
  private readonly maxFiles: number;
  private readonly pruneIntervalMs: number;
  /** save 串行队列：并发 save 共用同一 tmp 文件名（pid 后缀），排队防互相截断/错乱。 */
  private queue: Promise<void> = Promise.resolve();
  private lastPruneAt = 0;

  constructor(homeDir?: string, maxFiles = DEFAULT_MAX_FILES, pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS) {
    this.dir = path.join(homeDir || defaultDataHome(), 'sessions');
    this.maxFiles = maxFiles;
    this.pruneIntervalMs = pruneIntervalMs;
  }

  private fileFor(userId: string): string {
    const p = path.join(this.dir, safeFileName(userId));
    // 纵深防御：safeFileName 已剥离路径分隔符，这里再断言解析结果不逃出目录
    if (path.dirname(p) !== this.dir) throw new Error(`非法会话标识：${userId}`);
    return p;
  }

  /** 加载磁盘历史；文件不存在/坏 JSON/版本不符/格式不符一律视为无历史。 */
  load(userId: string): ChatMessage[] {
    try {
      const file = this.fileFor(userId);
      if (!fs.existsSync(file)) return [];
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SessionHistoryFile>;
      // 版本不符按无历史处理：避免旧假设解析新格式，静默载入畸形历史
      if (!raw || typeof raw !== 'object' || raw.version !== FILE_VERSION || !Array.isArray(raw.messages)) {
        return [];
      }
      return raw.messages.filter(isPersistable);
    } catch {
      return [];
    }
  }

  /**
   * 全量重写该用户的历史文件（原子写 0600），随后按上限清理目录（按 pruneIntervalMs 节流）。
   * 异步：返回 Promise，写盘失败以 rejection 上报，由调用方记日志兜底（持久化是增强，不打断对话）；
   * fire-and-forget 调用方应 .catch 记日志。消息快照在入队时同步序列化，后续轮次变更不混入本次写入。
   */
  save(userId: string, messages: ChatMessage[]): Promise<void> {
    const data: SessionHistoryFile = {
      version: FILE_VERSION,
      userId,
      updatedAt: new Date().toISOString(),
      messages: messages.filter(isPersistable),
    };
    const content = JSON.stringify(data) + '\n';
    const file = this.fileFor(userId);
    const job = this.queue.then(() => this.writeAndMaybePrune(file, content));
    // 失败只回报本次调用方，不污染后续队列
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async writeAndMaybePrune(file: string, content: string): Promise<void> {
    await writeFileAtomicPrivate(file, content);
    const now = Date.now();
    if (now - this.lastPruneAt < this.pruneIntervalMs) return;
    this.lastPruneAt = now;
    await this.prune();
  }

  /** 删除该用户的磁盘历史（/clear 同步清盘）；文件不存在静默忽略。 */
  clear(userId: string): void {
    fs.rmSync(this.fileFor(userId), { force: true });
  }

  /** 文件总数超上限时按 mtime 删最老（mtime 读取失败的排最前优先删）。 */
  private async prune(): Promise<void> {
    let files: string[];
    try {
      files = (await fs.promises.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    if (files.length <= this.maxFiles) return;
    const withMtime = await Promise.all(
      files.map(async (f) => {
        try {
          return { f, mtime: (await fs.promises.stat(path.join(this.dir, f))).mtimeMs };
        } catch {
          return { f, mtime: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => a.mtime - b.mtime);
    for (const { f } of withMtime.slice(0, withMtime.length - this.maxFiles)) {
      try {
        await fs.promises.rm(path.join(this.dir, f), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
