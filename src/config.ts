import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { defaultDataHome } from './memory';
import type { AgentConfig, FeishuBotConfig, LlmPreset } from './types';

/** User-level config (Hermes-style). Wizards write here. */
export function userEnvPath(): string {
  return path.join(defaultDataHome(), '.env');
}

/** Package / repo .env (local development). */
export function projectEnvPath(): string {
  return path.join(__dirname, '..', '.env');
}

/**
 * Load env files: project first, then cwd, then user home (later overrides).
 * 用户目录是向导/owner 认领的写入目标（resolveEnvWritePath），必须最后加载
 * 才能保证写入的配置真实生效；HELIOS_TASK_AGENT_ENV 强制路径优先级最高。
 * Returns the path preferred for writes (existing cwd/project if present, else user home).
 */
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
    dotenv.config({ path: cwd, override: true });
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

const { primaryWritePath: INITIAL_WRITE_PATH } = loadEnvFiles();

/** @deprecated use userEnvPath / resolveEnvWritePath — kept for callers */
export const ENV_PATH = INITIAL_WRITE_PATH;

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
  return {
    llmBaseUrl: process.env.LLM_BASE_URL || '',
    llmApiKey: process.env.LLM_API_KEY || '',
    llmModel: process.env.LLM_MODEL || '',
    mcpCommand: process.env.HELIOS_KANBAN_MCP_COMMAND || 'npx',
    mcpArgs: (process.env.HELIOS_KANBAN_MCP_ARGS || '-y helios-kanban@latest --mcp').split(/\s+/).filter(Boolean),
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
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
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
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
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
  const body = keys.map((k) => `${k}=${map[k]}`).join('\n') + '\n';
  // 含 LLM_API_KEY / FEISHU_APP_SECRET 等凭证：仅属主可读写（mode 仅对新建生效，故对已存在文件再 chmod）
  fs.writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort（如 Windows 或不支持的文件系统） */
  }
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
