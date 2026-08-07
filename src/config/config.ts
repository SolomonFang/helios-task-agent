import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { defaultDataHome, packageRoot } from '../infra/paths';
import { writeFileAtomicPrivateSync } from '../infra/private-file';
import { kanbanPackageSpec } from '../infra/deps';
import type { AgentConfig, FeishuBotConfig, LlmPreset } from '../types';

/** User-level config. Wizards write here. */
export function userEnvPath(): string {
  return path.join(defaultDataHome(), '.env');
}

/** Package / repo .env (local development). */
export function projectEnvPath(): string {
  return path.join(packageRoot, '.env');
}

/**
 * Load env files: project first, then cwd, then user home (later overrides).
 * 用户目录是向导/owner 认领的写入目标（resolveEnvWritePath），必须最后加载
 * 才能保证写入的配置真实生效；HELIOS_TASK_AGENT_ENV 强制路径优先级最高。
 * cwd .env 的高危键（见 CWD_RESTRICTED_KEYS）不参与覆盖，只由 home/项目/shell 提供。
 * Returns the path preferred for writes (existing cwd/project if present, else user home).
 */
/**
 * cwd .env 不允许覆盖的高危键：用户在含恶意 .env 的目录（如下载的样例仓库）
 * 启动时，威胁分两类——
 * 1) 凭证外泄：LLM_BASE_URL 指向攻击者端点会导致 Authorization: Bearer <LLM_API_KEY>
 *    被外发；飞书凭证与 owner 白名单同理；
 * 2) 命令注入：HELIOS_KANBAN_MCP_COMMAND/ARGS 直接成为 MCP StdioClientTransport
 *    spawn 的命令，HELIOS_KANBAN_PACKAGE / OCR_PACKAGE 会被 npx -y 自动执行，
 *    HELIOS_KANBAN_URL 决定看板地址，HELIOS_TASK_AGENT_HOME 决定数据目录；
 * 3) 供应链劫持：NPM_CONFIG_REGISTRY 会让自动拉起的 npx 钉版本包从恶意 registry
 *    下载，HTTP(S)_PROXY/NO_PROXY 会劫持 npx 与全部外发请求的流量（这些键会被
 *    proc-env 透传给看板/ocr 子进程），大小写变体一并限制。
 * 4) 子进程可执行文件/动态库劫持：PATH/HOME/SHELL 改变 spawn 的命令解析与展开，
 *    NODE_OPTIONS/NODE_PATH 向所有 node 子进程注入模块，LD_PRELOAD/DYLD_*
 *    向所有原生子进程注入动态库——cwd .env 注入这些键等价于任意代码执行；
 * 5) 无鉴权服务暴露：HELIOS_KANBAN_HOST/HELIOS_REPORT_HOST 决定看板与报告服务
 *    的绑定地址，恶意 cwd .env 可将其绑到 0.0.0.0 把无鉴权接口暴露给局域网。
 * 这些键只接受 shell 环境、项目 .env、用户 home .env（及 HELIOS_TASK_AGENT_ENV
 * 强制路径）的值。
 */
const CWD_RESTRICTED_KEYS = new Set([
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_ALLOWED_OPEN_IDS',
  'HELIOS_KANBAN_MCP_COMMAND',
  'HELIOS_KANBAN_MCP_ARGS',
  'HELIOS_KANBAN_PACKAGE',
  'OCR_PACKAGE',
  'HELIOS_KANBAN_URL',
  'HELIOS_TASK_AGENT_HOME',
  'NPM_CONFIG_REGISTRY',
  'npm_config_registry',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // 大小写形态都收（同 http_proxy/HTTP_PROXY 双形态）：PATH 决定子进程命令解析
  'PATH',
  'path',
  'HOME',
  'SHELL',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'HELIOS_KANBAN_HOST',
  'HELIOS_REPORT_HOST',
]);

