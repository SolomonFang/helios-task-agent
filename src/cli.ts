import readline from 'readline';
import { type ChildProcess } from 'child_process';
import { c, printBanner, Spinner, renderReply } from './infra/ui';
import { ensureEnvLoaded } from './config/config';
import { ensureConfig } from './config/config-wizard';
import { AgentSession } from './agent/session';
import { ReminderRunner, ReminderStore } from './agent/reminder';
import { SessionHistoryStore } from './agent/session-store';
import { connectMcp } from './kanban/mcp';
import type { KanbanMcp } from './kanban/mcp';
import { checkLarkCliStatus, MCP_FALLBACK_TEXT } from './infra/deps';
import { ensureKanbanOrExit, FatalStartupError, migrateAndValidateSkills, warnStartupDeps, type KanbanEnsureResult } from './bootstrap';
import { wizardAskSecret, wizardChoose } from './config/wizard-io';
import { checkForUpdate, readPkgVersion, updateCheckDisabled } from './infra/update-check';
import { createGracefulExit, handleWizardCancel, installCrashGuards, maybePromptUpdate } from './infra/process-lifecycle';
import {
  buildMemoryLines,
  buildStatusLines,
  buildToolsLines,
  clearedText,
  confirmRevokedText,
  confirmStateText,
  handleSkillsCommand,
  llmFailureParts,
  toolActionLabel,
  TRY_EXAMPLES,
} from './commands';
import { CONFIRM_BATCH_RE, CONFIRM_NO_RE, CONFIRM_YES_RE } from './agent/confirm';
import { batchAckText, batchScopeWord, kindLabel, markTimedOut, type ConfirmFn, type ConfirmRequest } from './agent/guard';
import type { AgentConfig, AskFn } from './types';
import { errMessage } from './infra/err';
import { processTreeAlive } from './infra/proc';
import { stripAnsi } from './infra/ansi';

type LineReader = (() => Promise<string | null>) & { drain: () => void; cancelPending: () => void };

function createLineReader(rl: readline.Interface): LineReader {
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  /**
   * 取消挂起的 waiter（以 null resolve）：askWithAbort 因 Ctrl+C/超时提前返回后，
   * 陈旧 waiter 若继续挂着，会把主循环下一次 ask('› ') 之前用户敲入的一行静默吞掉。
   */
  const cancelPending = () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  };
  rl.on('line', (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    cancelPending();
  });
  const nextLine = (() =>
    new Promise<string | null>((resolve) => {
      if (queue.length) return resolve(queue.shift()!);
      if (closed) return resolve(null);
      waiter = resolve;
    })) as LineReader;
  nextLine.drain = () => {
    queue.length = 0;
  };
  nextLine.cancelPending = cancelPending;
  return nextLine;
}

const HELP = `
  ${c.strong('命令')}
  ${c.info('/help')}     显示帮助
  ${c.info('/config')}   重新配置模型 / 看板地址
  ${c.info('/tools')}    列出当前可用工具（看板 + 本地）
  ${c.info('/skills')}   列出技能；install <技能目录路径> 安装（升级不丢失）；uninstall <技能名> 卸载
  ${c.info('/memory')}   查看持久化记忆（飞书任务源等）
  ${c.info('/status')}   查看状态（模型 / 看板 / 看板连接 / lark-cli / 备用通道）
  ${c.info('/clear')}    清空对话历史（不清记忆）
  ${c.info('/confirm')}  查看免问授权状态；/confirm revoke 撤销免问、恢复逐次确认
  ${c.info('/exit')}     退出（/quit 同效；任务运行中按 Ctrl+C 只中断不退出）

  ${c.strong('试试对我说')}
${TRY_EXAMPLES.map((e) => `  · ${e}`).join('\n')}
`;

/** askWithAbort 的超时哨兵：与「用户留空 / Ctrl+C」区分，便于打印自动拒绝文案。 */
export const ASK_TIMEOUT: unique symbol = Symbol('ask-timeout');

