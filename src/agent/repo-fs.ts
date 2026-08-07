import fs from 'fs';
import path from 'path';
import { errMessage } from '../infra/err';

const MAX_OUTPUT = 8000;
const MAX_GREP_HITS = 40;
const MAX_LIST_ENTRIES = 200;
const MAX_READ_BYTES = 200_000;
const MAX_PATTERN_LEN = 200;

export function truncateOutput(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? s.slice(0, max) + `\n…（输出过长，已截断，共 ${s.length} 字符）` : s;
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
    return { ok: false, error: `路径越界：禁止访问仓库根目录之外（root=${rootAbs}, path=${relPath}）` };
  }
  // 符号链接防逃逸：字符串路径在界内但真实路径可能在界外
  if (fs.existsSync(target)) {
    const realRoot = fs.realpathSync(rootAbs);
    const realTarget = fs.realpathSync(target);
    const relReal = path.relative(realRoot, realTarget);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      return { ok: false, error: `路径越界：符号链接指向仓库根目录之外（path=${relPath}）` };
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
  return `已拒绝读取：${path.basename(fileAbs)} 属于敏感文件（凭证/私钥类），内容不会通过本工具发送给 LLM；如需查看请在本机直接打开。`;
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
      return { ok: false, error: `解析仓库信息失败 HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const repoPath = json.data?.path;
    if (!res.ok || !repoPath) {
      return {
        ok: false,
        error: `无法解析 repo_id=${repoId} 的本机 path：${json.message || text.slice(0, 300)}`,
      };
    }
    return { ok: true, path: repoPath };
  } catch (err) {
    return { ok: false, error: `请求 ${url} 失败: ${errMessage(err)}` };
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
}): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
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
    return { ok: false, error: `本地仓库路径不存在: ${rootAbs}` };
  }
  if (!fs.statSync(rootAbs).isDirectory()) {
    return { ok: false, error: `本地仓库路径不是目录: ${rootAbs}` };
  }
  // 显式 root 必须是看板已注册仓库（或其子目录），防止借道读取任意本机路径；校验失败关闭
  if (explicitRoot) {
    let repoPaths: string[];
    try {
      repoPaths = await fetchRegisteredRepoPaths(opts.kanbanUrl);
    } catch (err) {
      return {
        ok: false,
        error: `无法校验仓库白名单（kanban 不可达），已拒绝访问本机路径: ${errMessage(err)}`,
      };
    }
    if (!isUnderRegisteredRepo(rootAbs, repoPaths)) {
      return {
        ok: false,
        error: `路径不在看板注册仓库内，已拒绝访问（root=${rootAbs}）。请在看板中注册该仓库，或改用 repo_id 参数。`,
      };
    }
  }
  return { ok: true, root: rootAbs };
}

export function repoFsList(root: string, relPath = '.'): string {
  const resolved = resolveUnderRoot(root, relPath);
  if (!resolved.ok) return resolved.error;
  if (isSensitiveFile(resolved.abs)) return sensitiveFileDenied(resolved.abs);
  if (!fs.existsSync(resolved.abs)) return `路径不存在: ${relPath || '.'}`;
  const st = fs.statSync(resolved.abs);
  if (!st.isDirectory()) return `不是目录: ${relPath || '.'}`;
  const entries = fs.readdirSync(resolved.abs, { withFileTypes: true });
  const lines = entries
    .slice(0, MAX_LIST_ENTRIES)
    .map((e) => e.name + (e.isDirectory() ? '/' : ''))
    .sort((a, b) => a.localeCompare(b));
  const extra = entries.length > MAX_LIST_ENTRIES ? `\n…（共 ${entries.length} 项，已截断）` : '';
  return truncateOutput(`root: ${root}\npath: ${relPath || '.'}\n\n${lines.join('\n')}${extra}`);
}

export function repoFsRead(root: string, relPath: string): string {
  if (!relPath?.trim()) return '参数错误：read 需要 path（相对仓库根的文件路径）';
  const resolved = resolveUnderRoot(root, relPath);
  if (!resolved.ok) return resolved.error;
  if (isSensitiveFile(resolved.abs)) return sensitiveFileDenied(resolved.abs);
  if (!fs.existsSync(resolved.abs)) return `文件不存在: ${relPath}`;
  const st = fs.statSync(resolved.abs);
  if (!st.isFile()) return `不是文件: ${relPath}`;
  const fd = fs.openSync(resolved.abs, 'r');
  try {
    const size = Math.min(st.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    let text = buf.toString('utf8');
    if (st.size > MAX_READ_BYTES) {
      text += `\n…（文件共 ${st.size} 字节，仅读取前 ${MAX_READ_BYTES}）`;
    }
    return truncateOutput(`# ${relPath}\n\n${text}`);
  } finally {
    fs.closeSync(fd);
  }
}

