/**
 * 进程生命周期公共件（cli.ts 与 bot-main.ts 共用）：
 * - createGracefulExit：幂等优雅退出 + 8s 强退兜底
 * - installCrashGuards：unhandledRejection / uncaughtException 兜底 + HTA_TEST_CRASH 测试钩子
 * - handleWizardCancel：向导「已取消」中性口径（灰字提示，不打红）
 * - maybePromptUpdate：npm 更新请示流程
 */

import { c } from './ui';
import { errMessage } from './err';
import { promptVersionUpdate, type UpdateInfo, type UpdateOutcome } from './update-check';
import type { AskFn } from '../types';

export interface GracefulExitOptions {
  /**
   * 退出清理（外层已保证只执行一次；内部尽力清理，任何一步失败都继续退出）。
   * exitCode 由触发路径决定：正常信号（SIGINT/SIGTERM）传 0；uncaughtException 传 1——
   * 崩溃被 launchd/systemd 当成干净停止（退出码 0）时不会触发自动重启。
   */
  cleanup: () => Promise<void>;
  /** 进入退出流程时调用（如打印「正在退出…」）。 */
  onStart?: () => void;
}

/**
 * 幂等优雅退出：二次 Ctrl+C / SIGINT+SIGTERM 不重入；
 * cleanup 挂住时 8s 强制退出（unref：该定时器自身不得阻止正常退出），
 * 强退恒为 1——挂住本身是异常状态，干净停止（0）不该出现在超时路径。
 */
export function createGracefulExit(opts: GracefulExitOptions): (exitCode?: number) => Promise<void> {
  let shuttingDown = false;
  return async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => {
      console.error(c.err('退出清理超时，强制结束进程'));
      process.exit(1);
    }, 8000);
    forceTimer.unref();
    opts.onStart?.();
    try {
      await opts.cleanup();
    } catch {
      /* 尽力清理，失败照常退出 */
    }
    clearTimeout(forceTimer);
    process.exit(exitCode);
  };
}

/**
 * 长驻进程兜底（CLI 与 bot 同策略）：漏网 rejection 只记日志不退出（保持进程可用）；
 * uncaughtException 说明状态已不可信，记日志后走优雅退出（退出码 1，见 createGracefulExit）。
 * handler 自身只做同步日志，不得再抛异常（否则绕过清理直接 crash）。
 *
 * HTA_TEST_CRASH=1 是测试钩子：让子进程测试能真实触发 uncaughtException 路径，
 * 验证崩溃退出码为 1（setImmediate 抛出才走 uncaughtException，同步 throw 只会 reject main）。
 */
export function installCrashGuards(shutdown: (exitCode?: number) => Promise<void>, opts: { tag?: string } = {}): void {
  const tag = opts.tag ? `${opts.tag} ` : '';
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(c.err(`${tag}未处理的 Promise rejection（进程保持运行）：${msg}`));
  });
  process.on('uncaughtException', (err) => {
    console.error(c.err(`${tag}未捕获异常，执行优雅退出：${err.stack || err.message}`));
    void shutdown(1);
  });
  if (process.env.HTA_TEST_CRASH) setImmediate(() => { throw new Error('HTA_TEST_CRASH'); });
}

/**
 * 向导内 Esc/Ctrl+C 取消（reject '已取消'）是中性操作：灰字提示并返回 true，不打成红色「配置失败」；
 * 退出码与收尾（关 readline / 是否退出进程）由调用方决定（CLI /config 不退出进程，启动向导以 0 退出）。
 */
export function handleWizardCancel(err: unknown): boolean {
  if (errMessage(err) !== '已取消') return false;
  console.log(c.gray('已取消，配置未变更'));
  return true;
}

/**
 * npm 更新请示：返回 'updated' 时调用方应提示重启并退出（当前进程仍是旧代码，全局 bin 下次运行才生效）。
 * 传 log：跳过/失败时给用户可见反馈（不传则静默跳过，分不清是没识别还是已跳过）。
 */
export async function maybePromptUpdate(info: UpdateInfo, ask: AskFn): Promise<UpdateOutcome> {
  return promptVersionUpdate({ info, ask, log: (m) => console.log(c.gray(m)) });
}
