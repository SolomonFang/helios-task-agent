import os from 'os';
import path from 'path';

/**
 * 数据目录与包根的路径工具。独立成模块：此前 defaultDataHome 放在 memory.ts，
 * 导致 audit/report/config 等无关模块仅为拿路径而 import 整个 memory。
 */

/** 用户数据目录（HELIOS_TASK_AGENT_HOME 可覆盖，默认 ~/.helios-task-agent）。 */
export function defaultDataHome(): string {
  return process.env.HELIOS_TASK_AGENT_HOME || path.join(os.homedir(), '.helios-task-agent');
}

/**
 * 包根目录（package.json 所在目录）。
 * CJS 假设：本文件编译后在 dist/infra/ 下（tsx 直接跑时在 src/infra/ 下），__dirname 上两级即包根；
 * 若将来转 ESM，__dirname 不存在，此处是唯一需要改的点（import.meta.url 换算）。
 */
export const packageRoot = path.join(__dirname, '..', '..');

/** 包内内置技能目录（兜底；npm 全局安装目录，用户不应往里放自定义技能）。 */
export const SKILLS_DIR = path.join(packageRoot, 'skills');
