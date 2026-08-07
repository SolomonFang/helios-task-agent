/**
 * CLI 与 bot 共用的启动序列：依赖告警 / 技能迁移与校验 / 看板拉起。
 * 两侧差异（banner 内嵌状态 vs 完整告警文案、OCR 仅 bot 需要、失败收尾动作）以选项表达。
 */

import type { ChildProcess } from 'child_process';
import {
  checkOcrCli,
  kanbanManualStartHint,
  LARK_CLI_INSTALL_HINT,
  LARK_CLI_AUTH_HINT,
  OCR_INSTALL_HINT,
  type LarkCliStatus,
} from './infra/deps';
import { ensureKanbanRunning, type KanbanEnsureResult } from './kanban/kanban-ensure';
import { migratePackageSkills, validateSkills } from './agent/skills';
import { c } from './ui';
import { errMessage } from './infra/err';

export interface StartupDepsWarnOptions {
  /**
   * 'cli'：banner 状态行已含未授权/未找到说明，这里只补 banner 放不下的安装命令；
   * 'bot'：无 banner，需完整告警文案（含未授权指引）。
   */
  style: 'cli' | 'bot';
  /** OCR（open-code-review）检查：仅 bot 的 AI 审查功能依赖，cli 不检查。 */
  checkOcr?: boolean;
}

/** lark-cli（及可选 OCR）启动告警；larkStatus 由调用方探测（banner//status 还要用）。 */
export function warnStartupDeps(larkStatus: LarkCliStatus, opts: StartupDepsWarnOptions): void {
  if (opts.style === 'bot') {
    if (larkStatus === 'missing') {
      console.log(c.warn(`未检测到 lark-cli。${LARK_CLI_INSTALL_HINT}`));
    } else if (larkStatus === 'unauthorized') {
      console.log(c.warn(`lark-cli 已安装但未授权。${LARK_CLI_AUTH_HINT}`));
    }
  } else if (larkStatus === 'missing') {
    console.log(c.warn(LARK_CLI_INSTALL_HINT));
  }
  if (opts.checkOcr && !checkOcrCli()) {
    console.log(c.warn(`未检测到代码审查工具 open-code-review（AI 审查功能）。${OCR_INSTALL_HINT}`));
  }
}

/** 历史误放进 npm 包内 skills/ 的技能升级即丢失：启动时先迁到数据目录持久保存，再校验最终生效的技能集。 */
export function migrateAndValidateSkills(): void {
  for (const name of migratePackageSkills()) {
    console.log(c.info(`已将技能「${name}」从包内目录迁移到数据目录（以后升级不再丢失）`));
  }
  // 技能契约问题启动即告警：用户自建技能写错 frontmatter 时会静默降级，不放行到对话期才暴露
  for (const problem of validateSkills()) console.log(c.warn(`技能契约: ${problem}`));
}

export interface KanbanBootOptions {
  kanbanUrl: string;
  onLog: (msg: string) => void;
  /** 就绪等待期间（最长 90s）收到退出信号时，调用方需要拿到 child 才能清理（bot 的 cleanup 登记）。 */
  onSpawn?: (child: ChildProcess) => void;
  /** 失败退出前的调用方收尾（如 cli 停 spinner / 关闭 readline），在错误打印之前调用。 */
  onFail?: () => void;
  /** 失败文案前缀（cli「看板不可用」/ bot「看板启动失败」）。 */
  failLabel: string;
}

/** 拉起/复用看板进程；失败时收尾、打印错误与手动启动指引后退出进程（不返回）。 */
export async function ensureKanbanOrExit(opts: KanbanBootOptions): Promise<KanbanEnsureResult> {
  try {
    return await ensureKanbanRunning(opts.kanbanUrl, { onLog: opts.onLog, onSpawn: opts.onSpawn });
  } catch (err) {
    const message = errMessage(err);
    opts.onFail?.();
    console.error(c.err(`${opts.failLabel}: ${message}`));
    console.error(c.gray(kanbanManualStartHint()));
    process.exit(1);
  }
}