export function loadEnvFiles(): { primaryWritePath: string; loaded: string[] } {
  const loaded: string[] = [];
  const home = userEnvPath();
  const project = projectEnvPath();
  const cwd = path.join(process.cwd(), '.env');

  if (fs.existsSync(project)) {
    dotenv.config({ path: project });
    loaded.push(project);
  }
  if (fs.existsSync(cwd) && path.resolve(cwd) !== path.resolve(project)) {
    // 不用 dotenv.config(override)：先解析再过滤高危键，其余键仍覆盖项目 .env。
    const parsed = dotenv.parse(fs.readFileSync(cwd));
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (CWD_RESTRICTED_KEYS.has(k)) {
        dropped.push(k);
        continue;
      }
      process.env[k] = v;
    }
    if (dropped.length) {
      console.warn(`[config] cwd .env 中的高危键已被忽略（改由用户 home .env 提供）: ${dropped.join(', ')}`);
    }
    loaded.push(cwd);
  }
  if (fs.existsSync(home) && !loaded.some((p) => path.resolve(p) === path.resolve(home))) {
    dotenv.config({ path: home, override: true });
    loaded.push(home);
  }

  // HELIOS_TASK_AGENT_ENV 指定的文件具有最高优先级：即使路径与前面重复，
  // 也必须在最后重新加载一次（override），确保覆盖项目/用户 .env。
  const forced = process.env.HELIOS_TASK_AGENT_ENV;
  if (forced && fs.existsSync(forced)) {
    dotenv.config({ path: forced, override: true });
    if (!loaded.some((p) => path.resolve(p) === path.resolve(forced))) loaded.push(forced);
  }

  // Prefer writing to an existing local .env during repo dev; otherwise user home.
  let primaryWritePath = home;
  if (loaded.includes(cwd)) primaryWritePath = cwd;
  else if (loaded.includes(project)) primaryWritePath = project;
  else primaryWritePath = home;

  return { primaryWritePath, loaded };
}

/**
 * 显式初始化入口（幂等）：加载 .env 文件到 process.env。
 * 本模块 import 时无任何副作用（不读盘、不改 process.env）——库调用方 import
 * index.ts 不应触发 IO。CLI / bot 入口在 main() 开头显式调用本函数；
 * 读取函数（currentConfig / feishuBotConfig）未初始化时被调用会懒初始化一次，
 * 保证直接以库方式使用（如 scripts/smoke.ts）也能拿到 .env 配置。
 * 测试需要重复加载或隔离时直接调用 loadEnvFiles（非幂等，每次真实读盘）。
 */
let envLoaded = false;
export function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  loadEnvFiles();
}

/** Wizards always persist to user home (override with HELIOS_TASK_AGENT_ENV). */
export function resolveEnvWritePath(): string {
  return process.env.HELIOS_TASK_AGENT_ENV || userEnvPath();
}

export const PRESETS: LlmPreset[] = [
  {
    name: 'Kimi Coding（sk-kimi-…）',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'kimi-for-coding',
  },
  {
    name: 'Kimi / Moonshot（国内）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
  },
  {
    name: 'Kimi / Moonshot（国际）',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2-0905-preview',
  },
  {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    name: '自定义（OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
  },
];

export function currentConfig(): AgentConfig {
  ensureEnvLoaded(); // 懒初始化：未显式初始化时保证 .env 已加载（幂等，见上）
  return {
    llmBaseUrl: process.env.LLM_BASE_URL || '',
    llmApiKey: process.env.LLM_API_KEY || '',
    llmModel: process.env.LLM_MODEL || '',
    mcpCommand: process.env.HELIOS_KANBAN_MCP_COMMAND || 'npx',
    mcpArgs: (process.env.HELIOS_KANBAN_MCP_ARGS || `-y ${kanbanPackageSpec()} --mcp`).split(/\s+/).filter(Boolean),
    kanbanUrl: process.env.HELIOS_KANBAN_URL || 'http://localhost:7964',
    kanbanProjectId: process.env.HELIOS_KANBAN_PROJECT_ID || '',
    kanbanRepoId: process.env.HELIOS_KANBAN_REPO_ID || '',
    kanbanIteration: process.env.HELIOS_KANBAN_ITERATION || '',
  };
}

export function isConfigured(): boolean {
  const cfg = currentConfig();
  return Boolean(cfg.llmBaseUrl && cfg.llmApiKey && cfg.llmModel);
}

