import readline from 'readline';
import { type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { c, printBanner, Spinner, renderReply, selectList } from './ui';
import { ensureConfig } from './config-wizard';
import { KanbanMcp } from './kanban/mcp';
import { AgentSession } from './session';
import { ensureKanbanRunning } from './kanban/kanban-ensure';
import { checkLarkCli, LARK_CLI_INSTALL_HINT } from './deps';
import { checkForUpdate, promptVersionUpdate, updateCheckDisabled } from './update-check';
import { friendlyLlmError } from './llm-error';
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

  let cfg: AgentConfig;
  try {
    cfg = await ensureConfig(ask, { choose });
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
    console.error(c.gray('可手动: HOST=0.0.0.0 PORT=7964 npx -y helios-kanban'));
    rl.close();
    process.exit(1);
  }

  const boot = new Spinner('正在连接 helios-kanban MCP…').start();
  const mcp = new KanbanMcp({ command: cfg.mcpCommand, args: cfg.mcpArgs });
  let mcpOk = true;
  try {
    await mcp.connect({ timeoutMs: 45000 });
  } catch (err) {
    mcpOk = false;
    if (process.env.HTA_DEBUG) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error(`\n[mcp] ${e.stack || e.message}`);
    }
  }
  boot.stop();

  const larkOk = checkLarkCli();

  printBanner({
    version: pkg.version,
    model: cfg.llmModel,
    baseUrl: cfg.llmBaseUrl,
    kanbanUrl: cfg.kanbanUrl,
    mcp: mcpOk ? 'ok' : 'fail',
    mcpToolCount: mcpOk ? mcp.tools.length : 0,
    larkOk,
  });
  if (!larkOk) console.log(c.warn(LARK_CLI_INSTALL_HINT));

  // 发现新版本则请示是否更新（用户选 y 会执行 npm i -g；更新后需重启生效）
  if (pendingUpdate) {
    const info = await pendingUpdate;
    if (info) {
      const outcome = await promptVersionUpdate({ info, ask, log: (m) => console.log(c.gray(m)) });
      if (outcome === 'updated') {
        console.log(c.ok('请重新运行 helios-task-agent 使用新版本。'));
        await mcp.close();
        rl.close();
        process.exit(0);
      }
    }
  }

  const spinner = new Spinner('思考中…');

  /** 当前运行中的 agent 轮次；非 null 时 Ctrl+C 只中断任务不退出进程。 */
  let currentCtl: AbortController | null = null;

  /** ask 的 abort 感知版：闸门询问期间按 Ctrl+C = 拒绝该写操作（随后整个任务被中断）。 */
  const askWithAbort = (promptText: string): Promise<string | null> => {
    const ctl = currentCtl;
    if (!ctl) return ask(promptText);
    if (ctl.signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = () => resolve(null);
      ctl.signal.addEventListener('abort', onAbort, { once: true });
      void ask(promptText).then((a) => {
        ctl.signal.removeEventListener('abort', onAbort);
        resolve(a);
      });
    });
  };

  // 写操作硬确认：闸门触发时暂停 spinner；默认拒绝；「b」开启同类免问；Ctrl+C 视为拒绝。
  const confirmWrite: ConfirmFn = async (req) => {
    spinner.stop();
    console.log('');
    console.log(c.warn(`⚠️ 写操作请求（${req.kind}）：${req.summary}`));
    console.log(c.gray(req.detail));
    const batchHint = req.batchKey ? '，b=同类免问10分钟' : '';
    const ans = await askWithAbort(c.warn(`允许执行？[y=仅此次${batchHint} / N=拒绝] `));
    const t = (ans || '').trim().toLowerCase();
    const batch = Boolean(req.batchKey) && /^(b|batch|都|都允许|免问)$/.test(t);
    const once = !batch && /^(y|yes|确认|同意)$/.test(t);
    spinner.start('思考中…（Ctrl+C 中断）');
    if (batch) {
      console.log(c.ok('已批准；同类写操作 10 分钟内免问（/confirm on 撤销）。'));
      return 'batch';
    }
    if (once) {
      console.log(c.ok('已批准（仅此次），继续执行。'));
      return 'once';
    }
    console.log(c.gray('已拒绝，操作未执行。'));
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
  process.on('SIGINT', () => {
    if (currentCtl) {
      currentCtl.abort();
      return;
    }
    console.log('\n' + c.gray('再见 👋'));
    void cleanup();
  });

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
        console.log(c.gray('对话历史已清空（记忆保留）。'));
      } else if (cmd === '/confirm' || cmd === '/confirm on') {
        if (cmd === '/confirm on') {
          const n = session.revokeBatchApprovals();
          console.log(
            n ? c.ok(`已恢复逐次确认（撤销 ${n} 类「同类免问」授权）。`) : c.gray('当前没有生效中的「同类免问」。'),
          );
        } else {
          const active = session.activeBatchApprovals();
          console.log(
            active
              ? c.warn(`当前有 ${active} 类写操作处于「同类免问」中；输入 /confirm on 恢复逐次确认。`)
              : c.gray('当前没有生效中的「同类免问」（写操作逐次确认）。'),
          );
        }
      } else if (cmd === '/memory') {
        console.log(c.strong('用户记忆') + c.gray(`  user=${session.memoryUserId}`));
        console.log(session.formatMemory());
        console.log('');
      } else if (cmd === '/tools') {
        if (!mcpOk) {
          console.log(c.warn('MCP 未连接（降级模式），本地工具：lark_cli / hk_cli / repo_fs / memory_*。'));
        } else {
          console.log(c.strong('kanban MCP 工具:'));
          for (const t of mcp.tools) {
            console.log(`  ${c.info('kanban_' + t.name)}  ${c.gray((t.description || '').split('\n')[0])}`);
          }
          console.log(c.strong('本地工具:'));
          for (const t of ['lark_cli', 'hk_cli', 'repo_fs', 'memory_set', 'memory_get', 'memory_delete', 'memory_note']) {
            console.log(`  ${c.info(t)}`);
          }
        }
      } else if (cmd === '/status') {
        let kanbanHealth: string;
        try {
          const res = await fetch(`${cfg.kanbanUrl.replace(/\/+$/, '')}/api/health`, {
            signal: AbortSignal.timeout(5000),
          });
          kanbanHealth = res.ok ? 'ok' : `HTTP ${res.status}`;
        } catch {
          kanbanHealth = '不可达';
        }
        console.log(c.strong('状态'));
        console.log(`  模型: ${c.info(cfg.llmModel)}`);
        console.log(`  kanban: ${kanbanHealth === 'ok' ? c.ok('ok') : c.warn(kanbanHealth)}（${cfg.kanbanUrl}）`);
        console.log(
          `  MCP: ${mcpOk ? c.ok(`ok（${mcp.tools.length} 个工具）`) : c.warn('连接失败（降级 hk_cli）')}`,
        );
        console.log(`  lark-cli: ${larkOk ? c.ok('ok') : c.warn('未安装（飞书读取不可用）')}`);
        console.log('');
      } else if (cmd === '/config') {
        try {
          const prevKanbanUrl = cfg.kanbanUrl;
          cfg = await ensureConfig(ask, { force: true, choose });
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
        console.error(c.err(`\n请求失败: ${message}`));
        const friendly = friendlyLlmError(message);
        if (friendly) console.error(c.warn(friendly));
        console.error(
          c.gray(`上一条内容「${line.slice(0, 60)}${line.length > 60 ? '…' : ''}」未发送成功，可修改后重发；也可用 /config 检查模型配置。\n`),
        );
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
