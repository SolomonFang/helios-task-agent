import readline from 'readline';
import { type ChildProcess } from 'child_process';
import { c, printBanner, Spinner, renderReply } from './infra/ui';
import { ensureEnvLoaded } from './config/config';
import { ensureConfig } from './config/config-wizard';
import { AgentSession } from './agent/session';
import { SessionHistoryStore } from './agent/session-store';
import { connectMcp } from './kanban/mcp';
import type { KanbanMcp } from './kanban/mcp';
import { checkHkDeps, checkLarkCliStatus, HK_CLI_INSTALL_HINT, MCP_FALLBACK_TEXT } from './infra/deps';
import { ensureKanbanOrExit, migrateAndValidateSkills, warnStartupDeps } from './bootstrap';
import { wizardAskSecret, wizardChoose } from './config/wizard-io';
import { checkForUpdate, promptVersionUpdate, readPkgVersion, updateCheckDisabled } from './infra/update-check';
import {
  buildMemoryLines,
  buildStatusLines,
  buildToolsLines,
  clearedText,
  confirmRevokedText,
  confirmStateText,
  handleSkillsCommand,
  llmFailureParts,
  TRY_EXAMPLES,
} from './commands';
import { CONFIRM_BATCH_RE, CONFIRM_YES_RE } from './agent/confirm';
import { kindLabel, type ConfirmFn } from './agent/guard';
import type { AgentConfig, AskFn } from './types';
import { errMessage } from './infra/err';

type LineReader = (() => Promise<string | null>) & { drain: () => void };

function createLineReader(rl: readline.Interface): LineReader {
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
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
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
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
  return nextLine;
}

const HELP = `
  ${c.strong('命令')}
  ${c.info('/help')}     显示帮助
  ${c.info('/config')}   重新配置模型 / kanban 地址
  ${c.info('/tools')}    列出当前可用的 kanban 工具
  ${c.info('/skills')}   列出技能；install <路径> 安装（升级不丢失）/ uninstall <名称> 卸载
  ${c.info('/memory')}   查看持久化记忆（飞书任务源等）
  ${c.info('/status')}   健康检查（模型 / kanban / MCP / lark-cli）
  ${c.info('/clear')}    清空对话历史（不清记忆）
  ${c.info('/confirm')}  查看「同类免问」状态；/confirm revoke 撤销免问、恢复逐次确认
  ${c.info('/exit')}     退出（/quit 同效；任务运行中按 Ctrl+C 只中断不退出）

  ${c.strong('试试对我说')}
${TRY_EXAMPLES.map((e) => `  · ${e}`).join('\n')}
`;

/** askWithAbort 的超时哨兵：与「用户留空 / Ctrl+C」区分，便于打印自动拒绝文案。 */
export const ASK_TIMEOUT: unique symbol = Symbol('ask-timeout');

/**
 * ask 的 abort/超时感知版（纯逻辑抽出以便单测；main 内用 createAskWithAbort(ask, () => currentCtl) 构造）：
 * 闸门询问期间按 Ctrl+C = 拒绝该写操作（随后整个任务被中断）；
 * 超时未操作按拒绝处理（对齐飞书 bot：可批量 120s / 破坏性 300s）。
 * getCtl 返回当前运行轮次的 AbortController（无轮次时为 null）。
 */