function matchesGlob(fileName: string, relFile: string, globHint?: string): boolean {
  if (!globHint) return true;
  if (globHint.startsWith('*.')) return fileName.endsWith(globHint.slice(1));
  return fileName.includes(globHint) || relFile.includes(globHint);
}

export function repoFsGrep(root: string, pattern: string, relPath = '.', globHint?: string): string {
  if (!pattern) return '参数错误：grep 需要 pattern';
  // pattern 来自模型生成：限制长度缓解 ReDoS，编译异常友好报错
  if (pattern.length > MAX_PATTERN_LEN) return `参数错误：pattern 过长（>${MAX_PATTERN_LEN} 字符），请缩短后重试`;
  // 简单启发式拒绝嵌套量词（如 (\w+)+ 一类灾难性回溯），不过度工程
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) {
    return '参数错误：pattern 含嵌套量词（如 (\\w+)+），有 ReDoS 风险，请改写后重试';
  }
  // 无括号同样可 ReDoS：连续相邻的宽匹配量词段（.*.* / .+.* / \w*\w+ 等）在失配回退时
  // 会指数级回溯，V8 同步正则会阻塞 bot 事件循环。先剥离字符类再判定：
  // [.*] 里的 .* 是字面量，不算量词段，避免误伤。
  const noClasses = pattern.replace(/\[(?:\\.|[^\]])*\]/g, '');
  if (/(?:\.\*|\.\+|\.\{\d*,?\d*\}|\\[wWdDsS][*+]){2,}/.test(noClasses)) {
    return '参数错误：pattern 含连续相邻的量词段（如 .*.*），有 ReDoS 风险，请改写后重试';
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    return `无效正则: ${errMessage(err)}`;
  }
  const resolved = resolveUnderRoot(root, relPath);
  if (!resolved.ok) return resolved.error;
  if (!fs.existsSync(resolved.abs)) return `路径不存在: ${relPath || '.'}`;
  // 目标本身命中敏感 denylist（含 .git/ 目录）时明确拒绝（树扫描场景则静默跳过）
  if (isSensitiveFile(resolved.abs)) return sensitiveFileDenied(resolved.abs);

  const hits: string[] = [];
  const skipDir = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'target', 'vendor']);

  const scanFile = (fileAbs: string) => {
    if (hits.length >= MAX_GREP_HITS) return;
    if (isSensitiveFile(fileAbs)) return; // 敏感文件不参与 grep（同 read 的 denylist）
    const rel = path.relative(root, fileAbs);
    if (!matchesGlob(path.basename(fileAbs), rel, globHint)) return;
    let content: string;
    try {
      const st = fs.statSync(fileAbs);
      if (st.size > MAX_READ_BYTES) return;
      content = fs.readFileSync(fileAbs, 'utf8');
    } catch {
      return;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= MAX_GREP_HITS) break;
      if (re.test(lines[i]!)) {
        hits.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 200)}`);
      }
    }
  };

  const walk = (dir: string) => {
    if (hits.length >= MAX_GREP_HITS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length >= MAX_GREP_HITS) break;
      if (ent.isDirectory()) {
        if (skipDir.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(path.join(dir, ent.name));
        continue;
      }
      if (ent.isFile()) scanFile(path.join(dir, ent.name));
    }
  };

  const startSt = fs.statSync(resolved.abs);
  if (startSt.isFile()) {
    scanFile(resolved.abs);
  } else walk(resolved.abs);

  if (!hits.length) return truncateOutput(`root: ${root}\npattern: ${pattern}\n(无命中)`);
  const more = hits.length >= MAX_GREP_HITS ? `\n…（已达 ${MAX_GREP_HITS} 条上限）` : '';
  return truncateOutput(`root: ${root}\npattern: ${pattern}\n\n${hits.join('\n')}${more}`);
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
): Promise<string> {
  const rootRes = await resolveRepoRoot({
    kanbanUrl,
    root: args.root,
    repoId: args.repo_id,
  });
  if (!rootRes.ok) return rootRes.error;

  const action = (args.action || '').toLowerCase();
  const rel = args.path || '.';
  switch (action) {
    case 'list':
      return repoFsList(rootRes.root, rel);
    case 'read':
      return repoFsRead(rootRes.root, rel === '.' ? '' : rel);
    case 'grep':
      return repoFsGrep(rootRes.root, args.pattern || '', rel, args.glob);
    default:
      return '参数错误：action 必须是 list | read | grep';
  }
}