/**
 * ask 的 abort/超时感知版（纯逻辑抽出以便单测；main 内用 createAskWithAbort(ask, () => currentCtl, …) 构造）：
 * 闸门询问期间按 Ctrl+C = 拒绝该写操作（随后整个任务被中断）；
 * 超时未操作按拒绝处理（对齐飞书 bot：普通写 120s / 破坏性 300s）。
 * getCtl 返回当前运行轮次的 AbortController（无轮次时为 null）。
 * extraSignal：调用方附加的轮次级信号（llm 墙钟看门狗合并信号），abort 同样按非回答路径收尾——
 * 墙钟到点时确认不得继续挂到确认超时（ConfirmFn 契约，见 guard.ts）。
 * cancelPending：abort/超时等非回答路径收尾时调用，取消底层挂起的行读 waiter，
 * 否则陈旧 waiter 会吞掉主循环下一次 ask 之前用户敲入的一行。
 */
export function createAskWithAbort(
  ask: AskFn,
  getCtl: () => AbortController | null,
  cancelPending?: () => void,
): (promptText: string, timeoutMs?: number, extraSignal?: AbortSignal) => Promise<string | null | typeof ASK_TIMEOUT> {
  return (promptText, timeoutMs, extraSignal) => {
    const ctl = getCtl();
    if (!ctl && !timeoutMs && !extraSignal) return ask(promptText);
    if (ctl?.signal.aborted || extraSignal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => finish(null, true);
      // stale=true 表示非回答路径（abort/超时）：底层 ask 的 waiter 还挂着，先取消再收尾
      //（waiter 以 null 被 resolve 后触发的 finish 因 settled 短路，不会覆盖本次结果）
      const finish = (v: string | null | typeof ASK_TIMEOUT, stale = false) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ctl?.signal.removeEventListener('abort', onAbort);
        extraSignal?.removeEventListener('abort', onAbort);
        if (stale) cancelPending?.();
        resolve(v);
      };
      ctl?.signal.addEventListener('abort', onAbort, { once: true });
      extraSignal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs) {
        timer = setTimeout(() => finish(ASK_TIMEOUT, true), timeoutMs);
        timer.unref();
      }
      void ask(promptText).then((v) => finish(v));
    });
  };
}

/**
 * CLI 写操作确认闸门（main 内 confirmWrite 的实现，抽出以便单测）：
 * 闸门触发时暂停 spinner；默认拒绝；「免问」开同类免问；Ctrl+C 视为拒绝；
 * 超时自动拒绝（与飞书 bot 同语义：普通写 120s、破坏性 300s）。
 * 两个与 bot 对齐的口径：
 * - 超时先 markTimedOut 再收尾 false：passGate 据此归因 timeout（TIMEOUT_MESSAGE），
 *   模型不会把超时误转告成「用户拒绝了该写操作」；
 * - 重问不重置超时窗口：按首次发问的绝对截止时间传剩余时间（bot 是绝对超时）。
 * summary/detail 含看板可控内容（任务标题等），打印前剥离 ANSI 转义序列。
 * print/now 可注入（默认 console.log / Date.now），供单测替代。
 */
