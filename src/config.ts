import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { c } from './ui';
import type { AgentConfig, AskFn, ChooseFn, LlmPreset } from './types';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const ENV_PATH = path.join(__dirname, '..', '.env');

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

export function writeEnv(cfg: AgentConfig): void {
  const lines = [
    `LLM_BASE_URL=${cfg.llmBaseUrl}`,
    `LLM_API_KEY=${cfg.llmApiKey}`,
    `LLM_MODEL=${cfg.llmModel}`,
    `HELIOS_KANBAN_URL=${cfg.kanbanUrl}`,
  ];
  if (cfg.kanbanProjectId) lines.push(`HELIOS_KANBAN_PROJECT_ID=${cfg.kanbanProjectId}`);
  if (cfg.kanbanRepoId) lines.push(`HELIOS_KANBAN_REPO_ID=${cfg.kanbanRepoId}`);
  if (cfg.kanbanIteration) lines.push(`HELIOS_KANBAN_ITERATION=${cfg.kanbanIteration}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');

  process.env.LLM_BASE_URL = cfg.llmBaseUrl;
  process.env.LLM_API_KEY = cfg.llmApiKey;
  process.env.LLM_MODEL = cfg.llmModel;
  process.env.HELIOS_KANBAN_URL = cfg.kanbanUrl;
  if (cfg.kanbanProjectId) process.env.HELIOS_KANBAN_PROJECT_ID = cfg.kanbanProjectId;
  else delete process.env.HELIOS_KANBAN_PROJECT_ID;
  if (cfg.kanbanRepoId) process.env.HELIOS_KANBAN_REPO_ID = cfg.kanbanRepoId;
  else delete process.env.HELIOS_KANBAN_REPO_ID;
  if (cfg.kanbanIteration) process.env.HELIOS_KANBAN_ITERATION = cfg.kanbanIteration;
  else delete process.env.HELIOS_KANBAN_ITERATION;
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
  writeEnv(cfg);
  console.log(c.ok(`\n配置已保存到 .env（模型：${model}）\n`));
  return cfg;
}

export async function ensureConfig(
  ask: AskFn,
  { force = false, choose = null }: { force?: boolean; choose?: ChooseFn | null } = {},
): Promise<AgentConfig> {
  if (!force && isConfigured()) return currentConfig();
  return runWizard(ask, choose);
}
