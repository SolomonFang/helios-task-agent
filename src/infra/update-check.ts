import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { defaultDataHome, packageRoot } from './paths';
import { ensurePrivateDirSync, writeFilePrivateSync } from './private-file';
import { minimalChildEnv } from './proc-env';

/**
 * npm 版本更新检查：启动时探测 registry 上的更新版本，发现后请示用户是否更新。
 * - 结果缓存 24h（<home>/update-check.json），避免每次启动都请求 registry
 * - registry 跟随用户 npm 配置（如 npmmirror 镜像），冷连接也给了 8s 宽限
 * - 离线 / 请求失败 / 非交互场景一律静默跳过，绝不影响主流程
 * - 正式版只跟 latest；预发布版本同时比较 latest 与 next 频道
 * - HTA_UPDATE_CHECK=0 关闭；HTA_UPDATE_REGISTRY 可显式指定 registry
 */

export const PKG_NAME = 'helios-task-agent';
/** 更新提示附带的变更记录地址（评估是否升级的参考）。 */
export const CHANGELOG_URL = 'https://github.com/SolomonFang/helios-task-agent/blob/main/CHANGELOG.md';
const CACHE_FILE = 'update-check.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export interface DistTags {
  latest?: string;
  next?: string;
}

export interface UpdateInfo {
  current: string;
  /** 可更新到的版本号。 */
  latest: string;
  /** 来源频道（安装时用 @latest / @next）。 */
  tag: 'latest' | 'next';
}