export function createCliConfirm(
  askWithAbort: (promptText: string, timeoutMs?: number, extraSignal?: AbortSignal) => Promise<string | null | typeof ASK_TIMEOUT>,
  spinner: { start(text?: string): unknown; stop(): unknown },
  print: (line: string) => void = (l) => console.log(l),
  now: () => number = Date.now,
): ConfirmFn {
  return async (req: ConfirmRequest, signal?: AbortSignal) => {
    spinner.stop();
    print('');
    print(c.warn(`⚠️ 写操作请求（${kindLabel(req.kind)}${req.destructive ? ' · 高危' : ''}）：${stripAnsi(req.summary)}`));
    print(c.gray(stripAnsi(req.detail)));
    const timeoutMs = req.destructive ? 300000 : 120000;
    const options = req.batchKey
      ? `y=仅此次 / 免问=${batchScopeWord(req.batchScope)}免问（本会话） / N=取消 / 回车=取消`
      : 'y=仅此次 / N=取消 / 回车=取消';
    const deadline = now() + timeoutMs;
    const timeoutFinish = (): false => {
      // 必须先于收尾 false 标记：passGate 在拿到拒绝后才查归因集合（同 bot confirm.ts 的顺序约束）
      markTimedOut(req);
      print(c.gray('⏰ 超时未操作，已自动拒绝，操作未执行。如仍需执行，再说一次即可。'));
      return false;
    };
    for (;;) {
      // 轮次已中断（/stop/墙钟）则不再发问：闸门按拒绝收尾，不等确认超时（ConfirmFn 契约）
      if (signal?.aborted) return false;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        // 窗口耗尽也要重启 spinner：闸门返回后轮次可能还在继续跑，不能全程静默（与下方回答后同口径）
        spinner.start('思考中…（Ctrl+C 中断）');
        return timeoutFinish();
      }
      const ans = await askWithAbort(
        c.warn(`允许执行？【${options}】（${Math.round(remainingMs / 1000)} 秒未操作自动拒绝） `),
        remainingMs,
        signal,
      );
      spinner.start('思考中…（Ctrl+C 中断）');
      if (ans === ASK_TIMEOUT) return timeoutFinish();
      // 轮次信号中断（Ctrl+C / 墙钟到点）时 askWithAbort 回落 null：与空回车同按取消收尾
      const t = (ans || '').trim().toLowerCase();
      // 无 batchKey 的操作不支持同类免问：提示后重新等待输入，而不是落到「已取消」（行为与意图相反）
      if (!req.batchKey && CONFIRM_BATCH_RE.test(t)) {
        // 重问期间先停 spinner：否则转圈每 80ms 清行，把这条提示与用户输入一起擦除（且「思考中」失实，实际在等用户）
        spinner.stop();
        print(c.warn('该操作不支持同类免问，请回复 y 确认或 N 取消。'));
        continue;
      }
      const batch = Boolean(req.batchKey) && CONFIRM_BATCH_RE.test(t);
      const once = !batch && CONFIRM_YES_RE.test(t);
      if (batch) {
        print(c.ok(`已批准；${batchAckText(req.batchScope, req.kind)}（/confirm revoke 撤销）。`));
        return 'batch';
      }
      if (once) {
        print(c.ok('已批准（仅此次），继续执行。'));
        return 'once';
      }
      // 非空但未命中任何词表（「好的/ok/可以」等随口应答）不是取消意图：提示后重问；空回车与取消词才取消
      if (t && !CONFIRM_NO_RE.test(t)) {
        spinner.stop();
        print(c.warn('无法识别的回答，请回复 y 确认或 N 取消。'));
        continue;
      }
      print(c.gray('已取消，操作未执行。'));
      return false;
    }
  };
}