export function feishuBotConfig(): FeishuBotConfig {
  ensureEnvLoaded(); // 懒初始化：同 currentConfig
  const allowed = (process.env.FEISHU_ALLOWED_OPEN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    allowedOpenIds: allowed,
  };
}

export function isFeishuBotConfigured(): boolean {
  const cfg = feishuBotConfig();
  return Boolean(cfg.appId && cfg.appSecret);
}

function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      // 双引号值按 serializeEnvValue 的写法对称反转义（单趟扫描，\\ 最后判定）
      val = val
        .slice(1, -1)
        .replace(/\\(.)/gs, (_, c: string) =>
          c === 'n' ? '\n' : c === 'r' ? '\r' : c === '"' || c === '\\' ? c : `\\${c}`,
        );
    } else if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * 写 .env 时的值序列化：不含空白/#/引号/换行时直写（保持既有输出风格）；
 * 否则双引号包裹并转义，避免含 " #" 的值被 dotenv 当注释截断。
 * 注意 dotenv@16 的 parse 只展开双引号内的 \n/\r、不反转义 \" \\，含双引号或
 * 反斜杠的值以本文件 parseEnvFile 读回为准（本项目写入的均为 URL/key/id 等简单值）。
 */
function serializeEnvValue(v: string): string {
  if (v !== '' && !/[\s#"'\\]/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

function applyProcessEnv(map: Record<string, string>): void {
  for (const [k, v] of Object.entries(map)) {
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
}

/** Merge-write .env (preserves unrelated keys like FEISHU_*). */
export function writeEnvFile(
  updates: Record<string, string | undefined>,
  filePath = resolveEnvWritePath(),
): string {
  const map = parseEnvFile(filePath);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === '') delete map[k];
    else map[k] = v;
  }
  const preferredOrder = [
    'LLM_BASE_URL',
    'LLM_API_KEY',
    'LLM_MODEL',
    'HELIOS_KANBAN_URL',
    'HELIOS_KANBAN_PROJECT_ID',
    'HELIOS_KANBAN_REPO_ID',
    'HELIOS_KANBAN_ITERATION',
    'HELIOS_KANBAN_MCP_COMMAND',
    'HELIOS_KANBAN_MCP_ARGS',
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_ALLOWED_OPEN_IDS',
    'HELIOS_TASK_AGENT_HOME',
  ];
  const keys = [...preferredOrder.filter((k) => k in map), ...Object.keys(map).filter((k) => !preferredOrder.includes(k))];
  const body = keys.map((k) => `${k}=${serializeEnvValue(map[k]!)}`).join('\n') + '\n';
  // 原子写：tmp + rename（统一实现见 writeFileAtomicPrivateSync），
  // 避免写盘中途被杀导致 .env 截断、凭证丢失；rename 后目标一定是新建的
  // 0600 文件（内部含 chmod），所在目录确保 0700。
  writeFileAtomicPrivateSync(filePath, body);
  applyProcessEnv(map);
  return filePath;
}

export function writeEnv(cfg: AgentConfig, feishu?: Partial<FeishuBotConfig>): string {
  const updates: Record<string, string | undefined> = {
    LLM_BASE_URL: cfg.llmBaseUrl,
    LLM_API_KEY: cfg.llmApiKey,
    LLM_MODEL: cfg.llmModel,
    HELIOS_KANBAN_URL: cfg.kanbanUrl,
    HELIOS_KANBAN_PROJECT_ID: cfg.kanbanProjectId || undefined,
    HELIOS_KANBAN_REPO_ID: cfg.kanbanRepoId || undefined,
    HELIOS_KANBAN_ITERATION: cfg.kanbanIteration || undefined,
  };
  if (feishu) {
    if (feishu.appId !== undefined) updates.FEISHU_APP_ID = feishu.appId || undefined;
    if (feishu.appSecret !== undefined) updates.FEISHU_APP_SECRET = feishu.appSecret || undefined;
    if (feishu.allowedOpenIds !== undefined) {
      updates.FEISHU_ALLOWED_OPEN_IDS = feishu.allowedOpenIds.length
        ? feishu.allowedOpenIds.join(',')
        : undefined;
    }
  }
  return writeEnvFile(updates);
}
