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
  console.log('  4. 权限：读取用户发给机器人的单聊消息 + 以应用身份发消息 + 添加消息表情回复（按提示申请）');
  console.log('  5. 发布应用版本；凭证页复制 App ID / App Secret');
  console.log(c.gray('  凭证配好后，本机常驻进程即可接收私聊消息。\n'));
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

  /**
   * Base URL 安全检查：http:// 明文端点会把 API Key 明文外发（本机 loopback 除外），
   * 给出醒目警告并要求显式确认；不确认则重新输入，直到拿到 https 或用户确认。
   */
  const ensureSecureBaseUrl = async (url: string): Promise<string> => {
    let u = url;
    for (;;) {
      if (/^https:\/\//i.test(u)) return u;
      // loopback 放行：IPv6 本机地址在 URL 中带方括号（http://[::1]:8080），一并覆盖
      if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(u)) return u;
      console.log(
        c.err(`⚠️ 警告：Base URL 使用 http:// 明文传输（${u}），你的 API Key 会以明文发送到该端点，可能被中间人窃取。`),
      );
      const ok = (await need('确认继续使用该明文端点？[输入 YES 继续 / 回车 = 重新输入 Base URL]: ')).toUpperCase();
      if (ok === 'YES' || ok === 'Y') return u;
      u = await need('Base URL（如 https://api.deepseek.com/v1）: ');
      if (!u) throw new Error('Base URL 不能为空');
    }
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
    baseUrl = await ensureSecureBaseUrl(baseUrl);
  }
  const apiKeyInput = await needSecret('API Key（输入显示为 *）: ');
  if (!apiKeyInput) throw new Error('API Key 不能为空');
  let apiKey = apiKeyInput;
  const modelInput = await need(`模型名（默认 ${preset.model || '必填'}）: `);
  let model = modelInput || preset.model;
  if (!model) throw new Error('模型名不能为空');

  // 联网预检模型配置：Key 无效在向导里暴露（可重输 API Key / Base URL / 模型名）；端点不支持预检/网络不通则提示后可仍保存。
  // 两个失败分支的默认动作统一为「修改重试」，保存必须显式输入 s——避免相邻问题同为回车却含义相反。
  for (;;) {
    console.log(c.gray('正在联网校验模型配置…'));
    const check = await verifyLlmConfig(baseUrl, apiKey);
    if (check.ok) {
      console.log(c.ok('模型配置校验通过'));
      break;
    }
    if (check.uncertain) {
      console.log(c.warn(`无法预检：${check.message}`));
    } else {
      console.log(c.err(`模型配置校验失败：${check.message}`));
    }
    const save = (await need('回车 = 修改配置重试；输入 s = 仍然保存: ')).toLowerCase();
    if (save === 's' || save === 'save' || save === '保存') break;
    const which = (await need('修改哪项？[k=API Key（默认）/ b=Base URL / m=模型名]: ')).toLowerCase();
    if (which === 'b' || which === 'base' || which === 'url') {
      baseUrl = await need('Base URL（如 https://api.deepseek.com/v1）: ');
      if (!baseUrl) throw new Error('Base URL 不能为空');
      baseUrl = await ensureSecureBaseUrl(baseUrl);
    } else if (which === 'm' || which === 'model') {
      model = await need('模型名: ');
      if (!model) throw new Error('模型名不能为空');
    } else {
      apiKey = await needSecret('API Key（输入显示为 *）: ');
      if (!apiKey) throw new Error('API Key 不能为空');
    }
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
    (await need(`默认迭代（可选，与看板 Web UI 的迭代名一致，如 260717；回车跳过${old.kanbanIteration ? `，当前 ${old.kanbanIteration}` : ''}）: `)) ||
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
 * 收集并校验飞书机器人凭证（联网校验失败可重输）。
 * allowClear 用于换绑场景：白名单可输入 `-` 清除（换新应用后旧 open_id 可能失效）。
 */
async function promptFeishuConfig(
  need: (promptText: string) => Promise<string>,
  needSecret: (promptText: string) => Promise<string>,
  existing: FeishuBotConfig,
  { allowClear = false }: { allowClear?: boolean } = {},
): Promise<FeishuBotConfig> {
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
    // 与模型校验分支统一交互：回车 = 重试；保存必须显式输入 s
    const save = (await need('回车 = 重新输入；输入 s = 仍然保存: ')).toLowerCase();
    if (save === 's' || save === 'save' || save === '保存') break;
  }
  const allowedPrompt = existing.allowedOpenIds.length
    ? `允许的 open_id（可选，逗号分隔；回车=保留当前 ${existing.allowedOpenIds.join(',')}${allowClear ? '；输入 - 清除' : ''}）: `
    : '允许的 open_id（可选，逗号分隔；回车=不限制）: ';
  const allowedRaw = await need(allowedPrompt);
  const allowedOpenIds =
    allowClear && allowedRaw === '-'
      ? []
      : allowedRaw
        ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : existing.allowedOpenIds;
  return { appId, appSecret, allowedOpenIds };
}

/**
 * 换绑飞书机器人：只重跑飞书凭证部分（模型/看板配置保留）。
 * 绑错机器人或要切换到另一个应用时使用：helios-task-agent bot --rebind
 */
export async function rebindFeishuBot(
  ask: AskFn,
  { askSecret = null }: { askSecret?: AskFn | null } = {},
): Promise<{ feishu: FeishuBotConfig; envPath: string }> {
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

  const existing = feishuBotConfig();
  if (existing.appId) {
    console.log(c.gray(`当前绑定 App ID: ${existing.appId}，输入新机器人的凭证即完成换绑。`));
  }
  const feishu = await promptFeishuConfig(need, needSecret, existing, { allowClear: true });
  const envPath = writeEnv(currentConfig(), feishu);
  console.log(c.ok(`\n飞书机器人已换绑，配置保存到 ${envPath}\n`));
  return { feishu, envPath };
}

/**
 * Bot onboarding: print checklist, collect Feishu (+ LLM if missing), save, ready to connect.
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
    feishu = await promptFeishuConfig(need, needSecret, feishu);
    const envPath = writeEnv(agent, feishu);
    console.log(c.ok(`\n飞书配置已保存到 ${envPath}\n`));
    if (!checkLarkCli()) console.log(c.warn(`未检测到 lark-cli。${LARK_CLI_INSTALL_HINT}\n`));
    return { agent: currentConfig(), feishu: feishuBotConfig(), envPath };
  }

  return { agent, feishu, envPath: resolveEnvWritePath() };
}