export async function main(): Promise<void> {
  // env 显式初始化（import config 不再自动加载 .env，见 config.ts ensureEnvLoaded）
  ensureEnvLoaded();
  const isTTY = process.stdin.isTTY === true;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });
  const nextLine = createLineReader(rl);
  const ask: AskFn = (promptText) => {
    process.stdout.write(promptText);
    return nextLine();
  };
  // 向导交互原语与 bot 共用（wizard-io）；行读模式需在交互后 drain 缓冲
  const choose = wizardChoose(rl, () => nextLine.drain());
  /** 密钥掩码输入（仅 TTY；非 TTY 回退普通输入，向导内自动处理） */
  const askSecret = wizardAskSecret(rl, isTTY, () => nextLine.drain());

  // 版本号统一走 update-check 的读取（读取失败回退 0.0.0）
  const version = readPkgVersion();

  let cfg: AgentConfig;
  try {
    cfg = await ensureConfig(ask, { choose, askSecret });
  } catch (err) {
    // 向导内 Esc/Ctrl+C 取消（reject '已取消'）是中性操作，与 /config、bot-main 同一口径：
    // 灰字提示 + 退出码 0，不打成红色「配置失败」
    if (handleWizardCancel(err)) {
      rl.close();
      process.exit(0);
    }
    console.error(c.err(`\n配置失败：${errMessage(err)}`));
    rl.close();
    process.exit(1);
  }

  // npm 更新检查：与看板/MCP 启动并发进行，banner 打印后再请示（结果缓存 24h，离线静默）
  const pendingUpdate = !updateCheckDisabled() && isTTY ? checkForUpdate({ current: version }) : null;

  /**
   * 信号处理尽早注册 + 资源创建即登记（对齐 bot-main 的模式）：
   * ensureKanbanOrExit（最长 90s）与 connectMcp（最长 45s）窗口内收到 SIGINT/SIGTERM，
   * 走默认终止会把 in-flight 的看板 / MCP stdio（npx）子进程丢成孤儿，Ctrl+C 也不退出；
   * 这里保证 cleanup 在启动全程可用，只清理已登记的资源。
   */
  let kanbanChild: ChildProcess | null = null;
  /** 当前运行中的 agent 轮次；非 null 时 Ctrl+C 只中断任务不退出进程。 */
  let currentCtl: AbortController | null = null;
  const spinner = new Spinner('思考中…');
  /** MCP 实例登记处：onCreate 在实例创建时（connect 发起前）即登记，45s 连接窗口内收到信号也能 close。 */
  const cleanupRes: { mcp: KanbanMcp | null; reminderRunner: ReminderRunner | null } = {
    mcp: null,
    reminderRunner: null,
  };

  /**
   * 到点提醒的终端投递缓冲：agent 轮次进行中不打断（排队到轮次结束后统一提示），
   * 空闲时立即打印。声明先于 cleanup：启动早期收到退出信号时 cleanup 也要能 flush，
   * 否则提醒已 markDelivered 落盘却永久丢失展示。
   */
  const pendingReminderTexts: string[] = [];
  /** 主循环是否正停在 › 提示符等待输入：空闲投递提醒时据此决定是否清行重绘（见 printReminder）。 */
  let atMainPrompt = false;
  const printReminder = (text: string, redrawPrompt = false) => {
    // 提醒可能打在用户正在输入的行中间：先清当前行，打印后重绘提示符与已输入内容。
    // 仅主提示符等待期间重绘；轮次间隙 flush 时提示符尚未打印，重绘会造成双提示符。
    const redraw = redrawPrompt && isTTY;
    if (redraw) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    console.log(`\n${c.warn(text)}`);
    if (redraw) process.stdout.write(c.info('› ') + rl.line);
  };
  const flushPendingReminders = () => {
    if (!pendingReminderTexts.length) return;
    for (const text of pendingReminderTexts.splice(0)) printReminder(text);
    console.log('');
  };

  /**
   * 退出清理：幂等（Ctrl+C 连按 / process+rl 双通道 SIGINT 不重入）+ 8s 强退兜底（对齐 bot 模式，
   * 实现见 infra/process-lifecycle.ts）。exitCode 由触发路径决定：正常退出 0；uncaughtException 传 1。
   */
  const cleanup = createGracefulExit({
    cleanup: async () => {
      spinner.stop();
      await cleanupRes.reminderRunner?.stop();
      await cleanupRes.mcp?.close();
      // 轮次后直接 /exit（或退出信号）时缓冲提醒尚未 flush，但已 markDelivered 落盘：
      // 退出前补一次展示，否则这批提醒永久丢失
      flushPendingReminders();
      // 不 kill 自动拉起的看板：用户可能正在用 Web UI；留下停止方式即可。
      // 存活判定与 stopKanbanChild 一致用进程树（infra/proc.ts 的 processTreeAlive，含 win32 分支）：
      // detached 的 npx 壳可能先退、被 reparent 的看板孙进程仍在组里占端口，exitCode===null 会漏提示；
      // 停止命令也按进程组给（壳已死时 kill <pid> 打的是死壳，杀不到看板孙进程）。
      if (kanbanChild && kanbanChild.pid !== undefined && processTreeAlive(kanbanChild.pid)) {
        kanbanChild.stdout?.destroy();
        kanbanChild.stderr?.destroy();
        kanbanChild.unref();
        // win32 无进程组 kill：taskkill /T 杀整棵进程树，/F 强制；
        // 注解前移到命令前（整行复制时粘在行尾的注解会污染命令）
        const stopHint =
          process.platform === 'win32'
            ? `停止（杀进程树）：taskkill /PID ${kanbanChild.pid} /T /F`
            : `停止（杀进程组）：kill -- -${kanbanChild.pid}`;
        console.log(c.gray(`看板服务保留运行（${cfg.kanbanUrl}），${stopHint}`));
      }
      rl.close();
    },
  });
  const onSigint = () => {
    if (currentCtl) {
      currentCtl.abort();
      return;
    }
    console.log('\n' + c.gray('再见 👋'));
    void cleanup(0);
  };
  // 信号处理在看板拉起（最长 90s）与 MCP 连接（最长 45s）之前注册：两个窗口内收到信号时
  // cleanup 已可用，配合 onSpawn/onCreate 登记能把 in-flight 子进程一并处置，不留孤儿。
  // terminal 模式下 readline 会拦截 ^C：rl 无 SIGINT listener 时默认 rl.close()，
  // 任务运行中按 Ctrl+C 会关闭输入流而非中断当前任务；两级 handler 同一函数，天然幂等。
  process.on('SIGINT', onSigint);
  rl.on('SIGINT', onSigint);
  process.on('SIGTERM', () => void cleanup(0));
  // 长驻 REPL 兜底（与 bot 同策略）+ HTA_TEST_CRASH 测试钩子：见 infra/process-lifecycle.ts
  installCrashGuards(cleanup);

  const bootKanban = new Spinner('检查 helios-kanban…').start();
  let ensured: KanbanEnsureResult;
  try {
    ensured = await ensureKanbanOrExit({
      kanbanUrl: cfg.kanbanUrl,
      onLog: (msg) => bootKanban.setText(msg),
      // 就绪等待期间（最长 90s）收到退出信号时，cleanup 需要拿到 child 才能处置
      onSpawn: (child) => {
        kanbanChild = child;
      },
      onFail: () => {
        bootKanban.stop();
        rl.close();
      },
      failLabel: '看板不可用',
    });
  } catch (err) {
    // 启动失败（FatalStartupError）：错误与手动指引已在 ensureKanbanOrExit 内打印，
    // 这里按 exitCode 走 cleanup 统一收尾（保持原退出码语义，不再绕过清理）
    if (err instanceof FatalStartupError) await cleanup(err.exitCode);
    throw err;
  }
  kanbanChild = ensured.child;
  bootKanban.stop();
  if (ensured.started) console.log(c.ok('已自动启动 helios-kanban'));

  const boot = new Spinner('正在连接看板…').start();
  const { mcp, ok: mcpOk, hint: mcpHint } = await connectMcp(cfg, {
    // 实例一创建即登记清理（参照 kanban 的 onSpawn 模式），不等 connect resolve
    onCreate: (instance) => {
      cleanupRes.mcp = instance;
    },
  });
  boot.stop();
  // 备用通道（hk.mjs）零外部依赖、始终可用：诊断提示无需再按降级链状态重算，直接展示 connectMcp 结论
  if (!mcpOk && mcpHint) console.log(c.warn(mcpHint));

  const larkStatus = checkLarkCliStatus();

  // 依赖探测（子进程）在这里完成，banner 只负责渲染传入的结果
  printBanner({
    version,
    model: cfg.llmModel,
    baseUrl: cfg.llmBaseUrl,
    kanbanUrl: cfg.kanbanUrl,
    mcp: mcpOk ? 'ok' : 'fail',
    mcpToolCount: mcpOk ? mcp.tools.length : 0,
    larkOk: larkStatus !== 'missing',
    larkAuthed: larkStatus === 'ok',
  });
  // banner 状态行已含未授权/未找到说明；warnStartupDeps 只补 banner 放不下的安装命令（未授权指引已在 banner 行内）
  warnStartupDeps(larkStatus, { style: 'cli' });
  migrateAndValidateSkills();

  /** ask 的 abort/超时感知版：实现见模块级 createAskWithAbort（单测覆盖三路竞态 + 陈旧 waiter 取消）。 */
  const askWithAbort = createAskWithAbort(ask, () => currentCtl, nextLine.cancelPending);

  // 写操作硬确认：实现见模块级 createCliConfirm（单测覆盖超时归因 / 绝对超时窗口 / ANSI 剥离）
  const confirmWrite: ConfirmFn = createCliConfirm(askWithAbort, spinner);

  const reminders = new ReminderStore();
  const session = new AgentSession(cfg, mcpOk ? mcp : null, mcpOk, {
    userId: 'local',
    confirm: confirmWrite,
    historyStore: new SessionHistoryStore(),
    reminders,
  });

  /**
   * 到点提醒的终端投递：agent 轮次进行中不打断（排队到轮次结束后统一提示，
   * 避免提醒文本插进 spinner/工具输出中间）；空闲时立即打印。
   * （缓冲本身在 cleanup 之前声明，退出路径也要 flush，见上。）
   */
  const reminderRunner = new ReminderRunner({
    store: reminders,
    // CLI 只投 local 桶：飞书形态（uid 为 open_id）的提醒由 bot 实例投递，跨形态桶不投递不标记已送达
    deliverable: (uid) => uid === 'local',
    deliver: async (_uid, text) => {
      if (currentCtl) pendingReminderTexts.push(text);
      else printReminder(text, atMainPrompt);
    },
    // 投递流水（含内部 uid 与提醒正文）收 HTA_DEBUG：正文已由 deliver 打印，uid「local」是内部细节
    log: (msg) => {
      if (process.env.HTA_DEBUG) console.log(c.gray(`[reminder] ${msg}`));
    },
  });
  reminderRunner.start();
  cleanupRes.reminderRunner = reminderRunner;

  /** MCP 实例绑定的看板地址：/config 改地址后 MCP 不会重连，/status 据此持续警示，直到重启。 */
  const mcpBoundKanbanUrl = cfg.kanbanUrl;

  /**
   * 看板连接的轻量存活探测：connectMcp 的 mcpOk 是启动时一次性快照，会话中看板重启/崩溃后
   * 快照不失效会谎称「正常」，/status 与 /tools 调用时现测（ping 短超时，CLI 无重连机制）。
   */
  const probeMcpAlive = async (): Promise<boolean> => {
    if (!mcpOk || !mcp.connected) return false;
    try {
      await Promise.race([
        mcp.ping(),
        new Promise<never>((_resolve, reject) => {
          const t = setTimeout(() => reject(new Error('probe timeout')), 3000);
          t.unref();
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  };

  // 发现新版本则请示是否更新（用户选 y 会执行 npm i -g；更新后需重启生效，复用 cleanup 的看板处置）
  if (pendingUpdate) {
    const info = await pendingUpdate;
    if (info) {
      // 先 drain 行队列：看板拉起 + MCP 连接期间用户敲入的行会缓存在 createLineReader 的 queue 里，
      // 不 drain 的话更新确认的 ask 会立即消费最早缓存的陈旧行——恰好是 y/yes 就会在用户
      // 没看到提示时执行 npm i -g（与向导交互后 drain 同一模式，见 wizardChoose/wizardAskSecret 调用处）
      nextLine.drain();
      const outcome = await maybePromptUpdate(info, ask);
      if (outcome === 'updated') {
        console.log(c.ok('请重新运行 helios-task-agent 使用新版本。'));
        await cleanup();
      }
    }
  }

  /**
   * 斜杠命令表（命令名 → handler）：handler 闭包引用 cfg 等可变绑定，/config 改配置后自然读到新值。
   * /quit 与 /exit 同效，共用同一 handler；分发见 dispatchCommand。
   */
  const commandHandlers: Record<string, (line: string, fullCmd: string) => void | Promise<void>> = {
    '/exit': async () => {
      console.log(c.gray('再见 👋'));
      await cleanup();
    },
    '/help': () => console.log(HELP),
    '/clear': () => {
      // clearHistory 会一并撤销免问授权：先取计数，按新语义告知（取在 clear 后恒为 0，提示成死文案）
      const revoked = session.activeBatchApprovals();
      session.clearHistory();
      console.log(c.gray(clearedText(revoked)));
    },
    '/confirm': (_line, fullCmd) => {
      // /confirm on 是历史别名；语义化的写法是 /confirm revoke（撤销免问、恢复逐次确认）。
      // 未匹配的子命令（如 /confirm off）按状态查询处理，与 bot 端行为对齐
      if (fullCmd === '/confirm revoke' || fullCmd === '/confirm on') {
        const n = session.revokeBatchApprovals();
        console.log(n ? c.ok(confirmRevokedText(n, '')) : c.gray(confirmRevokedText(0, confirmStateText(0, ''))));
      } else {
        const active = session.activeBatchApprovals();
        console.log(
          active
            ? c.warn(confirmStateText(active, '输入 /confirm revoke 恢复逐次确认'))
            : c.gray(confirmStateText(0, '')),
        );
      }
    },
    '/memory': () => {
      // CLI 端记忆归属恒为 local：仅在非 local（未来多用户）时展示 user= 后缀，避免无信息量的内部细节
      const userSuffix = session.memoryUserId === 'local' ? '' : c.gray(`  user=${session.memoryUserId}`);
      for (const l of buildMemoryLines(session, c.strong('你的记忆') + userSuffix)) {
        console.log(l);
      }
      console.log('');
    },
    '/tools': async () => {
      const mcpAlive = await probeMcpAlive();
      for (const l of buildToolsLines(
        {
          mcpOk: mcpAlive,
          mcpTools: mcp.tools,
          // CLI 会话恒挂 MemoryStore（session.ts 构造默认），memory_* 工具始终注册；reminder_* 同理恒注册
          memoryEnabled: true,
          reminderEnabled: true,
          kanbanHeader: c.strong(`看板工具（${mcp.tools.length} 个）`),
          downNote: mcpOk
            ? c.warn('看板连接已断开，看板工具暂不可用；退出并重新运行本程序即可恢复（/exit 退出）。')
            : c.warn(`看板连接失败，${MCP_FALLBACK_TEXT}，大部分功能可用，如遇操作失败请稍后再试。`),
          localHeader: c.strong('本地工具：'),
          bullet: '  ',
        },
        c,
      )) {
        console.log(l);
      }
    },
    '/skills': (line) => {
      // 子命令参数（install 路径等）区分大小写，用原始 line 而非小写化后的 cmd
      for (const l of handleSkillsCommand(
        line,
        {
          header: c.strong('已安装技能：'),
          bullet: '  ',
          footer: c.gray('对话中可直接问「你有什么技能」；细节会在对话中按需自动加载。'),
        },
        c,
      )) {
        console.log(l);
      }
    },
    '/status': async () => {
      const mcpAlive = await probeMcpAlive();
      const lines = await buildStatusLines(
        {
          model: cfg.llmModel,
          kanbanUrl: cfg.kanbanUrl,
          mcpOk: mcpAlive,
          mcpToolCount: mcp.tools.length,
          mcpDownNote: mcpOk
            ? '连接已断开，退出并重新运行本程序即可恢复（/exit 退出）'
            : '连接失败，已切换为备用通道',
          larkOk: larkStatus !== 'missing',
          // /config 改过看板地址后一次性警告易被淹没，/status 里持续提示直到重启；
          // MCP 从未连上时不存在「旧连接」，工具实际走已指向新地址的备用通道，按 mcpOk 条件化
          extra:
            cfg.kanbanUrl !== mcpBoundKanbanUrl
              ? [
                  c.warn(
                    mcpOk
                      ? `注意：看板连接仍指向旧地址 ${mcpBoundKanbanUrl}，看板工具操作的是旧看板；/exit 重启后才会连接新地址。`
                      : '注意：看板主连接未建立，备用通道已指向新地址。',
                  ),
                ]
              : undefined,
        },
        c,
      );
      console.log(c.strong('状态'));
      for (const l of lines) console.log('  ' + l);
      console.log('');
    },
    '/config': async () => {
      try {
        const prevKanbanUrl = cfg.kanbanUrl;
        const prevModel = cfg.llmModel;
        cfg = await ensureConfig(ask, { force: true, choose, askSecret });
        session.applyConfig(cfg);
        console.log(
          cfg.llmModel !== prevModel
            ? c.ok('配置已更新，模型切换为 ') + c.strong(cfg.llmModel)
            : c.ok(`配置已更新（模型仍为 ${cfg.llmModel}）`),
        );
        if (cfg.kanbanUrl !== prevKanbanUrl) {
          // MCP 从未连上时不存在「仍指向旧看板的连接」，工具实际走已指向新地址的备用通道，按 mcpOk 条件化
          console.log(
            c.warn(
              mcpOk
                ? `看板地址已改为 ${cfg.kanbanUrl}，但当前连接仍指向启动时的旧看板，看板工具操作的仍是旧看板；` +
                  '备用通道已指向新地址。建议 /exit 后重启以连接新地址。'
                : `看板地址已改为 ${cfg.kanbanUrl}；看板主连接未建立，备用通道已指向新地址。`,
            ),
          );
        }
      } catch (err) {
        // 向导内 Esc/Ctrl+C 取消（reject '已取消'）是中性操作，不打成红色「配置失败」
        if (!handleWizardCancel(err)) console.error(c.err(`配置失败：${errMessage(err)}`));
      }
    },
    '/stop': () => {
      // bot 帮助教用户 /stop；同一用户到 CLI 输入 /stop 时给出本端等价操作，不报「未知命令」
      console.log(c.gray('CLI 中按 Ctrl+C 中断当前任务（/exit 退出）。'));
    },
  };
  commandHandlers['/quit'] = commandHandlers['/exit']!;

  /**
   * 表驱动斜杠命令分发：按首词判定命令（与 bot 的 parseCommand 一致）：/status foo 不再整行被当成
   * 未知命令；带子命令的 /confirm 仍按整行词表匹配（fullCmd）。未命中按未知命令提示。
   */
  const dispatchCommand = async (line: string): Promise<void> => {
    const cmd = line.toLowerCase().split(/\s+/)[0]!;
    const handler = commandHandlers[cmd];
    if (!handler) {
      console.log(c.warn(`未知命令 ${cmd}，输入 /help 查看帮助。`));
      return;
    }
    await handler(line, line.toLowerCase());
  };

  for (;;) {
    atMainPrompt = true;
    const input = await ask(c.info('› '));
    atMainPrompt = false;
    if (input === null) {
      await cleanup();
      // cleanup 内部 process.exit 不返回；幂等重入路径会正常返回，显式 return 消除对「cleanup 必退出」的隐式依赖
      return;
    }
    const line = input.trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      await dispatchCommand(line);
      continue;
    }

    // 纯文本「恢复确认」确定性拦截（剥尾部标点；与 bot handler、/confirm revoke 同路同文案）
    if (line.replace(/[。！？!?.．…]+$/u, '') === '恢复确认') {
      const n = session.revokeBatchApprovals();
      console.log(n ? c.ok(confirmRevokedText(n, '')) : c.gray(confirmRevokedText(0, confirmStateText(0, ''))));
      continue;
    }

    spinner.start('思考中…（Ctrl+C 中断）');
    const ctl = new AbortController();
    currentCtl = ctl;
    try {
      const reply = await session.handleUserMessage(
        line,
        (info) => {
          if (info.type === 'tool') spinner.setText(`${toolActionLabel(info.name, info.args)} …（Ctrl+C 中断）`);
          else spinner.setText('思考中…（Ctrl+C 中断）');
        },
        ctl.signal,
      );
      spinner.stop();
      console.log('\n' + renderReply(reply) + '\n');
    } catch (err) {
      spinner.stop();
      if (ctl.signal.aborted) {
        // 与 llm.ts 的优雅中断收尾同一措辞：同一事件两套文案会被读成两个事件（bot 端同口径）
        console.log(c.gray('\n⏹ 已中断（未完成的操作未执行，可继续对话）。'));
      } else {
        const message = errMessage(err);
        const parts = llmFailureParts(message, line, 'cli');
        console.error(c.err(`\n${parts.head}`));
        if (parts.friendly) console.error(c.warn(parts.friendly));
        console.error(c.gray(parts.tail + '\n'));
      }
    } finally {
      currentCtl = null;
      // 轮次结束后补提示期间到点的提醒（不打断进行中的轮次）
      flushPendingReminders();
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
