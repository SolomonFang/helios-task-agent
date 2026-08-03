import readline from 'readline';
import { type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { c, printBanner, Spinner, renderReply, selectList, readSecret, MCP_FALLBACK_TEXT } from './ui';
import { ensureConfig } from './config-wizard';
import { AgentSession } from './session';
import { ensureKanbanRunning } from './kanban/kanban-ensure';
import { checkLarkCliStatus, kanbanManualStartHint, LARK_CLI_INSTALL_HINT, LARK_CLI_AUTH_HINT } from './deps';
import { checkForUpdate, promptVersionUpdate, updateCheckDisabled } from './update-check';
import {
  buildMemoryLines,
  buildSkillsLines,
  buildStatusLines,
  buildToolsLines,
  CLEARED_TEXT,
  confirmRevokedText,
  confirmStateText,
  connectMcp,
  llmFailureParts,
} from './commands';
import { CONFIRM_BATCH_RE, CONFIRM_YES_RE, kindLabel } from './confirm';
import type { ConfirmFn } from './guard';
import type { AgentConfig, AskFn, LlmPreset } from './types';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
};

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
  ${c.info('/skills')}   列出已安装技能（数据目录 skills/ 优先，包内置底）
  ${c.info('/memory')}   查看持久化记忆（飞书任务源等）
  ${c.info('/status')}   健康检查（模型 / kanban / MCP / lark-cli）
  ${c.info('/clear')}    清空对话历史（不清记忆）
  ${c.info('/confirm')}  查看「同类免问」状态；/confirm on 撤销免问、恢复逐次确认
  ${c.info('/exit')}     退出（任务运行中按 Ctrl+C 只中断不退出）

  ${c.strong('试试对我说')}
  · 以后都从这个飞书地址同步任务：<链接>
  · 同步/列出我的任务（含链接会展开详情）
  · 写进 helios-kanban（确认后再创建，不自动启动）
  · 有哪些项目 / 创建一个任务：修复登录页样式 bug
  · 用 Claude 跑这个任务 / 再跟它说一句：先写测试（启用方式由你指定）
  · 把 xx 群最近的聊天整理成任务
  · 总结一下这个迭代做了什么 / 今天完成了什么（生成 HTML/MD 报告）
