import { execFile, execFileSync } from 'child_process';

/**
 * 同步探测助手：同一 try/catch execFileSync 模板的一处收口，公开探针均为一行包装。
 *
 * 为什么同步/异步双形态都要保留（唯二形态的唯一解释在此）：
 * 启动早期路径（cli/bot main 开头、配置向导、横幅渲染）处于无法 await 的同步上下文，
 * 只能用 execFileSync；而事件循环内路径（/status、bot 消息回调）若串行同步探测，
 * 最坏阻塞事件循环十几秒，飞书回调/心跳全被卡住——故另有 probeAsync 一系。
 * 两形态探测同一组命令、同一超时，语义必须保持一致。
 */
function probeSync(cmd: string, args: string[], timeoutMs = 5000): string | null {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, encoding: 'utf8' });
  } catch {
    return null;
  }
}

/** Shared dependency probe: is lark-cli installed and runnable? */
export function checkLarkCli(): boolean {
  return probeSync('lark-cli', ['--version']) !== null;
}

/** 异步探测助手（事件循环内路径用；为何需要同步/异步双形态见上方 probeSync 注释）。 */
function probeAsync(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? ''));
    });
  });
}

export async function checkLarkCliAsync(): Promise<boolean> {
  return (await probeAsync('lark-cli', ['--version'])) !== null;
}

/**
 * 解析 `lark-cli auth status` 输出：任一身份 available=true 即视为已授权；
 * 输出解析失败按未授权处理（保守不误报可用）。同步/异步探测共用此解析。
 */
function parseLarkCliAuth(out: string): 'unauthorized' | 'ok' {
  try {
    const parsed = JSON.parse(out) as { identities?: Record<string, { available?: boolean }> };
    const identities = Object.values(parsed?.identities ?? {});
    return identities.some((i) => i?.available === true) ? 'ok' : 'unauthorized';
  } catch {
    return 'unauthorized';
  }
}

/** probeLarkCliAuth 的异步版。 */
export async function probeLarkCliAuthAsync(): Promise<'unauthorized' | 'ok'> {
  const out = await probeAsync('lark-cli', ['auth', 'status'], 3000);
  if (out === null) return 'unauthorized';
  return parseLarkCliAuth(out);
}

/** checkOcrCli 的异步版。 */
export async function checkOcrCliAsync(): Promise<boolean> {
  return (await probeAsync('ocr', ['version'])) !== null;
}

/** checkHkDeps 的异步版（jq/curl 并发探测）。 */
export async function checkHkDepsAsync(): Promise<string[]> {
  const [jq, curl] = await Promise.all([probeAsync('jq', ['--version']), probeAsync('curl', ['--version'])]);
  const missing: string[] = [];
  if (jq === null) missing.push('jq');
  if (curl === null) missing.push('curl');
  return missing;
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
 * 启动早期同步上下文使用（无法 await）；事件循环内路径请用 probeLarkCliAuthAsync。
 */
export function probeLarkCliAuth(): 'unauthorized' | 'ok' {
  const out = probeSync('lark-cli', ['auth', 'status'], 3000);
  if (out === null) return 'unauthorized';
  return parseLarkCliAuth(out);
}

/** lark-cli 三态探测：先查二进制（checkLarkCli），存在再查授权。 */
export function checkLarkCliStatus(): LarkCliStatus {
  if (!checkLarkCli()) return 'missing';
  return probeLarkCliAuth();
}

/** ocr（open-code-review）是否可用：PATH 上的 `ocr`；缺失时 AI 审查会自动走 npx 拉取。 */
export function checkOcrCli(): boolean {
  return probeSync('ocr', ['version']) !== null;
}

/** ocr 缺失时的提示文案：首行说明影响与自动兜底，安装命令单独一行（provider 细节见 README，不在此复述）。 */
export const OCR_INSTALL_HINT = [
  '未检测到代码审查工具 open-code-review（命令名 ocr），点击「AI 审查」时会自动下载（首次较慢）。',
  '安装：npm i -g @alibaba-group/open-code-review',
].join('\n');

/** jq 是否可用：hk_cli 降级链（hk.sh）解析 API 响应所必需，缺失时 hk.sh 直接退出。 */
export function checkJq(): boolean {
  return probeSync('jq', ['--version']) !== null;
}

/** curl 是否可用：hk_cli 降级链（hk.sh）发起 HTTP 请求所必需。 */
export function checkCurl(): boolean {
  return probeSync('curl', ['--version']) !== null;
}

/** hk_cli 降级链依赖探测：返回缺失的工具名（空数组 = 降级链可用）。 */
export function checkHkDeps(): string[] {
  const missing: string[] = [];
  if (!checkJq()) missing.push('jq');
  if (!checkCurl()) missing.push('curl');
  return missing;
}

/** hk_cli 依赖缺失时的安装提示（macOS brew / Linux 包管理器）。 */
export const HK_CLI_INSTALL_HINT = 'macOS：brew install jq curl；Linux：用包管理器安装 jq curl';

/** MCP 不可用时的统一降级口径（banner / CLI / bot / 诊断提示共用，单源在此，改动只动一处）。 */
export const MCP_FALLBACK_TEXT = '已自动切换为 hk_cli（看板 HTTP 接口）';

/**
 * 运行时 npx 拉取的 helios-kanban 包规格，钉版本（同下方 OCR 包）：
 * 默认跟随 @latest 会让「自动启动看板」变成每次拉取并执行未审核的新版本，
 * 供应链风险过大。当前值来自 2026-08-06 `npm view helios-kanban version` = 0.1.39，
 * 升级时手动跟进；HELIOS_KANBAN_PACKAGE 仍可覆盖（如 helios-kanban@0.1.36）。
 */
export const DEFAULT_KANBAN_PACKAGE = 'helios-kanban@0.1.39';

export function kanbanPackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELIOS_KANBAN_PACKAGE || DEFAULT_KANBAN_PACKAGE;
}

/**
 * 看板自动启动失败时的手动拉起提示（CLI 与 bot 共用）。
 * 不带 HOST=0.0.0.0：看板 Web/API 无鉴权，只需绑定回环。
 * port 缺省 7964；autoStart === false 时省略「设置 HELIOS_KANBAN_AUTO_START=0」一行（用户已关闭自动启动，不复读）。
 */
export function kanbanManualStartHint(opts?: { port?: string | number; autoStart?: boolean }): string {
  const lines = [
    `可手动执行：PORT=${opts?.port ?? 7964} npx -y ${kanbanPackageSpec()}（多数情况是首次下载慢，重新运行即可）`,
  ];
  if (opts?.autoStart !== false) {
    lines.push('或设置 HELIOS_KANBAN_AUTO_START=0 并自行保证服务已运行。');
  }
  return lines.join('\n');
}

/** ocr（open-code-review）npx 包规格，同理钉版本；OCR_PACKAGE 可覆盖。 */
const DEFAULT_OCR_PACKAGE = '@alibaba-group/open-code-review@1.8.0';

export function ocrPackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCR_PACKAGE || DEFAULT_OCR_PACKAGE;
}
