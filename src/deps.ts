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

/**
 * 运行时 npx 拉取的 helios-kanban 包规格。默认跟随最新版（@latest），
 * 需要钉版本时可用 HELIOS_KANBAN_PACKAGE 覆盖（如 helios-kanban@0.1.36）。
 */
export const DEFAULT_KANBAN_PACKAGE = 'helios-kanban@latest';

export function kanbanPackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELIOS_KANBAN_PACKAGE || DEFAULT_KANBAN_PACKAGE;
}

/** ocr（open-code-review）npx 包规格，同理钉版本；OCR_PACKAGE 可覆盖。 */
export const DEFAULT_OCR_PACKAGE = '@alibaba-group/open-code-review@1.8.0';

export function ocrPackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCR_PACKAGE || DEFAULT_OCR_PACKAGE;
}
