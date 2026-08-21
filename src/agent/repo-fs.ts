import fs from 'fs';
import path from 'path';
import { errMessage } from '../infra/err';

const MAX_OUTPUT = 8000;
const MAX_GREP_HITS = 40;
const MAX_LIST_ENTRIES = 200;
const MAX_READ_BYTES = 200_000;
const MAX_PATTERN_LEN = 200;
// grep 树扫描总量上限：防止无命中 pattern 扫完整个大仓库拖垮事件循环
const MAX_GREP_SCAN_FILES = 5000;
const MAX_GREP_SCAN_BYTES = 50 * 1024 * 1024;
// 每扫描 N 个文件让出一次事件循环（bot 主循环同线程，避免长扫描阻塞消息处理）
const GREP_YIELD_EVERY_FILES = 100;
// re.test 前的单行限长兜底：ReDoS 启发式有逃逸路径（如 [ab]*[ab]*$、(a|aa)+$），
// V8 同步正则遇超长行会卡死 bot 主循环；命中展示本就截 200 字符，限长不影响可读性
const MAX_GREP_LINE_CHARS = 2000;

export function truncateOutput(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? s.slice(0, max) + `\n…（输出过长，已截断，共 ${s.length} 字符）` : s;
}

/** 原始错误（英文堆栈/响应体）进日志：用户面只给可执行出路，不落原文（同 confirm.ts/session.ts 的 [tag] 惯例）。 */
function logRepoFsError(context: string, detail: unknown): void {
  console.error(`[repo-fs] ${context}: ${typeof detail === 'string' ? detail : errMessage(detail)}`);
}

/** Resolve relPath under root; reject escapes outside root (including via symlinks). */
export function resolveUnderRoot(
  root: string,
  relPath = '.',
): { ok: true; abs: string } | { ok: false; error: string } {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relPath || '.');
  const rel = path.relative(rootAbs, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `路径越界：禁止访问仓库根目录之外的路径（目标路径：${relPath}）` };
  }
  // 符号链接防逃逸：字符串路径在界内但真实路径可能在界外
  if (fs.existsSync(target)) {
    const realRoot = fs.realpathSync(rootAbs);
    const realTarget = fs.realpathSync(target);
    const relReal = path.relative(realRoot, realTarget);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      return { ok: false, error: `路径越界：符号链接指向仓库根目录之外（目标路径：${relPath}）` };
    }
    return { ok: true, abs: realTarget };
  }
  return { ok: true, abs: target };
}

/**
 * 敏感文件 denylist：read/grep 的输出会发给第三方 LLM API，
 * .env、私钥、.npmrc 等命中时 read 拒绝、grep 跳过，不返回任何内容
 * （与 proc-env.ts 不向子进程泄露敏感变量同一思路）。
 */
const SENSITIVE_FILE_RE =
  /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.?credentials|id_rsa.*|id_ed25519.*|.*credentials.*\.json|token\.json|service-account.*\.json|client_secret.*\.json|.+\.(?:pem|key|p12|keystore))$/i;

/** .git/ 内部一律拒绝（按路径整体判定，非仅 basename）：config 含带 token 的 remote URL，hooks 等也不外发。 */
const GIT_INTERNAL_RE = /(^|[\\/])\.git([\\/]|$)/;

/**
 * .docker/.kube 的 config.json 常含 registry 凭证 / 集群证书与 token：按路径整体判定，
 * 只拒这两个目录下的 config.json，不误伤项目里普通的 config.json。
 */
const CREDENTIAL_CONFIG_RE = /(^|[\\/])\.(?:docker|kube)[\\/]config\.json$/i;

function isSensitiveFile(fileAbs: string): boolean {
  if (GIT_INTERNAL_RE.test(fileAbs)) return true;
  if (CREDENTIAL_CONFIG_RE.test(fileAbs)) return true;
  return SENSITIVE_FILE_RE.test(path.basename(fileAbs));
}

function sensitiveFileDenied(fileAbs: string): string {
  return `已拒绝读取：${path.basename(fileAbs)} 属于敏感文件（凭证/私钥类），内容不会发送给 AI 模型；如需查看请在本机直接打开。`;
}