export function readPkgVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 是否应跳过更新检查：显式关闭，或处于源码仓库（本地开发不打扰）。 */
export function updateCheckDisabled(): boolean {
  if (process.env.HTA_UPDATE_CHECK === '0') return true;
  try {
    if (fs.existsSync(path.join(packageRoot, '.git'))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function parseVersion(v: string): { nums: number[]; pre: string[] | null } {
  const core = v.trim().replace(/^v/i, '');
  const [main, pre] = core.split('-', 2);
  const nums = (main || '').split('.').map((s) => parseInt(s, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre: pre === undefined ? null : pre.split('.') };
}

/** Semver 预发布标识符比较：数字标识符按数值、且低于字母标识符；更短的集合优先级更低。 */
function comparePrerelease(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? parseInt(x, 10) : null;
    const ny = /^\d+$/.test(y) ? parseInt(y, 10) : null;
    if (nx !== null && ny !== null) return nx === ny ? 0 : nx > ny ? 1 : -1;
    if (nx !== null) return -1;
    if (ny !== null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** a>b → 1；a<b → -1；相等 → 0。同号时预发布版低于正式版（1.1.0-beta.0 < 1.1.0）。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! > pb.nums[i]! ? 1 : -1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePrerelease(pa.pre, pb.pre);
}

/** registry URL 归一化：仅接受 https://（http 会被中间人篡改版本元数据，继而诱导 npm i -g 恶意版本），不合格返回 ''。 */
export function normalizeRegistry(r: string): string {
  return /^https:\/\//.test(r.trim()) ? r.trim().replace(/\/+$/, '') : '';
}

/** 解析检查更新用的 registry：显式 env > npm 用户配置（镜像）> 官方。每进程解析一次（异步，不阻塞事件循环）。 */
let cachedRegistry: string | null = null;
function npmConfigRegistry(): Promise<string> {
  return new Promise((resolve) => {
    // 最小环境（同 defaultRunUpdate）：不向 npm 子进程泄露 LLM_API_KEY 等敏感变量
    execFile('npm', ['config', 'get', 'registry'], { timeout: 3000, cwd: os.homedir(), env: minimalChildEnv() }, (err, stdout) => {
      resolve(!err ? normalizeRegistry(stdout || '') : '');
    });
  });
}

async function npmRegistry(): Promise<string> {
  if (cachedRegistry) return cachedRegistry;
  let r = normalizeRegistry(process.env.HTA_UPDATE_REGISTRY || '');
  if (!r) r = normalizeRegistry(process.env.NPM_CONFIG_REGISTRY || '');
  if (!r) r = await npmConfigRegistry();
  cachedRegistry = r || 'https://registry.npmjs.org';
  return cachedRegistry;
}

async function fetchDistTags(): Promise<DistTags> {
  const registry = await npmRegistry();
  const res = await fetch(`${registry}/${PKG_NAME}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { 'dist-tags'?: DistTags };
  return json?.['dist-tags'] || {};
}

function readCache(cachePath: string, now: number): DistTags | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { checkedAt?: string } & DistTags;
    const ts = Date.parse(raw.checkedAt || '');
    if (!Number.isFinite(ts) || now - ts > CACHE_TTL_MS) return null;
    return { latest: raw.latest, next: raw.next };
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, tags: DistTags): void {
  try {
    ensurePrivateDirSync(path.dirname(cachePath));
    writeFilePrivateSync(
      cachePath,
      JSON.stringify({ checkedAt: new Date().toISOString(), latest: tags.latest, next: tags.next }) + '\n',
    );
  } catch {
    /* best-effort */
  }
}

export interface CheckForUpdateDeps {
  current: string;
  home?: string;
  now?: number;
  /** 测试注入；默认请求 npm registry。 */
  fetchDistTags?: () => Promise<DistTags>;
}

/** 有可用更新返回 UpdateInfo；无更新 / 检查失败一律返回 null（静默）。 */
export async function checkForUpdate(deps: CheckForUpdateDeps): Promise<UpdateInfo | null> {
  const home = deps.home || defaultDataHome();
  const now = deps.now ?? Date.now();
  const cachePath = path.join(home, CACHE_FILE);
  let tags = readCache(cachePath, now);
  if (!tags) {
    try {
      tags = await (deps.fetchDistTags || fetchDistTags)();
    } catch {
      return null; // 离线 / registry 不可达：静默跳过
    }
    // dist-tags 为空（res.ok 但响应无 dist-tags）不写缓存：否则空结果被缓存 24h，期间永不提示更新
    if (tags.latest || tags.next) writeCache(cachePath, tags);
  }
  const candidates: Array<{ tag: 'latest' | 'next'; version: string }> = [];
  if (tags.latest) candidates.push({ tag: 'latest', version: tags.latest });
  // 预发布用户同时关注 next 频道（beta 序列的更新通常发在 next）
  if (deps.current.includes('-') && tags.next) candidates.push({ tag: 'next', version: tags.next });
  let best: { tag: 'latest' | 'next'; version: string } | null = null;
  for (const c of candidates) {
    if (compareVersions(c.version, deps.current) <= 0) continue;
    if (!best || compareVersions(c.version, best.version) > 0) best = c;
  }
  return best ? { current: deps.current, latest: best.version, tag: best.tag } : null;
}

export type UpdateOutcome = 'updated' | 'skipped' | 'failed';

/**
 * 更新确认词表：独立于写操作闸门（confirm.ts 的 CONFIRM_YES_RE）。
 * 「执行」「批准」这类写操作批准词不应触发全局 npm i -g，词表只覆盖更新意图。
 */
export const UPDATE_YES_WORDS = ['更新', '确认更新', '升级', '确认', 'update', 'y', 'yes'];
export const UPDATE_YES_RE = new RegExp(`^(?:${UPDATE_YES_WORDS.join('|')})$`, 'i');

export interface PromptUpdateDeps {
  info: UpdateInfo;
  ask: (question: string) => Promise<string | null>;
  /** 测试注入；默认执行 npm i -g。 */
  runUpdate?: (tag: 'latest' | 'next') => Promise<boolean>;
  log?: (msg: string) => void;
}

function defaultRunUpdate(tag: 'latest' | 'next'): Promise<boolean> {
  return new Promise((resolve) => {
    // cwd 取用户主目录避免读项目级 .npmrc；最小环境防止 LLM_API_KEY 等敏感变量泄给子进程
    const child = spawn('npm', ['i', '-g', `${PKG_NAME}@${tag}`], {
      stdio: 'inherit',
      cwd: os.homedir(),
      env: minimalChildEnv(),
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * 发现新版本后请示用户。返回 'updated' 时调用方应提示重启并退出
 * （当前进程仍是旧代码，全局 bin 下次运行才生效）。
 */
export async function promptVersionUpdate(deps: PromptUpdateDeps): Promise<UpdateOutcome> {
  const { info } = deps;
  const log = deps.log || (() => {});
  const ans = (await deps.ask(`\n发现新版本 helios-task-agent ${info.latest}（当前 ${info.current}）。\n变更内容：${CHANGELOG_URL}\n现在更新？（输入 y 或「更新」确认，其他输入跳过） `)) || '';
  if (!UPDATE_YES_RE.test(ans.trim())) {
    log(`已跳过更新；随时可手动执行：npm i -g ${PKG_NAME}@${info.tag}（HTA_UPDATE_CHECK=0 可关闭启动检查）`);
    return 'skipped';
  }
  const run = deps.runUpdate || defaultRunUpdate;
  const ok = await run(info.tag);
  if (ok) {
    log(`✅ 已更新到 ${info.latest}`);
    return 'updated';
  }
  log(`更新失败，可稍后手动执行：npm i -g ${PKG_NAME}@${info.tag}`);
  return 'failed';
}
