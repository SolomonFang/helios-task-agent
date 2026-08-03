/**
 * 子进程最小环境构造：默认不向子进程继承 process.env（其中含 LLM_API_KEY、
 * FEISHU_APP_SECRET 等敏感变量），只放行运行必需项，外加调用方显式声明的变量。
 *
 * 放行清单的取舍：
 * - PATH/HOME/TMPDIR/USER/SHELL 等：可执行文件定位与各类 CLI 读自身配置（lark-cli、
 *   npm/npx 缓存与 .npmrc 都在 HOME 下）所必需；
 * - LANG/LC_*：本地化输出（中文文案、排序）；
 * - HTTP(S)_PROXY/NO_PROXY、NPM_CONFIG_REGISTRY：npx/npm 拉包所需的网络配置
 *   （镜像地址与代理，均非凭证；npm_config_* 不整体放行，避免泄露 _authToken 类键）；
 * - 其余一律不带，调用方按需显式追加（如 hk.sh 的 HELIOS_KANBAN_*、ocr 的 OCR_LLM_*）。
 */

/** 原样放行（存在才带）的运行必需变量。 */
const PASS_THROUGH_VARS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'NPM_CONFIG_REGISTRY',
  'npm_config_registry',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** 组装子进程环境：base 中的放行清单 + extra（后者覆盖前者）。 */
export function minimalChildEnv(
  extra: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (PASS_THROUGH_VARS.includes(key) || key.startsWith('LC_')) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}