export async function fetchRepoPath(  kanbanUrl: string,
  repoId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const base = kanbanUrl.replace(/\/$/, '');
  const url = `${base}/api/repos/${encodeURIComponent(repoId)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    let json: { success?: boolean; data?: { path?: string }; message?: string };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      logRepoFsError(`解析仓库信息响应失败（HTTP ${res.status}）`, text.slice(0, 200));
      return { ok: false, error: `看板接口异常（HTTP ${res.status}），无法获取仓库路径，请确认看板服务正常后重试` };
    }
    const repoPath = json.data?.path;
    if (!res.ok || !repoPath) {
      logRepoFsError(`获取仓库 ${repoId} 的本机路径失败（HTTP ${res.status}）`, json.message || text.slice(0, 300));
      return { ok: false, error: '未找到该仓库或仓库路径未配置，请在看板中确认仓库已注册后重试' };
    }
    return { ok: true, path: repoPath };
  } catch (err) {
    logRepoFsError(`请求看板服务失败（${url}）`, err);
    return { ok: false, error: '无法连接看板服务，请确认看板正在运行后重试' };
  }
}

/** 看板已注册仓库的本机路径列表（root 白名单校验用）。 */
async function fetchRegisteredRepoPaths(kanbanUrl: string): Promise<string[]> {
  const base = kanbanUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/repos`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { success?: boolean; data?: Array<{ path?: string }> };
  if (json?.success !== true || !Array.isArray(json.data)) return [];
  return json.data.map((r) => r.path || '').filter(Boolean);
}

