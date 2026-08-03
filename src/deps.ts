import { execFileSync } from 'child_process';

/** Shared dependency probe: is lark-cli installed and runnable? */
export function checkLarkCli(): boolean {
  try {
    execFileSync('lark-cli', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** lark-cli 缺失时的引导文案（安装 + 授权；不装则飞书读取不可用，看板功能不受影响）。 */
export const LARK_CLI_INSTALL_HINT =
  '安装：npm i -g @larksuite/cli，然后 lark-cli auth login 完成授权（不装则飞书任务/文档读取不可用，看板功能不受影响）。';

/** lark-cli 已安装但未授权时的引导文案。 */
export const LARK_CLI_AUTH_HINT = '已安装但未授权：运行 lark-cli auth login 完成授权后重试。';

/** lark-cli 三态：未安装 / 已安装但未授权 / 已授权可用。 */
export type LarkCliStatus = 'missing' | 'unauthorized' | 'ok';

/**
 * 授权探测（假定二进制已存在）：`lark-cli auth status` 读本地配置（不走网络），
 * 任一身份 available=true 即视为已授权；命令失败或输出异常按未授权处理（保守不误报可用）。
 */
export function probeLarkCliAuth(): 'unauthorized' | 'ok' {
  try {
    const out = execFileSync('lark-cli', ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out) as { identities?: Record<string, { available?: boolean }> };
    const identities = Object.values(parsed?.identities ?? {});
    return identities.some((i) => i?.available === true) ? 'ok' : 'unauthorized';
  } catch {
    return 'unauthorized';
  }
}

/** lark-cli 三态探测：先查二进制（checkLarkCli），存在再查授权。 */
export function checkLarkCliStatus(): LarkCliStatus {
  if (!checkLarkCli()) return 'missing';
  return probeLarkCliAuth();
}

/** ocr（open-code-review）是否可用：PATH 上的 `ocr`；缺失时 AI 审查会自动走 npx 拉取。 */
export function checkOcrCli(): boolean {
  try {
    execFileSync('ocr', ['version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** ocr 缺失时的提示文案（AI 审查仍可走 npx 兜底，仅首次较慢）。 */
export const OCR_INSTALL_HINT =
  '安装：npm i -g @alibaba-group/open-code-review；未安装时点击「AI 审查」会自动 npx 拉取（首次较慢）。LLM 默认复用机器人模型配置，也可用 ocr config provider 单独配置。';

/** jq 是否可用：hk_cli 降级链（hk.sh）解析 API 响应所必需，缺失时 hk.sh 直接退出。 */
export function checkJq(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** curl 是否可用：hk_cli 降级链（hk.sh）发起 HTTP 请求所必需。 */
export function checkCurl(): boolean {
  try {
    execFileSync('curl', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** hk_cli 降级链依赖探测：返回缺失的工具名（空数组 = 降级链可用）。 */
export function checkHkDeps(): string[] {
  const missing: string[] = [];
  if (!checkJq()) missing.push('jq');
  if (!checkCurl()) missing.push('curl');
  return missing;
}

/** hk_cli 依赖缺失时的安装提示（macOS brew / Linux 包管理器）。 */
export const HK_CLI_INSTALL_HINT = 'macOS: brew install jq curl；Linux: 用包管理器安装 jq curl';

/**
 * 运行时 npx 拉取的 helios-kanban 包规格。默认跟随最新版（@latest），
 * 需要钉版本时可用 HELIOS_KANBAN_PACKAGE 覆盖（如 helios-kanban@0.1.36）。
 */
export const DEFAULT_KANBAN_PACKAGE = 'helios-kanban@latest';

export function kanbanPackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELIOS_KANBAN_PACKAGE || DEFAULT_KANBAN_PACKAGE;
}

/**
 * 看板自动启动失败时的手动拉起提示（CLI 与 bot 共用）。
 * 不带 HOST=0.0.0.0：看板 Web/API 无鉴权，只需绑定回环。
 */
export function kanbanManualStartHint(): string {
  return [
    `可手动执行: PORT=7964 npx -y ${kanbanPackageSpec()}（多数情况是首次下载慢，重新运行即可）`,
    '或设置 HELIOS_KANBAN_AUTO_START=0 并自行保证服务已运行。',
  ].join('\n');
}

/** ocr（open-code-review）npx 包规格，同理钉版本；OCR_PACKAGE 可覆盖。 */
export const DEFAULT_OCR_PACKAGE = '@alibaba-group/open-code-review@1.8.0';

export function ocrPackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCR_PACKAGE || DEFAULT_OCR_PACKAGE;
}
