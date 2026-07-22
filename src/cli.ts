import readline from 'readline';
import { type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { c, printBanner, Spinner, renderReply, selectList } from './ui';
import { ensureConfig } from './config';
import { KanbanMcp } from './mcp';
import { AgentSession } from './session';
import { ensureKanbanRunning } from './kanban-ensure';
import { checkLarkCli } from './deps';
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
  ${c.info('/exit')}     退出（任务运行中按 Ctrl+C 只中断不退出）

  ${c.strong('试试对我说')}
  · 以后都从这个飞书地址同步任务：<链接>
  · 同步/列出我的任务（含链接会展开详情）
  · 写进 helios-kanban（确认后再创建，不自动启动）
  · 有哪些项目 / 创建一个任务：修复登录页样式 bug
  · 用 Claude 跑这个任务 / 再跟它说一句：先写测试（启用方式由你指定）
  · 把 xx 群最近的聊天整理成任务
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

  const spinner = new Spinner('思考中…');

  // 写操作硬确认：闸门触发时暂停 spinner，终端询问 y/N，默认拒绝。
  const confirmWrite: ConfirmFn = async (req) => {
    spinner.stop();
    console.log('');
    console.log(c.warn(`⚠️ 写操作请求（${req.kind}）：${req.summary}`));
    console.log(c.gray(req.detail));
    const ans = await ask(c.warn('允许执行？[y/N] '));
    const ok = Boolean(ans && /^(y|yes|确认|同意)$/i.test(ans.trim()));
    console.log(ok ? c.ok('已批准，继续执行。') : c.gray('已拒绝，操作未执行。'));
    if (ok && req.batchKey) {
      console.log(c.gray('（10 分钟内同类型写操作自动放行，不再重复询问；删除/取消/停止类仍会逐次确认）'));
    }
    spinner.start('思考中…');
    return ok;
  };

  const session = new AgentSession(cfg, mcpOk ? mcp : null, mcpOk, { userId: 'local', confirm: confirmWrite });

  /** 当前运行中的 agent 轮次；非 null 时 Ctrl+C 只中断任务不退出进程。 */
  let currentCtl: AbortController | null = null;

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
          cfg = await ensureConfig(ask, { force: true, choose });
          session.applyConfig(cfg);
          console.log(c.ok('配置已更新，模型切换为 ') + c.strong(cfg.llmModel));
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
        console.error(c.gray('可用 /config 检查模型配置，或稍后重试。\n'));
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