/** root 是否落在看板已注册仓库（或其子目录）内——按真实路径比较。 */
function isUnderRegisteredRepo(rootAbs: string, repoPaths: string[]): boolean {
  let realRoot = rootAbs;
  try {
    realRoot = fs.realpathSync(rootAbs);
  } catch {
    /* 不存在则按字符串路径判定（后续 existsSync 会报错） */
  }
  for (const p of repoPaths) {
    let realRepo = p;
    try {
      realRepo = fs.realpathSync(p);
    } catch {
      continue;
    }
    const rel = path.relative(realRepo, realRoot);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

export async function resolveRepoRoot(opts: {
  kanbanUrl: string;
  root?: string;
  repoId?: string;
}): Promise<{ ok: true; root: string } | { ok: false; error: string; denied?: boolean }> {
  const explicitRoot = Boolean(opts.root?.trim());
  let root = opts.root?.trim() || '';
  if (!root && opts.repoId?.trim()) {
    const fetched = await fetchRepoPath(opts.kanbanUrl, opts.repoId.trim());
    if (!fetched.ok) return fetched;
    root = fetched.path;
  }
  if (!root) return { ok: false, error: '参数错误：需要 root（绝对路径）或 repo_id' };
  const rootAbs = path.resolve(root);
  if (!fs.existsSync(rootAbs)) {
    return { ok: false, error: `本地仓库路径不存在：${rootAbs}` };
  }
  if (!fs.statSync(rootAbs).isDirectory()) {
    return { ok: false, error: `本地仓库路径不是目录：${rootAbs}` };
  }
  // 显式 root 必须是看板已注册仓库（或其子目录），防止借道读取任意本机路径；校验失败关闭
  if (explicitRoot) {
    let repoPaths: string[];
    try {
      repoPaths = await fetchRegisteredRepoPaths(opts.kanbanUrl);
    } catch (err) {
      logRepoFsError('校验仓库白名单失败', err);
      // 区分网络异常与 HTTP 异常，给用户不同的可执行出路；不再裸挂原始错误（如「: HTTP 500」）
      const httpStatus = /^HTTP (\d{3})\b/.exec(errMessage(err))?.[1];
      const cause = httpStatus
        ? `看板接口异常（HTTP ${httpStatus}），请稍后再试或重启看板服务`
        : '看板不可达，请确认看板服务正在运行后重试';
      return {
        ok: false,
        denied: true,
        error: `无法校验仓库白名单（${cause}），已拒绝访问本机路径；看板恢复后再让我读取即可`,
      };
    }
    if (!isUnderRegisteredRepo(rootAbs, repoPaths)) {
      return {
        ok: false,
        denied: true,
        error: `路径不在看板注册仓库内，已拒绝访问（路径：${rootAbs}）。请在看板中注册该仓库，或改用 repo_id 参数。`,
      };
    }
  }
  return { ok: true, root: rootAbs };
}

export async function repoFsList(root: string, relPath = '.'): Promise<string> {
  const resolved = resolveUnderRoot(root, relPath);
  if (!resolved.ok) return resolved.error;
  if (isSensitiveFile(resolved.abs)) return sensitiveFileDenied(resolved.abs);
  if (!fs.existsSync(resolved.abs)) return `路径不存在：${relPath || '.'}`;
  const st = await fs.promises.stat(resolved.abs);
  if (!st.isDirectory()) return `不是目录：${relPath || '.'}`;
  const entries = await fs.promises.readdir(resolved.abs, { withFileTypes: true });
  // 先排序再截断：截断发生在 readdir 原始顺序上会展示任意子集且多次调用结果不稳定
  const lines = entries
    .map((e) => e.name + (e.isDirectory() ? '/' : ''))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_LIST_ENTRIES);
  const extra = entries.length > MAX_LIST_ENTRIES ? `\n…（共 ${entries.length} 项，已截断）` : '';
  return truncateOutput(`仓库根目录：${root}\n相对路径：${relPath || '.'}\n\n${lines.join('\n')}${extra}`);
}

export async function repoFsRead(root: string, relPath: string): Promise<string> {
  if (!relPath?.trim()) return '参数错误：read 需要 path（相对仓库根的文件路径）';
  const resolved = resolveUnderRoot(root, relPath);
  if (!resolved.ok) return resolved.error;
  if (isSensitiveFile(resolved.abs)) return sensitiveFileDenied(resolved.abs);
  if (!fs.existsSync(resolved.abs)) return `文件不存在：${relPath}`;
  const st = await fs.promises.stat(resolved.abs);
  if (!st.isFile()) return `不是文件：${relPath}`;
  const fh = await fs.promises.open(resolved.abs, 'r');
  try {
    const size = Math.min(st.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(size);
    // 用 bytesRead 截断：stat 与 read 之间文件被截短时，buf 尾部会残留 \0 混进输出文本
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (st.size > MAX_READ_BYTES) {
      text += `\n…（文件共 ${st.size} 字节，仅读取前 ${MAX_READ_BYTES / 10_000} 万字节）`;
    }
    return truncateOutput(`# ${relPath}\n\n${text}`);
  } finally {
    await fh.close();
  }
}

function matchesGlob(fileName: string, relFile: string, globHint?: string): boolean {
  if (!globHint) return true;
  if (globHint.startsWith('*.')) return fileName.endsWith(globHint.slice(1));
  return fileName.includes(globHint) || relFile.includes(globHint);
}

export async function repoFsGrep(root: string, pattern: string, relPath = '.', globHint?: string): Promise<string> {
  if (!pattern) return '参数错误：grep 需要 pattern';
  // pattern 来自模型生成：限制长度缓解 ReDoS，编译异常友好报错
  if (pattern.length > MAX_PATTERN_LEN) return `参数错误：搜索表达式过长（超过 ${MAX_PATTERN_LEN} 字符），请缩短后重试`;
  // 简单启发式拒绝嵌套量词（如 (\w+)+ 一类灾难性回溯），不过度工程
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) {
    return '参数错误：搜索表达式含嵌套量词（如 (\\w+)+），可能导致匹配卡死，请简化后重试';
  }
  // 无括号同样可 ReDoS：连续相邻的宽匹配量词段（.*.* / .+.* / \w*\w+ 等）在失配回退时
  // 会指数级回溯，V8 同步正则会阻塞 bot 事件循环。先剥离字符类再判定：
  // [.*] 里的 .* 是字面量，不算量词段，避免误伤。
  const noClasses = pattern.replace(/\[(?:\\.|[^\]])*\]/g, '');
  if (/(?:\.\*|\.\+|\.\{\d*,?\d*\}|\\[wWdDsS][*+]){2,}/.test(noClasses)) {
    return '参数错误：搜索表达式含连续相邻的量词段（如 .*.*），可能导致匹配卡死，请简化后重试';
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    logRepoFsError(`无效正则「${pattern}」`, err);
    return '搜索表达式不是有效的正则表达式，请检查括号/符号是否配对后重试';
  }
  const resolved = resolveUnderRoot(root, relPath);
  if (!resolved.ok) return resolved.error;
  if (!fs.existsSync(resolved.abs)) return `路径不存在：${relPath || '.'}`;
  // 目标本身命中敏感 denylist（含 .git/ 目录）时明确拒绝（树扫描场景则静默跳过）
  if (isSensitiveFile(resolved.abs)) return sensitiveFileDenied(resolved.abs);

  const hits: string[] = [];
  const skipDir = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'target', 'vendor']);
  // 扫描总量统计：超出 MAX_GREP_SCAN_FILES / MAX_GREP_SCAN_BYTES 即截断（scanTruncated 记录触发原因）
  let scannedFiles = 0;
  let scannedBytes = 0;
  let scanTruncated = '';

  const yieldIfNeeded = async () => {
    if (scannedFiles % GREP_YIELD_EVERY_FILES === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const scanFile = async (fileAbs: string) => {
    if (hits.length >= MAX_GREP_HITS || scanTruncated) return;
    if (isSensitiveFile(fileAbs)) return; // 敏感文件不参与 grep（同 read 的 denylist）
    const rel = path.relative(root, fileAbs);
    if (!matchesGlob(path.basename(fileAbs), rel, globHint)) return;
    let content: string;
    try {
      const st = await fs.promises.stat(fileAbs);
      if (st.size > MAX_READ_BYTES) return;
      scannedFiles++;
      scannedBytes += st.size;
      if (scannedFiles >= MAX_GREP_SCAN_FILES) scanTruncated = `已扫描 ${MAX_GREP_SCAN_FILES} 个文件`;
      else if (scannedBytes >= MAX_GREP_SCAN_BYTES) scanTruncated = `已扫描 ${Math.round(MAX_GREP_SCAN_BYTES / 1024 / 1024)}MB`;
      content = await fs.promises.readFile(fileAbs, 'utf8');
    } catch {
      return;
    }
    await yieldIfNeeded();
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= MAX_GREP_HITS) break;
      // 单行限长兜底：启发式放行的 ReDoS pattern 遇超长行不至于卡死事件循环
      const line = lines[i]!.slice(0, MAX_GREP_LINE_CHARS);
      if (re.test(line)) {
        hits.push(`${rel}:${i + 1}:${line.slice(0, 200)}`);
      }
    }
  };

  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= MAX_GREP_HITS || scanTruncated) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length >= MAX_GREP_HITS || scanTruncated) break;
      if (ent.isDirectory()) {
        if (skipDir.has(ent.name) || ent.name.startsWith('.')) continue;
        await walk(path.join(dir, ent.name));
        continue;
      }
      if (ent.isFile()) await scanFile(path.join(dir, ent.name));
    }
  };

  const startSt = await fs.promises.stat(resolved.abs);
  if (startSt.isFile()) {
    await scanFile(resolved.abs);
  } else await walk(resolved.abs);

  const truncNote = scanTruncated ? `\n…（${scanTruncated}，已达扫描总量上限，结果可能不全）` : '';
  if (!hits.length) return truncateOutput(`仓库根目录：${root}\n搜索表达式：${pattern}\n（无命中）${truncNote}`);
  const more = hits.length >= MAX_GREP_HITS ? `\n…（已达 ${MAX_GREP_HITS} 条上限）` : '';
  return truncateOutput(`仓库根目录：${root}\n搜索表达式：${pattern}\n\n${hits.join('\n')}${more}${truncNote}`);
}

