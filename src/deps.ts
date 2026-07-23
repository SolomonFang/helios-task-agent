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
