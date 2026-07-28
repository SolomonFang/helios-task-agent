import fs from 'fs';
import path from 'path';

const MAX_OUTPUT = 8000;
const MAX_GREP_HITS = 40;
const MAX_LIST_ENTRIES = 200;
const MAX_READ_BYTES = 200_000;

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

export async function fetchRepoPath(
  kanbanUrl: string,
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
    return { ok: false, error: `请求 ${url} 失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function resolveRepoRoot(opts: {
  kanbanUrl: string;
  root?: string;
  repoId?: string;
}): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
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
  return { ok: true, root: rootAbs };
}

export function repoFsList(root: string, relPath = '.'): string {
  const resolved = resolveUnderRoot(root, relPath);
  if (!resolved.ok) return resolved.error;
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
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    return `无效正则: ${err instanceof Error ? err.message : String(err)}`;
  }
  const resolved = resolveUnderRoot(root, relPath);
  if (!resolved.ok) return resolved.error;
  if (!fs.existsSync(resolved.abs)) return `路径不存在: ${relPath || '.'}`;

  const hits: string[] = [];
  const skipDir = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'target', 'vendor']);

  const scanFile = (fileAbs: string) => {
    if (hits.length >= MAX_GREP_HITS) return;
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
  if (startSt.isFile()) scanFile(resolved.abs);
  else walk(resolved.abs);

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