export function createAskWithAbort(
  ask: AskFn,
  getCtl: () => AbortController | null,
): (promptText: string, timeoutMs?: number) => Promise<string | null | typeof ASK_TIMEOUT> {
  return (promptText, timeoutMs) => {
    const ctl = getCtl();
    if (!ctl && !timeoutMs) return ask(promptText);
    if (ctl?.signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => finish(null);
      const finish = (v: string | null | typeof ASK_TIMEOUT) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ctl?.signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      ctl?.signal.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs) {
        timer = setTimeout(() => finish(ASK_TIMEOUT), timeoutMs);
        timer.unref();
      }
      void ask(promptText).then(finish);
    });
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
    const message = errMessage(err);
    console.error(c.err(`\n配置失败：${message}`));
    rl.close();
    process.exit(1);
  }

  // npm 更新检查：与看板/MCP 启动并发进行，banner 打印后再请示（结果缓存 24h，离线静默）
  const pendingUpdate = !updateCheckDisabled() && isTTY ? checkForUpdate({ current: version }) : null;

  let kanbanChild: ChildProcess | null = null;
  const bootKanban = new Spinner('检查 helios-kanban…').start();
  const ensured = await ensureKanbanOrExit({
    kanbanUrl: cfg.kanbanUrl,
    onLog: (msg) => bootKanban.setText(msg),
    onFail: () => {
      bootKanban.stop();
      rl.close();
    },
    failLabel: '看板不可用',
  });
  kanbanChild = ensured.child;
  bootKanban.stop();
  if (ensured.started) console.log(c.ok('已自动启动 helios-kanban'));

  /** 当前运行中的 agent 轮次；非 null 时 Ctrl+C 只中断任务不退出进程。 */
  let currentCtl: AbortController | null = null;
  const spinner = new Spinner('思考中…');
  /** MCP 实例登记处：onCreate 在实例创建时（connect 发起前）即登记，45s 连接窗口内收到信号也能 close。 */
  const cleanupRes: { mcp: KanbanMcp | null } = { mcp: null };

  let cleaningUp = false;
  /**
   * 退出清理：幂等（Ctrl+C 连按 / process+rl 双通道 SIGINT 不重入）+ 8s 强退兜底（对齐 bot 模式）。
   * exitCode 由触发路径决定：正常退出 0；uncaughtException 传 1——以 0 退出会被
   * launchd/systemd 当成干净停止而不触发自动重启。
   */
  const cleanup = async (exitCode = 0): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    // 强退兜底：mcp.close 挂住时进程不得永不退（unref：该定时器自身不得阻止正常退出）
    const forceTimer = setTimeout(() => {
      console.error(c.err('\n退出清理超时，强制结束进程'));
      process.exit(1);
    }, 8000);
    forceTimer.unref();
    spinner.stop();
    try {
      await cleanupRes.mcp?.close();
    } catch {
      /* 尽力清理，失败照常退出 */
    }
    // 不 kill 自动拉起的看板：用户可能正在用 Web UI；留下停止方式即可
    if (kanbanChild && kanbanChild.exitCode === null) {
      kanbanChild.stdout?.destroy();
      kanbanChild.stderr?.destroy();
      kanbanChild.unref();
      console.log(c.gray(`看板服务保留运行（PID ${kanbanChild.pid}），停止：kill ${kanbanChild.pid}`));
    }
    rl.close();
    clearTimeout(forceTimer);
    process.exit(exitCode);
  };
  const onSigint = () => {
    if (currentCtl) {
      currentCtl.abort();
      return;
    }
    console.log('\n' + c.gray('再见 👋'));
    void cleanup(0);
  };
  // 信号处理在 MCP 连接（最长 45s）之前注册：连接窗口内收到 SIGINT 时 cleanup 已可用，
  // 配合 onCreate 登记能把 in-flight 的 MCP 子进程一并收掉，不留孤儿。
  // terminal 模式下 readline 会拦截 ^C：rl 无 SIGINT listener 时默认 rl.close()，
  // 任务运行中按 Ctrl+C 会关闭输入流而非中断当前任务；两级 handler 同一函数，天然幂等。
  process.on('SIGINT', onSigint);
  rl.on('SIGINT', onSigint);
  // 长驻 REPL 兜底（与 bot 同策略）：漏网 rejection 记日志不退出；
  // uncaughtException 复用 cleanup 优雅退出（退出码 1，见 cleanup 注释）。
  // handler 自身只做同步日志，不得再抛异常。
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(c.err(`未处理的 Promise rejection（进程保持运行）：${msg}`));
  });
  process.on('uncaughtException', (err) => {
    console.error(c.err(`未捕获异常，执行优雅退出：${err.stack || err.message}`));
    void cleanup(1);
  });
  // 测试钩子（HTA_TEST_CRASH=1）：让子进程测试能真实触发 uncaughtException 路径，
  // 验证崩溃退出码为 1（setImmediate 抛出才走 uncaughtException，同步 throw 只会 reject main）
  if (process.env.HTA_TEST_CRASH) setImmediate(() => { throw new Error('HTA_TEST_CRASH'); });

  const boot = new Spinner('正在连接 helios-kanban MCP…').start();
  const { mcp, ok: mcpOk, hint: mcpHint } = await connectMcp(cfg, {
    // 实例一创建即登记清理（参照 kanban 的 onSpawn 模式），不等 connect resolve
    onCreate: (instance) => {
      cleanupRes.mcp = instance;
    },
  });
  boot.stop();
  // 降级链探测先于告警：可用时 banner 已完整表达（不在 banner 外重复），缺依赖时改口告知看板读写暂不可用
  const hkMissing = checkHkDeps();
  if (!mcpOk) {
    if (hkMissing.length) {
      console.log(
        c.warn(`MCP 连接失败，且 hk_cli 降级链缺少 ${hkMissing.join('、')}，看板读写暂不可用（${HK_CLI_INSTALL_HINT}）。`),
      );
    }
    if (mcpHint) console.log(c.warn(mcpHint));
  }

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
    hkMissing,
  });
  // banner 状态行已含未授权/未找到说明；warnStartupDeps 只补 banner 放不下的安装命令（未授权指引已在 banner 行内）
  warnStartupDeps(larkStatus, { style: 'cli' });
  migrateAndValidateSkills();

  /** ask 的 abort/超时感知版：实现见模块级 createAskWithAbort（单测覆盖三路竞态）。 */
  const askWithAbort = createAskWithAbort(ask, () => currentCtl);

  // 写操作硬确认：闸门触发时暂停 spinner；默认拒绝；「免问」（或 batch/同类免问等词）开启同类免问；Ctrl+C 视为拒绝；
  // 超时自动拒绝（与飞书 bot 同语义：普通写 120s、破坏性 300s）。
  const confirmWrite: ConfirmFn = async (req) => {
    spinner.stop();
    console.log('');
    console.log(c.warn(`⚠️ 写操作请求（${kindLabel(req.kind)}）：${req.summary}`));
    console.log(c.gray(req.detail));
    const timeoutMs = req.destructive ? 300000 : 120000;
    const options = req.batchKey ? 'y=仅此次 / 免问=同类免问（本会话）/ N=取消' : 'y=仅此次 / N=取消';
    const ans = await askWithAbort(
      c.warn(`允许执行？[${options}]（${Math.round(timeoutMs / 1000)} 秒未操作自动拒绝） `),
      timeoutMs,
    );
    spinner.start('思考中…（Ctrl+C 中断）');
    if (ans === ASK_TIMEOUT) {
      console.log(c.gray('⏰ 超时未操作，已自动拒绝，操作未执行。'));
      return false;
    }
    const t = (ans || '').trim().toLowerCase();
    const batch = Boolean(req.batchKey) && CONFIRM_BATCH_RE.test(t);
    const once = !batch && CONFIRM_YES_RE.test(t);
    if (batch) {
      console.log(c.ok('已批准；同类写操作本会话内免问（/confirm revoke 撤销）。'));
      return 'batch';
    }
    if (once) {
      console.log(c.ok('已批准（仅此次），继续执行。'));
      return 'once';
    }
    console.log(c.gray('已取消，操作未执行。'));
    return false;
  };

  const session = new AgentSession(cfg, mcpOk ? mcp : null, mcpOk, {
    userId: 'local',
    confirm: confirmWrite,
    historyStore: new SessionHistoryStore(),
  });

  /** MCP 实例绑定的看板地址：/config 改地址后 MCP 不会重连，/status 据此持续警示，直到重启。 */
  const mcpBoundKanbanUrl = cfg.kanbanUrl;

  // 发现新版本则请示是否更新（用户选 y 会执行 npm i -g；更新后需重启生效，复用 cleanup 的看板处置）
  if (pendingUpdate) {
    const info = await pendingUpdate;
    if (info) {
      const outcome = await promptVersionUpdate({ info, ask, log: (m) => console.log(c.gray(m)) });
      if (outcome === 'updated') {
        console.log(c.ok('请重新运行 helios-task-agent 使用新版本。'));
        await cleanup();
      }
    }
  }

  for (;;) {
    const input = await ask(c.info('› '));
    if (input === null) await cleanup();
    const line = input!.trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      const cmd = line.toLowerCase();
      if (cmd === '/exit' || cmd === '/quit') {
        console.log(c.gray('再见 👋'));
        await cleanup();
      } else if (cmd === '/help') {
        console.log(HELP);
      } else if (cmd === '/clear') {
        session.clearHistory();
        console.log(c.gray(clearedText(session.activeBatchApprovals())));
      } else if (cmd === '/confirm' || cmd === '/confirm revoke' || cmd === '/confirm on') {
        // /confirm on 是历史别名；语义化的写法是 /confirm revoke（撤销免问、恢复逐次确认）
        if (cmd !== '/confirm') {
          const n = session.revokeBatchApprovals();
          console.log(
            n ? c.ok(confirmRevokedText(n, '')) : c.gray(confirmRevokedText(0, '当前没有生效中的「同类免问」。')),
          );
        } else {
          const active = session.activeBatchApprovals();
          console.log(
            active
              ? c.warn(confirmStateText(active, '输入 /confirm revoke 恢复逐次确认'))
              : c.gray(confirmStateText(0, '')),
          );
        }
      } else if (cmd === '/memory') {
        // CLI 端记忆归属恒为 local：仅在非 local（未来多用户）时展示 user= 后缀，避免无信息量的内部细节
        const userSuffix = session.memoryUserId === 'local' ? '' : c.gray(`  user=${session.memoryUserId}`);
        for (const l of buildMemoryLines(session, c.strong('用户记忆') + userSuffix)) {
          console.log(l);
        }
        console.log('');
      } else if (cmd === '/tools') {
        for (const l of buildToolsLines(
          {
            mcpOk,
            mcpTools: mcp.tools,
            kanbanHeader: c.strong('kanban MCP 工具:'),
            downNote: c.warn(
              hkMissing.length
                ? `MCP 未连接，${MCP_FALLBACK_TEXT}，但缺少 ${hkMissing.join('、')}，看板读写暂不可用。`
                : `MCP 未连接，${MCP_FALLBACK_TEXT}，看板功能不受影响。`,
            ),
            localHeader: c.strong('本地工具:'),
            bullet: '  ',
          },
          c,
        )) {
          console.log(l);
        }
      } else if (cmd === '/skills' || cmd.startsWith('/skills ')) {
        // 子命令参数（install 路径等）区分大小写，用原始 line 而非小写化后的 cmd
        for (const l of handleSkillsCommand(
          line,
          {
            header: c.strong('已安装技能:'),
            bullet: '  ',
            footer: c.gray('对话中可直接问「你有什么技能」；细节由 agent 用 skill_doc 按需读取。'),
          },
          c,
        )) {
          console.log(l);
        }
      } else if (cmd === '/status') {
        const lines = await buildStatusLines(
          {
            model: cfg.llmModel,
            kanbanUrl: cfg.kanbanUrl,
            mcpOk,
            mcpToolCount: mcp.tools.length,
            mcpDownNote: `连接失败，${MCP_FALLBACK_TEXT}`,
            larkOk: larkStatus !== 'missing',
            // /config 改过看板地址后一次性警告易被淹没，/status 里持续提示直到重启
            extra:
              cfg.kanbanUrl !== mcpBoundKanbanUrl
                ? [
                    c.warn(
                      `注意：MCP 仍连接旧看板 ${mcpBoundKanbanUrl}，kanban_* 工具操作的是旧实例；/exit 重启后才会连接新地址。`,
                    ),
                  ]
                : undefined,
          },
          c,
        );
        console.log(c.strong('状态'));
        for (const l of lines) console.log('  ' + l);
        console.log('');
      } else if (cmd === '/config') {
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
            console.log(
              c.warn(
                `看板地址已改为 ${cfg.kanbanUrl}，但 MCP 连接仍是启动时的旧实例（kanban_* 工具将操作旧看板）；` +
                  'hk_cli 已指向新地址。建议 /exit 后重启以重连 MCP。',
              ),
            );
          }
        } catch (err) {
          const message = errMessage(err);
          console.error(c.err(`配置失败：${message}`));
        }
      } else {
        console.log(c.warn(`未知命令 ${line}，输入 /help 查看帮助。`));
      }
      continue;
    }

    spinner.start('思考中…（Ctrl+C 中断）');
    const ctl = new AbortController();
    currentCtl = ctl;
    try {
      const reply = await session.handleUserMessage(
        line,
        (info) => {
          if (info.type === 'tool') spinner.setText(`调用工具 ${info.name} …（Ctrl+C 中断）`);
          else spinner.setText('思考中…（Ctrl+C 中断）');
        },
        ctl.signal,
      );
      spinner.stop();
      console.log('\n' + renderReply(reply) + '\n');
    } catch (err) {
      spinner.stop();
      if (ctl.signal.aborted) {
        console.log(c.gray('\n⏹ 已中断当前任务（进程未退出，可继续对话）。'));
      } else {
        const message = errMessage(err);
        const parts = llmFailureParts(message, line, 'cli');
        console.error(c.err(`\n${parts.head}`));
        if (parts.friendly) console.error(c.warn(parts.friendly));
        console.error(c.gray(parts.tail + '\n'));
      }
    } finally {
      currentCtl = null;
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
