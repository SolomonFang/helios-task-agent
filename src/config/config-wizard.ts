import { c } from '../infra/ui';
import {
  PRESETS,
  currentConfig,
  isConfigured,
  feishuBotConfig,
  isFeishuBotConfigured,
  ocrLlmOverrides,
  writeEnv,
  resolveEnvWritePath,
  userEnvPath,
} from './config';
import { checkLarkCli, LARK_CLI_INSTALL_HINT } from '../infra/deps';
import { verifyFeishuApp } from './feishu-verify';
import { verifyLlmConfig } from './llm-verify';
import type { AgentConfig, AskFn, ChooseFn, FeishuBotConfig, OcrLlmOverrides } from '../types';

export function printFeishuSetupChecklist(): void {
  console.log(c.strong('\n飞书开放平台（一次性，约 2 分钟）\n'));
  console.log(`  1. 打开 ${c.info('https://open.feishu.cn/')} → 创建企业自建应用`);
  console.log('  2. 应用能力 → 启用「机器人」');
  console.log('  3. 事件订阅 → 选「使用长连接接收事件」→ 添加 im.message.receive_v1');
  console.log('  4. 权限：读取用户发给机器人的单聊消息 + 以应用身份发消息 + 添加消息表情回复（按提示申请）');
  console.log('  5. 发布应用版本；凭证页复制 App ID / App Secret');
  console.log(c.gray('  凭证配好后，本机常驻进程即可接收私聊消息。\n'));
}

/**
 * need/needSecret 闭包工厂：need 读取一行输入（EOF 抛错、去空白），needSecret 为密钥
 * 掩码输入（未提供 askSecret 时回退普通输入）。secretSuffix 按是否真正走掩码给出
 * 如实提示（掩码 =「输入显示为 *」，回退明文 =「输入可见」）。
 * runWizard / rebindFeishuBot / ensureBotConfig 共用——此前同一对闭包逐字复制了三份。
 */
export function makeNeed(
  ask: AskFn,
  askSecret?: AskFn | null,
): { need: (promptText: string) => Promise<string>; needSecret: (promptText: string) => Promise<string>; secretSuffix: string } {
  // EOF/中断：bot 两阶段流程模型配置可能已先落盘，文案如实说明断点续跑；
  // 非 TTY（systemd/Docker）重跑向导必然同样 EOF，出路是给配置文件的确切路径。
  const eofError = (): Error =>
    new Error(
      process.stdin.isTTY
        ? '输入已结束（已完成的步骤已保存，重新运行可从断点继续）'
        : `输入已结束（已完成的步骤已保存，重新运行可从断点继续；无交互终端时请直接编辑 ${userEnvPath()}）`,
    );
  const need = async (promptText: string): Promise<string> => {
    const ans = await ask(promptText);
    if (ans === null) throw eofError();
    return ans.trim();
  };
  /** 敏感信息（API Key / App Secret）：TTY 下掩码回显；非 TTY 或未提供时回退普通输入（明文可见）。 */
  const needSecret = async (promptText: string): Promise<string> => {
    if (!askSecret) return need(promptText);
    const ans = await askSecret(promptText);
    if (ans === null) throw eofError();
    return ans.trim();
  };
  const secretSuffix = askSecret ? '（输入显示为 *）' : '（输入可见）';
  return { need, needSecret, secretSuffix };
}

/**
 * 飞书白名单合并决策（纯函数，向导交互外可测）：
 * 输入 `-`（仅换绑场景 allowClear）= 清除；输入新列表 = 覆盖；回车 = 保留现状。
 */
export function resolveAllowedOpenIds(raw: string, existing: string[], allowClear: boolean): string[] {
  if (allowClear && raw === '-') return [];
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : existing;
}

