import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { c } from './ui';
import { defaultDataHome } from './memory';
import type { AgentConfig, AskFn, ChooseFn, FeishuBotConfig, LlmPreset } from './types';

/** User-level config (Hermes-style). Wizards write here. */
export function userEnvPath(): string {
  return path.join(defaultDataHome(), '.env');
}

/** Package / repo .env (local development). */
export function projectEnvPath(): string {
  return path.join(__dirname, '..', '.env');
}

/**
 * Load env files: user home first, then project, then cwd (later overrides).
 * Returns the path preferred for writes (existing cwd/project if present, else user home).
 */
export function loadEnvFiles(): { primaryWritePath: string; loaded: string[] } {
  const loaded: string[] = [];
  const home = userEnvPath();
  const project = projectEnvPath();
  const cwd = path.join(process.cwd(), '.env');

  if (fs.existsSync(home)) {
    dotenv.config({ path: home });
    loaded.push(home);
  }
  if (fs.existsSync(project) && path.resolve(project) !== path.resolve(home)) {
    dotenv.config({ path: project, override: true });
    loaded.push(project);
  }
  if (
    fs.existsSync(cwd) &&
    path.resolve(cwd) !== path.resolve(home) &&
    path.resolve(cwd) !== path.resolve(project)
  ) {
    dotenv.config({ path: cwd, override: true });
    loaded.push(cwd);
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
  fs.writeFileSync(filePath, body, 'utf8');
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

export function printFeishuSetupChecklist(): void {
  console.log(c.strong('\n飞书开放平台（一次性，约 2 分钟）\n'));
  console.log(`  1. 打开 ${c.info('https://open.feishu.cn/')} → 创建企业自建应用`);
  console.log('  2. 应用能力 → 启用「机器人」');
  console.log('  3. 事件订阅 → 选「使用长连接接收事件」→ 添加 im.message.receive_v1');
  console.log('  4. 权限：读取用户发给机器人的单聊消息 + 以应用身份发消息（按提示申请）');
  console.log('  5. 发布应用版本；凭证页复制 App ID / App Secret');
  console.log(c.gray('  （与 Hermes 相同：凭证配好后，本机常驻进程即可收私聊）\n'));
}

async function runWizard(ask: AskFn, choose?: ChooseFn | null): Promise<AgentConfig> {
  const need = async (promptText: string): Promise<string> => {
    const ans = await ask(promptText);
    if (ans === null) throw new Error('输入已结束');
    return ans.trim();
  };

  let idx: number;
  if (choose && process.stdin.isTTY) {
    idx = await choose(PRESETS);
  } else {
    console.log(c.strong('\n配置模型（OpenAI 兼容协议）：\n'));
    PRESETS.forEach((p, i) => {
      console.log(`  ${c.info(String(i + 1) + ')')} ${p.name}${p.baseUrl ? c.gray('  ' + p.baseUrl) : ''}`);
    });
    const pick = await need(`\n请选择 [1-${PRESETS.length}]（默认 1）: `);
    idx = Math.min(Math.max(parseInt(pick || '1', 10) || 1, 1), PRESETS.length) - 1;
  }
  const preset = PRESETS[idx]!;
  console.log(c.gray(`已选择 ${preset.name}`));

  const old = currentConfig();
  let baseUrl = preset.baseUrl;
  if (!baseUrl) {
    baseUrl = await need('Base URL（如 https://api.deepseek.com/v1）: ');
  }
  const apiKey = await need('API Key (sk-...): ');
  if (!apiKey) throw new Error('API Key 不能为空');
  const modelInput = await need(`模型名（默认 ${preset.model || '必填'}）: `);
  const model = modelInput || preset.model;
  if (!model) throw new Error('模型名不能为空');
  const kanbanUrl = (await need(`helios-kanban 地址（默认 ${old.kanbanUrl}）: `)) || old.kanbanUrl;
  const kanbanProjectId =
    (await need(`默认项目 ID（可选，回车跳过${old.kanbanProjectId ? `，当前 ${old.kanbanProjectId}` : ''}）: `)) ||
    old.kanbanProjectId;
  const kanbanRepoId =
    (await need(`默认仓库 ID（可选，回车跳过${old.kanbanRepoId ? `，当前 ${old.kanbanRepoId}` : ''}）: `)) ||
    old.kanbanRepoId;
  const kanbanIteration =
    (await need(`默认迭代（可选，如 260717，回车跳过${old.kanbanIteration ? `，当前 ${old.kanbanIteration}` : ''}）: `)) ||
    old.kanbanIteration;

  const cfg: AgentConfig = {
    ...old,
    llmBaseUrl: baseUrl,
    llmApiKey: apiKey,
    llmModel: model,
    kanbanUrl,
    kanbanProjectId,
    kanbanRepoId,
    kanbanIteration,
  };
  const saved = writeEnv(cfg);
  console.log(c.ok(`\n配置已保存到 ${saved}（模型：${model}）\n`));
  return cfg;
}

export async function ensureConfig(
  ask: AskFn,
  { force = false, choose = null }: { force?: boolean; choose?: ChooseFn | null } = {},
): Promise<AgentConfig> {
  if (!force && isConfigured()) return currentConfig();
  return runWizard(ask, choose);
}

/**
 * Hermes-style bot onboarding: print checklist, collect Feishu (+ LLM if missing), save, ready to connect.
 */
export async function ensureBotConfig(
  ask: AskFn,
  { force = false, choose = null }: { force?: boolean; choose?: ChooseFn | null } = {},
): Promise<{ agent: AgentConfig; feishu: FeishuBotConfig; envPath: string }> {
  const need = async (promptText: string): Promise<string> => {
    const ans = await ask(promptText);
    if (ans === null) throw new Error('输入已结束');
    return ans.trim();
  };

  let agent = currentConfig();
  if (force || !isConfigured()) {
    agent = await ensureConfig(ask, { force: true, choose });
  }

  let feishu = feishuBotConfig();
  if (force || !isFeishuBotConfigured()) {
    printFeishuSetupChecklist();
    console.log(c.strong('配置飞书机器人凭证：\n'));
    const appId = await need('FEISHU_APP_ID (cli_...): ');
    if (!appId) throw new Error('App ID 不能为空');
    const appSecret = await need('FEISHU_APP_SECRET: ');
    if (!appSecret) throw new Error('App Secret 不能为空');
    const allowedRaw = await need(
      `允许的 open_id（可选，逗号分隔；回车=不限制${feishu.allowedOpenIds.length ? `，当前 ${feishu.allowedOpenIds.join(',')}` : ''}）: `,
    );
    const allowedOpenIds = allowedRaw
      ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : feishu.allowedOpenIds;
    feishu = { appId, appSecret, allowedOpenIds };
    const envPath = writeEnv(agent, feishu);
    console.log(c.ok(`\n飞书配置已保存到 ${envPath}\n`));
    return { agent: currentConfig(), feishu: feishuBotConfig(), envPath };
  }

  return { agent, feishu, envPath: resolveEnvWritePath() };
}