`;

export async function main(): Promise<void> {
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
  const choose = async (presets: LlmPreset[]) => {
    rl.pause();
    try {
      return await selectList({ title: '配置模型（OpenAI 兼容协议）：', options: presets });
    } finally {
      rl.resume();
      nextLine.drain();
    }
  };
  /** 密钥掩码输入（仅 TTY；非 TTY 回退普通输入，向导内自动处理） */
  const askSecret: AskFn | undefined = isTTY
    ? async (promptText) => {
        rl.pause();
        try {
          return await readSecret(promptText);
        } finally {
          rl.resume();
          nextLine.drain();
        }
      }
    : undefined;

  let cfg: AgentConfig;
  try {
    cfg = await ensureConfig(ask, { choose, askSecret });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`\n配置失败: ${message}`));
    rl.close();
    process.exit(1);
  }

  // npm 更新检查：与看板/MCP 启动并发进行，banner 打印后再请示（结果缓存 24h，离线静默）
  const pendingUpdate = !updateCheckDisabled() && isTTY ? checkForUpdate({ current: pkg.version }) : null;

  let kanbanChild: ChildProcess | null = null;
  const bootKanban = new Spinner('检查 helios-kanban…').start();
  try {
    const ensured = await ensureKanbanRunning(cfg.kanbanUrl, {
      onLog: (msg) => bootKanban.setText(msg),
    });
    kanbanChild = ensured.child;
    bootKanban.stop();
    if (ensured.started) console.log(c.ok('已自动启动 helios-kanban'));
  } catch (err) {
    bootKanban.stop();
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`看板不可用: ${message}`));
    console.error(c.gray(kanbanManualStartHint()));
    rl.close();
    process.exit(1);
  }

  const boot = new Spinner('正在连接 helios-kanban MCP…').start();
  const { mcp, ok: mcpOk, hint: mcpHint } = await connectMcp(cfg);
  boot.stop();
  if (!mcpOk) {
    console.log(c.warn(`MCP 连接失败，${MCP_FALLBACK_TEXT}，看板功能不受影响。`));
    if (mcpHint) console.log(c.warn(mcpHint));
  }

  const larkStatus = checkLarkCliStatus();

  printBanner({
    version: pkg.version,
    model: cfg.llmModel,
    baseUrl: cfg.llmBaseUrl,
    kanbanUrl: cfg.kanbanUrl,
    mcp: mcpOk ? 'ok' : 'fail',
    mcpToolCount: mcpOk ? mcp.tools.length : 0,
    larkOk: larkStatus !== 'missing',
  });
  if (larkStatus === 'missing') console.log(c.warn(LARK_CLI_INSTALL_HINT));
  else if (larkStatus === 'unauthorized') console.log(c.warn(LARK_CLI_AUTH_HINT));

  const spinner = new Spinner('思考中…');

  /** 当前运行中的 agent 轮次；非 null 时 Ctrl+C 只中断任务不退出进程。 */
  let currentCtl: AbortController | null = null;

  /** 确认超时哨兵：与「用户留空 / Ctrl+C」区分，便于打印自动拒绝文案。 */
  const ASK_TIMEOUT = Symbol('ask-timeout');

  /**
   * ask 的 abort/超时感知版：闸门询问期间按 Ctrl+C = 拒绝该写操作（随后整个任务被中断）；
   * 超时未操作按拒绝处理（对齐飞书 bot：可批量 120s / 破坏性 300s）。
   */
  const askWithAbort = (promptText: string, timeoutMs?: number): Promise<string | null | typeof ASK_TIMEOUT> => {
    const ctl = currentCtl;
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

  // 写操作硬确认：闸门触发时暂停 spinner；默认拒绝；「b」开启同类免问；Ctrl+C 视为拒绝；
  // 超时自动拒绝（与飞书 bot 同语义：可批量 120s、破坏性 300s）。
  const confirmWrite: ConfirmFn = async (req) => {
    spinner.stop();
    console.log('');
    console.log(c.warn(`⚠️ 写操作请求（${kindLabel(req.kind)}）：${req.summary}`));
    console.log(c.gray(req.detail));
    const timeoutMs = req.batchKey ? 120000 : 300000;
    const batchHint = req.batchKey ? '，b=同类免问10分钟' : '';
    const ans = await askWithAbort(
      c.warn(`允许执行？[y=仅此次${batchHint} / N=取消]（${Math.round(timeoutMs / 1000)} 秒未操作自动拒绝） `),
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
      console.log(c.ok('已批准；同类写操作 10 分钟内免问（/confirm on 撤销）。'));
      return 'batch';
    }
    if (once) {
      console.log(c.ok('已批准（仅此次），继续执行。'));
      return 'once';
    }
    console.log(c.gray('已取消，操作未执行。'));
    return false;
  };

  const session = new AgentSession(cfg, mcpOk ? mcp : null, mcpOk, { userId: 'local', confirm: confirmWrite });

  const cleanup = async () => {
    spinner.stop();
    await mcp.close();
    // 不 kill 自动拉起的看板：用户可能正在用 Web UI；留下停止方式即可
    if (kanbanChild && kanbanChild.exitCode === null) {
      kanbanChild.stdout?.destroy();
      kanbanChild.stderr?.destroy();
      kanbanChild.unref();
      console.log(c.gray(`看板服务保留运行（PID ${kanbanChild.pid}），停止：kill ${kanbanChild.pid}`));
    }
    rl.close();
    process.exit(0);
  };
  const onSigint = () => {
    if (currentCtl) {
      currentCtl.abort();
      return;
    }
    console.log('\n' + c.gray('再见 👋'));
    void cleanup();
  };
  // terminal 模式下 readline 会拦截 ^C：rl 无 SIGINT listener 时默认 rl.close()，
  // 任务运行中按 Ctrl+C 会关闭输入流而非中断当前任务；两级 handler 同一函数，天然幂等。
  process.on('SIGINT', onSigint);
  rl.on('SIGINT', onSigint);

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
        console.log(c.gray(CLEARED_TEXT));
      } else if (cmd === '/confirm' || cmd === '/confirm on') {
        if (cmd === '/confirm on') {
          const n = session.revokeBatchApprovals();
          console.log(
            n ? c.ok(confirmRevokedText(n, '')) : c.gray(confirmRevokedText(0, '当前没有生效中的「同类免问」。')),
          );
        } else {
          const active = session.activeBatchApprovals();
          console.log(
            active ? c.warn(confirmStateText(active, '输入 /confirm on 恢复逐次确认')) : c.gray(confirmStateText(0, '')),
          );
        }
      } else if (cmd === '/memory') {
        for (const l of buildMemoryLines(session, c.strong('用户记忆') + c.gray(`  user=${session.memoryUserId}`))) {
          console.log(l);
        }
        console.log('');
      } else if (cmd === '/tools') {
        for (const l of buildToolsLines(
          {
            mcpOk,
            mcpTools: mcp.tools,
            kanbanHeader: c.strong('kanban MCP 工具:'),
            downNote: c.warn(`MCP 未连接（${MCP_FALLBACK_TEXT}，看板功能不受影响）。`),
            localHeader: c.strong('本地工具:'),
            bullet: '  ',
          },
          c,
        )) {
          console.log(l);
        }
      } else if (cmd === '/skills') {
        for (const l of buildSkillsLines(
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
            mcpDownNote: `连接失败（${MCP_FALLBACK_TEXT}）`,
            larkOk: larkStatus !== 'missing',
          },
          c,
        );
        console.log(c.strong('状态'));
        for (const l of lines) console.log('  ' + l);
        console.log('');
      } else if (cmd === '/config') {
        try {
          const prevKanbanUrl = cfg.kanbanUrl;
          cfg = await ensureConfig(ask, { force: true, choose, askSecret });
          session.applyConfig(cfg);
          console.log(c.ok('配置已更新，模型切换为 ') + c.strong(cfg.llmModel));
          if (cfg.kanbanUrl !== prevKanbanUrl) {
            console.log(
              c.warn(
                `看板地址已改为 ${cfg.kanbanUrl}，但 MCP 连接仍是启动时的旧实例（kanban_* 工具将操作旧看板）；` +
                  'hk_cli 已指向新地址。建议 /exit 后重启以重连 MCP。',
              ),
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(c.err(`配置失败: ${message}`));
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
        const message = err instanceof Error ? err.message : String(err);
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