async function runWizard(ask: AskFn, choose?: ChooseFn | null, askSecret?: AskFn | null): Promise<AgentConfig> {
  const { need, needSecret, secretSuffix } = makeNeed(ask, askSecret);

  /**
   * Base URL 安全检查：http:// 明文端点会把 API Key 明文外发（本机 loopback 除外），
   * 给出醒目警告并要求显式确认；不确认则重新输入，直到拿到 https 或用户确认。
   * opts.label：重输/警告文案的场景名（主模型 / AI 审查）；opts.allowEmpty：可选字段
   * 在重输提示处回车 = 放弃设置本项（返回 ''），不算校验失败。
   */
  const ensureSecureBaseUrl = async (url: string, opts: { label?: string; allowEmpty?: boolean } = {}): Promise<string> => {
    const label = opts.label ?? 'Base URL';
    const reprompt = async (): Promise<string> => {
      const v = await need(`${label}（如 https://api.deepseek.com/v1）: `);
      if (!v) {
        if (opts.allowEmpty) return '';
        throw new Error(`${label} 不能为空`);
      }
      return v;
    };
    let u = url;
    for (;;) {
      if (/^https:\/\//i.test(u)) return u;
      // 无协议前缀（如漏写 https:// 的 api.deepseek.com/v1）：不是明文端点，直接要求重输
      if (!/^http:\/\//i.test(u)) {
        console.log(c.err('请输入以 https:// 开头的地址。http:// 明文端点会要求显式确认（本机地址除外），建议用 https://，如 https://api.deepseek.com/v1。'));
        u = await reprompt();
        if (!u) return '';
        continue;
      }
      // loopback 放行：IPv6 本机地址在 URL 中带方括号（http://[::1]:8080），一并覆盖
      if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(u)) return u;
      console.log(
        c.err(`⚠️ 警告：${label} 使用 http:// 明文传输（${u}），你的 API Key 会以明文发送到该端点，可能被中间人窃取。`),
      );
      const ok = (await need('确认继续使用该明文端点？（输入 YES 继续 / 回车 = 重新输入）: ')).toUpperCase();
      if (ok === 'YES' || ok === 'Y') return u;
      u = await reprompt();
      if (!u) return '';
    }
  };

  /**
   * 已配置过的重配场景（/config、bot --reconfig）在预设列表末尾追加「跳过」项：
   * 选中（或非 TTY 输入 0 / 直接回车）即保留现有模型配置，直接进看板默认值等后续步骤，
   * 不再追问 API Key、也不重复联网校验。首次配置（isConfigured() 为假）无此项。
   */
  const old = currentConfig();
  const skippable = isConfigured();
  const SKIP_IDX = PRESETS.length;
  let idx: number;
  if (choose && process.stdin.isTTY) {
    idx = await choose(
      skippable ? [...PRESETS, { name: `跳过，保留当前模型（${old.llmModel}）`, baseUrl: '', model: '' }] : PRESETS,
    );
  } else {
    // 与 wizardChoose 的 selectList 同一口径：重配时标题给出当前模型
    console.log(c.strong(`\n配置模型（OpenAI 兼容协议${old.llmModel ? `，当前 ${old.llmModel}` : ''}）：\n`));
    if (skippable) console.log(`  ${c.info('0)')} 跳过，保留当前模型（${old.llmModel}）`);
    PRESETS.forEach((p, i) => {
      console.log(`  ${c.info(String(i + 1) + ')')} ${p.name}${p.baseUrl ? c.gray('  ' + p.baseUrl) : ''}`);
    });
    for (;;) {
      const pick = await need(
        skippable
          ? `\n请输入 0 到 ${PRESETS.length} 的数字（默认 0 = 跳过）: `
          : `\n请输入 1 到 ${PRESETS.length} 的数字（默认 1）: `,
      );
      if (!pick) {
        idx = skippable ? SKIP_IDX : 0;
        break;
      }
      const n = Number(pick);
      if (Number.isInteger(n) && n >= (skippable ? 0 : 1) && n <= PRESETS.length) {
        idx = n === 0 ? SKIP_IDX : n - 1;
        break;
      }
      console.log(c.err(`无效输入，请输入 ${skippable ? 0 : 1} 到 ${PRESETS.length} 的数字`));
    }
  }
  const skipModel = skippable && idx === SKIP_IDX;

  let baseUrl = old.llmBaseUrl;
  let apiKey = old.llmApiKey;
  let model = old.llmModel;
  if (skipModel) {
    console.log(c.gray(`跳过模型配置，保留当前模型 ${model}`));
  } else {
    const preset = PRESETS[idx]!;
    console.log(c.gray(`已选择 ${preset.name}`));
    if (preset.baseUrl) {
      baseUrl = preset.baseUrl;
    } else {
      baseUrl = await need('Base URL（如 https://api.deepseek.com/v1）: ');
      baseUrl = await ensureSecureBaseUrl(baseUrl);
    }
    const apiKeyInput = await needSecret(`API Key${secretSuffix}: `);
    if (!apiKeyInput) throw new Error('API Key 不能为空');
    apiKey = apiKeyInput;
    const modelInput = await need(preset.model ? `模型名（默认 ${preset.model}）: ` : '模型名（必填，如 gpt-4o）: ');
    model = modelInput || preset.model;
    if (!model) throw new Error('模型名不能为空');

    // 联网预检模型配置：Key 无效在向导里暴露（可重输 API Key / Base URL / 模型名）；端点不支持预检/网络不通则提示后可仍保存。
    // 两个失败分支的默认动作统一为「直接重试」，保存必须显式输入 s——避免相邻问题同为回车却含义相反。
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
      const act = (await need('回车 = 直接重试；输入 k 改 API Key、b 改 Base URL、m 改模型名；输入 s = 仍然保存: ')).toLowerCase();
      if (act === 's' || act === 'save' || act === '保存') break;
      if (act === 'b' || act === 'base' || act === 'url') {
        baseUrl = await need(`Base URL（当前 ${baseUrl}）: `);
        if (!baseUrl) throw new Error('Base URL 不能为空');
        baseUrl = await ensureSecureBaseUrl(baseUrl);
      } else if (act === 'm' || act === 'model') {
        model = await need(`模型名（当前 ${model}）: `);
        if (!model) throw new Error('模型名不能为空');
      } else if (act === 'k' || act === 'key') {
        apiKey = await needSecret(`API Key${secretSuffix}: `);
        if (!apiKey) throw new Error('API Key 不能为空');
      }
      // 其余输入（含回车）= 不修改，用当前配置直接重试
    }
  }
  console.log(c.gray('以下为可选的看板默认值：项目/仓库 ID 可在看板 Web UI 的地址栏或详情页复制，不确定直接回车跳过。'));
  // 看板地址必须是完整 URL：缺 http(s):// 协议头直接重问
  let kanbanUrl = '';
  for (;;) {
    const raw = await need(`看板地址（回车 = 保留当前 ${old.kanbanUrl}）: `);
    if (!raw) {
      kanbanUrl = old.kanbanUrl;
      break;
    }
    if (/^https?:\/\//i.test(raw)) {
      kanbanUrl = raw;
      break;
    }
    console.log(c.err('看板地址需以 http:// 或 https:// 开头，请重新输入。'));
  }
  // 可选字段口径与白名单一致：有当前值时回车 = 保留当前值，输入 - = 清除；无当前值时回车 = 跳过
  const kanbanProjectIdRaw = await need(
    `默认项目 ID（可选${old.kanbanProjectId ? `，回车 = 保留当前 ${old.kanbanProjectId}，输入 - 清除` : '，直接回车跳过'}）: `,
  );
  const kanbanProjectId = kanbanProjectIdRaw === '-' ? '' : kanbanProjectIdRaw || old.kanbanProjectId;
  const kanbanRepoIdRaw = await need(
    `默认仓库 ID（可选${old.kanbanRepoId ? `，回车 = 保留当前 ${old.kanbanRepoId}，输入 - 清除` : '，直接回车跳过'}）: `,
  );
  const kanbanRepoId = kanbanRepoIdRaw === '-' ? '' : kanbanRepoIdRaw || old.kanbanRepoId;
  const kanbanIterationRaw = await need(
    `默认迭代（可选，与看板 Web UI 的迭代名一致，如 260717${old.kanbanIteration ? `；回车 = 保留当前 ${old.kanbanIteration}，输入 - 清除` : '；直接回车跳过'}）: `,
  );
  const kanbanIteration = kanbanIterationRaw === '-' ? '' : kanbanIterationRaw || old.kanbanIteration;

  /**
   * AI 审查（open-code-review）/ 失败诊断的独立模型配置（OCR_LLM_*，逐项优先、
   * 缺项回退上方机器人模型配置，语义见 ai-review.ts buildOcrEnv）。全部可回车跳过；
   * 与看板可选字段同一口径：有当前值时回车 = 保留、输入 - = 清除。
   * 专用 key 独立询问：「只隔离 key、不换模型」是安全提示（handler.ts 首次审查）首推的
   * 用法，不能要求先配模型；Base URL 只在配了模型或已有 URL 覆盖项时追问（换 provider
   * 才需要，已有残留 URL 覆盖项时也要给用户看到并清除的入口）。
   */
  console.log(
    c.gray('AI 审查（open-code-review）与失败诊断默认复用上方模型配置；想单独用别的模型跑审查、或给它隔离一个专用 key 时再填，可直接回车跳过。'),
  );
  // OCR_LLM_URL 存的是完整 chat 端点（…/chat/completions）；展示与输入都用 base URL 形态
  // （与上方主模型的 Base URL 口径一致），写入时再补全后缀（与 buildOcrEnv 派生口径相同）。
  const toBaseUrl = (u: string) => u.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '');
  const toOcrEndpoint = (u: string) =>
    /\/(chat\/completions|messages)\/?$/.test(u) ? u : `${u.replace(/\/+$/, '')}/chat/completions`;
  const ocrNow = ocrLlmOverrides();
  const ocr: OcrLlmOverrides = {};
  const ocrModelRaw = await need(
    `AI 审查模型（可选${ocrNow.model ? `，回车 = 保留当前 ${ocrNow.model}，输入 - 清除` : `，回车 = 与上方一致（${model}）`}）: `,
  );
  if (ocrModelRaw) ocr.model = ocrModelRaw === '-' ? '' : ocrModelRaw;
  let ocrModel = ocrModelRaw === '-' ? '' : ocrModelRaw || ocrNow.model;
  if (ocrModel || ocrNow.url) {
    const ocrUrlRaw = await need(
      `AI 审查 Base URL（可选${ocrNow.url ? `，回车 = 保留当前 ${toBaseUrl(ocrNow.url)}，输入 - 清除` : `，回车 = 复用 ${baseUrl}`}）: `,
    );
    if (ocrUrlRaw) {
      if (ocrUrlRaw === '-') ocr.url = '';
      else {
        const u = await ensureSecureBaseUrl(ocrUrlRaw, { label: 'AI 审查 Base URL', allowEmpty: true });
        if (u) ocr.url = toOcrEndpoint(u);
      }
    }
  }
  // secretSuffix 自带括号，融入可选说明括号内，避免两对括号连排
  const secretInner = secretSuffix.replace(/^[（(]|[）)]$/g, '');
  const ocrTokenRaw = await needSecret(
    `AI 审查专用 API Key（可选${ocrNow.token ? '，回车 = 保留当前已配置的 key，输入 - 清除' : '，回车 = 复用上方 API Key'}；${secretInner}）: `,
  );
  if (ocrTokenRaw) ocr.token = ocrTokenRaw === '-' ? '' : ocrTokenRaw;

  /**
   * OCR 配置联网预检：仅当覆盖项含显式 URL/key 时——端点与 key 全复用时主流程刚校验过，
   * 不重复打扰。交互与主模型校验循环同一口径：回车 = 重试，保存必须显式输入 s。
   */
  let effOcrUrl = ocr.url !== undefined ? ocr.url : ocrNow.url;
  let effOcrToken = ocr.token !== undefined ? ocr.token : ocrNow.token;
  if (ocrModel && (effOcrUrl || effOcrToken)) {
    for (;;) {
      console.log(c.gray('正在联网校验 AI 审查模型配置…'));
      const check = await verifyLlmConfig(effOcrUrl ? toBaseUrl(effOcrUrl) : baseUrl, effOcrToken || apiKey);
      if (check.ok) {
        console.log(c.ok('AI 审查模型配置校验通过'));
        break;
      }
      if (check.uncertain) {
        console.log(c.warn(`无法预检：${check.message}`));
      } else {
        console.log(c.err(`AI 审查模型配置校验失败：${check.message}`));
      }
      const act = (await need('回车 = 直接重试；输入 k 改专用 key、b 改 Base URL、m 改模型名；输入 s = 仍然保存: ')).toLowerCase();
      if (act === 's' || act === 'save' || act === '保存') break;
      if (act === 'b' || act === 'base' || act === 'url') {
        const raw = await need(`AI 审查 Base URL（当前 ${effOcrUrl ? toBaseUrl(effOcrUrl) : baseUrl}）: `);
        if (raw) {
          const u = await ensureSecureBaseUrl(raw, { label: 'AI 审查 Base URL', allowEmpty: true });
          if (u) ocr.url = toOcrEndpoint(u);
        }
      } else if (act === 'm' || act === 'model') {
        const m = await need(`AI 审查模型（当前 ${ocrModel}）: `);
        if (m) {
          ocr.model = m === '-' ? '' : m;
          ocrModel = m === '-' ? '' : m;
          if (!ocrModel) break; // 模型已清除，没有可预检的对象
        }
      } else if (act === 'k' || act === 'key') {
        const t = await needSecret(`AI 审查专用 API Key${secretSuffix}: `);
        if (t) ocr.token = t === '-' ? '' : t;
      }
      // 其余输入（含回车）= 不修改，用当前配置直接重试
      effOcrUrl = ocr.url !== undefined ? ocr.url : ocrNow.url;
      effOcrToken = ocr.token !== undefined ? ocr.token : ocrNow.token;
    }
  }

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
  const saved = writeEnv(cfg, undefined, ocr);
  // 显式配过（哪怕与主模型同名）或与主模型不同，都在确认里如实标注
  const ocrNote = ocrModel && (ocrModel !== model || ocr.model !== undefined) ? `；AI 审查模型：${ocrModel}` : '';
  console.log(c.ok(`\n配置已保存到 ${saved}（模型：${model}${ocrNote}）\n`));
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
  io: ReturnType<typeof makeNeed>,
  existing: FeishuBotConfig,
  { allowClear = false }: { allowClear?: boolean } = {},
): Promise<FeishuBotConfig> {
  const { need, needSecret, secretSuffix } = io;
  printFeishuSetupChecklist();
  console.log(c.strong('配置飞书机器人凭证：\n'));
  let appId = '';
  let appSecret = '';
  // 联网校验凭证：无效凭证/未启用机器人在此暴露，而不是等长连接失败
  // 失败后回车 = 用当前凭证直接重试（网络抖动场景）；输入 r 才重新输入凭证
  let reenter = true;
  for (;;) {
    if (reenter) {
      appId = await need('FEISHU_APP_ID（cli_...）: ');
      if (!appId) throw new Error('App ID 不能为空');
      appSecret = await needSecret(`FEISHU_APP_SECRET${secretSuffix}: `);
      if (!appSecret) throw new Error('App Secret 不能为空');
    }
    console.log(c.gray('正在联网校验凭证…'));
    const check = await verifyFeishuApp(appId, appSecret);
    if (check.ok) {
      console.log(c.ok(`凭证校验通过${check.botName ? `：机器人「${check.botName}」` : ''}`));
      break;
    }
    console.log(c.err(`凭证校验失败：${check.message}`));
    // 与模型校验分支统一交互：回车 = 重试；保存必须显式输入 s
    const act = (await need('回车 = 直接重试；输入 r = 重新输入凭证；输入 s = 仍然保存: ')).toLowerCase();
    if (act === 's' || act === 'save' || act === '保存') break;
    reenter = act === 'r';
  }
  const allowedPrompt = existing.allowedOpenIds.length
    ? `允许的 open_id（可选，逗号分隔，可在飞书开放平台 API 调试台查询；回车 = 保留当前 ${existing.allowedOpenIds.join('、')}${allowClear ? '；输入 - 清除' : ''}）: `
    : `允许的 open_id（可选，逗号分隔，open_id 可在飞书开放平台 API 调试台查询；回车 = 暂不设置——则第一个私聊机器人的人自动成为唯一使用者。机器人可被他人搜到时，建议先填自己的 open_id${allowClear ? '' : '；也可先回车，认领后先停止当前机器人进程，再运行 helios-task-agent bot --rebind 回填（--rebind 会启动完整 bot 实例，与在跑实例冲突）'}）: `;
  const allowedRaw = await need(allowedPrompt);
  const allowedOpenIds = resolveAllowedOpenIds(allowedRaw, existing.allowedOpenIds, allowClear);
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
  const existing = feishuBotConfig();
  if (existing.appId) {
    console.log(c.gray(`当前绑定 App ID：${existing.appId}，输入新机器人的凭证即完成换绑。`));
  }
  const feishu = await promptFeishuConfig(makeNeed(ask, askSecret), existing, { allowClear: true });
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
  let agent = currentConfig();
  if (force || !isConfigured()) {
    agent = await ensureConfig(ask, { force: true, choose, askSecret });
  }

  let feishu = feishuBotConfig();
  if (force || !isFeishuBotConfigured()) {
    feishu = await promptFeishuConfig(makeNeed(ask, askSecret), feishu);
    const envPath = writeEnv(agent, feishu);
    console.log(c.ok(`\n飞书配置已保存到 ${envPath}\n`));
    if (!checkLarkCli()) console.log(c.warn(`未检测到 lark-cli。${LARK_CLI_INSTALL_HINT}\n`));
    return { agent: currentConfig(), feishu: feishuBotConfig(), envPath };
  }

  return { agent, feishu, envPath: resolveEnvWritePath() };
}
