import { c } from './ui';
import {
  PRESETS,
  currentConfig,
  isConfigured,
  feishuBotConfig,
  isFeishuBotConfigured,
  writeEnv,
  resolveEnvWritePath,
} from './config';
import { checkLarkCli, LARK_CLI_INSTALL_HINT } from './deps';
import { verifyFeishuApp } from './feishu-verify';
import { verifyLlmConfig } from './llm-verify';
import type { AgentConfig, AskFn, ChooseFn, FeishuBotConfig } from './types';

export function printFeishuSetupChecklist(): void {
  console.log(c.strong('\n飞书开放平台（一次性，约 2 分钟）\n'));
  console.log(`  1. 打开 ${c.info('https://open.feishu.cn/')} → 创建企业自建应用`);
  console.log('  2. 应用能力 → 启用「机器人」');
  console.log('  3. 事件订阅 → 选「使用长连接接收事件」→ 添加 im.message.receive_v1');
  console.log('  4. 权限：读取用户发给机器人的单聊消息 + 以应用身份发消息（按提示申请）');
  console.log('  5. 发布应用版本；凭证页复制 App ID / App Secret');
  console.log(c.gray('  （与 Hermes 相同：凭证配好后，本机常驻进程即可收私聊）\n'));
}

async function runWizard(ask: AskFn, choose?: ChooseFn | null, askSecret?: AskFn | null): Promise<AgentConfig> {
  const need = async (promptText: string): Promise<string> => {
    const ans = await ask(promptText);
    if (ans === null) throw new Error('输入已结束');
    return ans.trim();
  };
  /** 敏感信息（API Key / App Secret）：TTY 下掩码回显；非 TTY 或未提供时回退普通输入。 */
  const needSecret = async (promptText: string): Promise<string> => {
    if (!askSecret) return need(promptText);
    const ans = await askSecret(promptText);
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
  const apiKeyInput = await needSecret('API Key (sk-...，输入显示为 *): ');
  if (!apiKeyInput) throw new Error('API Key 不能为空');
  let apiKey = apiKeyInput;
  const modelInput = await need(`模型名（默认 ${preset.model || '必填'}）: `);
  const model = modelInput || preset.model;
  if (!model) throw new Error('模型名不能为空');

  // 联网预检模型配置：Key 无效在向导里暴露（可重输）；端点不支持预检/网络不通则提示后可仍保存
  for (;;) {
    console.log(c.gray('正在联网校验模型配置…'));
    const check = await verifyLlmConfig(baseUrl, apiKey);
    if (check.ok) {
      console.log(c.ok('模型配置校验通过'));
      break;
    }
    if (check.uncertain) {
      console.log(c.warn(`无法预检：${check.message}`));
      const keep = (await need('仍然保存？[Y/n]（n = 重新输入 API Key）: ')).toLowerCase();
      if (keep !== 'n' && keep !== 'no' && keep !== '否') break;
    } else {
      console.log(c.err(`模型配置校验失败：${check.message}`));
      const retry = (await need('重新输入 API Key？[Y/n]（n = 仍然保存）: ')).toLowerCase();
      if (retry === 'n' || retry === 'no' || retry === '否') break;
    }
    apiKey = await needSecret('API Key (sk-...，输入显示为 *): ');
    if (!apiKey) throw new Error('API Key 不能为空');
  }
  console.log(c.gray('以下为可选的看板默认值：项目/仓库 ID 可在看板 Web UI 的地址栏或详情页复制，不确定直接回车跳过。'));
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
  { force = false, choose = null, askSecret = null }: { force?: boolean; choose?: ChooseFn | null; askSecret?: AskFn | null } = {},
): Promise<AgentConfig> {
  if (!force && isConfigured()) return currentConfig();
  return runWizard(ask, choose, askSecret);
}

/**
 * Hermes-style bot onboarding: print checklist, collect Feishu (+ LLM if missing), save, ready to connect.
 */
export async function ensureBotConfig(
  ask: AskFn,
  { force = false, choose = null, askSecret = null }: { force?: boolean; choose?: ChooseFn | null; askSecret?: AskFn | null } = {},
): Promise<{ agent: AgentConfig; feishu: FeishuBotConfig; envPath: string }> {
  const need = async (promptText: string): Promise<string> => {
    const ans = await ask(promptText);
    if (ans === null) throw new Error('输入已结束');
    return ans.trim();
  };
  const needSecret = async (promptText: string): Promise<string> => {
    if (!askSecret) return need(promptText);
    const ans = await askSecret(promptText);
    if (ans === null) throw new Error('输入已结束');
    return ans.trim();
  };

  let agent = currentConfig();
  if (force || !isConfigured()) {
    agent = await ensureConfig(ask, { force: true, choose, askSecret });
  }

  let feishu = feishuBotConfig();
  if (force || !isFeishuBotConfigured()) {
    printFeishuSetupChecklist();
    console.log(c.strong('配置飞书机器人凭证：\n'));
    let appId = '';
    let appSecret = '';
    // 联网校验凭证：无效凭证/未启用机器人在此暴露，而不是等长连接失败
    for (;;) {
      appId = await need('FEISHU_APP_ID (cli_...): ');
      if (!appId) throw new Error('App ID 不能为空');
      appSecret = await needSecret('FEISHU_APP_SECRET (输入显示为 *): ');
      if (!appSecret) throw new Error('App Secret 不能为空');
      console.log(c.gray('正在联网校验凭证…'));
      const check = await verifyFeishuApp(appId, appSecret);
      if (check.ok) {
        console.log(c.ok(`凭证校验通过${check.botName ? `：机器人「${check.botName}」` : ''}`));
        break;
      }
      console.log(c.err(`凭证校验失败：${check.message}`));
      const retry = (await need('重新输入？[Y/n]（n = 仍然保存）: ')).toLowerCase();
      if (retry === 'n' || retry === 'no' || retry === '否') break;
    }
    const allowedRaw = await need(
      `允许的 open_id（可选，逗号分隔；回车=不限制${feishu.allowedOpenIds.length ? `，当前 ${feishu.allowedOpenIds.join(',')}` : ''}）: `,
    );
    const allowedOpenIds = allowedRaw
      ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : feishu.allowedOpenIds;
    feishu = { appId, appSecret, allowedOpenIds };
    const envPath = writeEnv(agent, feishu);
    console.log(c.ok(`\n飞书配置已保存到 ${envPath}\n`));
    if (!checkLarkCli()) console.log(c.warn(`未检测到 lark-cli。${LARK_CLI_INSTALL_HINT}\n`));
    return { agent: currentConfig(), feishu: feishuBotConfig(), envPath };
  }

  return { agent, feishu, envPath: resolveEnvWritePath() };
}