export async function runRepoFs(
  kanbanUrl: string,
  args: {
    action: string;
    root?: string;
    repo_id?: string;
    path?: string;
    pattern?: string;
    glob?: string;
  },
): Promise<{ out: string; denied: boolean }> {
  const rootRes = await resolveRepoRoot({
    kanbanUrl,
    root: args.root,
    repoId: args.repo_id,
  });
  // denied 走结构化字段返回（白名单拒绝由 resolveRepoRoot 标记，敏感文件直读在下方判定），
  // 调用方据此记审计，不再反向解析输出文案
  if (!rootRes.ok) return { out: rootRes.error, denied: rootRes.denied === true };

  const action = (args.action || '').toLowerCase();
  const rel = args.path || '.';
  // 敏感文件直读目标的结构化判定：与 repoFs* 内部 denylist 同源（内部检查保留作纵深防御）
  const resolved = resolveUnderRoot(rootRes.root, rel);
  const denied = resolved.ok && isSensitiveFile(resolved.abs);
  switch (action) {
    case 'list':
      return { out: await repoFsList(rootRes.root, rel), denied };
    case 'read':
      return { out: await repoFsRead(rootRes.root, rel === '.' ? '' : rel), denied };
    case 'grep':
      return { out: await repoFsGrep(rootRes.root, args.pattern || '', rel, args.glob), denied };
    default:
      return { out: '参数错误：action 必须是 list | read | grep', denied: false };
  }
}
