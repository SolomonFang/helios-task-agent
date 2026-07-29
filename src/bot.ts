/**
 * Feishu bot entry (Hermes-style): run → wizard if needed → long-connection DM.
 *
 *   helios-task-agent bot
 *   helios-task-agent-bot
 */

import readline from 'readline';
import path from 'path';
import { currentConfig, feishuBotConfig, userEnvPath, writeEnvFile } from './config';
import { ensureBotConfig } from './config-wizard';
import { KanbanMcp, diagnoseMcpFailure } from './kanban/mcp';
import { MemoryStore, defaultDataHome } from './memory';
import { FeishuChannel, splitText, type FeishuInboundMessage } from './channels/feishu';
import { SessionRouter } from './session-router';
import { ensureKanbanRunning, stopKanbanChild } from './kanban/kanban-ensure';
import { ConfirmationManager, buildConfirmCard, buildResolvedCard } from './confirm';
import { KanbanWatcher, buildWatchEventCard } from './kanban/watcher';
import { checkLarkCli, LARK_CLI_INSTALL_HINT } from './deps';
import { checkForUpdate, promptVersionUpdate, readPkgVersion, updateCheckDisabled } from './update-check';
import { friendlyLlmError } from './llm-error';
import type { AskFn, InboundMessage, ProgressInfo } from './types';
import type { ChildProcess } from 'child_process';
import { c } from './ui';

const BOT_HELP = `Helios Task Agent（飞书私聊）

命令
/help     显示帮助
/status   健康检查（kanban / MCP / lark-cli / 推送）
/tools    列出当前可用工具
/memory   查看你的持久化记忆
/clear    清空本对话历史（不清记忆）
/stop     中断当前任务（待确认的写操作一并取消）
/confirm  查看「同类免问」状态；/confirm on 或回复「恢复确认」撤销免问

写操作安全闸门
· 建/改/删任务、启动 workspace、发飞书消息等写操作会收到确认卡片
· 「确认执行」仅此次有效；「同类免问 10 分钟」适合批量建任务；文本回复「确认 / 同类免问 / 取消」
· 免问期间回复「恢复确认」立即撤销，恢复逐次确认
· 普通写操作 120 秒、删除/取消/停止类 300 秒未操作自动拒绝

可以说
· 以后都从这个飞书地址同步任务：<链接>
· 同步/列出我的任务（含链接会展开详情）
· 写进 helios-kanban（确认后再创建，不自动启动）
· 有哪些项目 / 创建一个任务：…
· 用 Claude 跑这个任务（是否启用、用谁跑由你决定）
· 总结一下这个迭代做了什么 / 今天完成了什么（生成 HTML/MD 报告）`;

function isCommand(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  return t.split(/\s+/)[0]!.toLowerCase();
}

function createAsk(): { ask: AskFn; close: () => void } {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  const ask: AskFn = (promptText) =>
    new Promise((resolve) => {
      rl.question(promptText, (ans) => resolve(ans));
      rl.once('close', () => resolve(null));
    });
  return {
    ask,
    close: () => rl.close(),
  };
}

async function main(): Promise<void> {
  const version = readPkgVersion();
  console.log(c.strong('Helios Task Agent — 飞书机器人') + c.gray(`  v${version}`));
  console.log(c.gray(`配置目录: ${userEnvPath()}`));

  const { ask, close } = createAsk();
  let agentCfg;
  let feishuCfg;
  try {
    const ready = await ensureBotConfig(ask, { force: false });
    agentCfg = ready.agent;
    feishuCfg = ready.feishu;
    console.log(c.gray(`已加载配置: ${ready.envPath}`));
  } catch (err) {
    close();
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`配置失败: ${message}`));
    process.exit(1);
  }
  close();

  // Refresh from env after wizard
  agentCfg = currentConfig();
  feishuCfg = feishuBotConfig();

  // npm 更新检查：发现新版本先请示（结果缓存 24h，离线静默；HTA_UPDATE_CHECK=0 关闭）
  if (!updateCheckDisabled() && process.stdin.isTTY) {
    const info = await checkForUpdate({ current: version });
    if (info) {
      const { ask: upAsk, close: upClose } = createAsk();
      try {
        const outcome = await promptVersionUpdate({ info, ask: upAsk });
        if (outcome === 'updated') {
          console.log(c.ok('请重新运行 helios-task-agent bot 使用新版本。'));
          process.exit(0);
        }
      } finally {
        upClose();
      }
    }
  }

  console.log(c.gray(`模型: ${agentCfg.llmModel}  kanban: ${agentCfg.kanbanUrl}`));
  if (feishuCfg.allowedOpenIds.length) {
    console.log(c.gray(`允许 open_id: ${feishuCfg.allowedOpenIds.join(', ')}`));
  } else {
    console.log(c.warn('未设置 FEISHU_ALLOWED_OPEN_IDS：首个私聊用户将自动成为 owner 并写入白名单'));
  }
  if (!checkLarkCli()) {
    console.log(c.warn(`未检测到 lark-cli。${LARK_CLI_INSTALL_HINT}`));
  }

  let kanbanChild: ChildProcess | null = null;
  try {
    const ensured = await ensureKanbanRunning(agentCfg.kanbanUrl, {
      onLog: (msg) => console.log(c.gray(msg)),
    });
    kanbanChild = ensured.child;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`看板启动失败: ${message}`));
    console.error(c.gray('可手动执行: HOST=0.0.0.0 PORT=7964 npx -y helios-kanban'));
    console.error(c.gray('或设置 HELIOS_KANBAN_AUTO_START=0 并自行保证服务已运行。'));
    process.exit(1);
  }

  const bootLabel = '正在连接 helios-kanban MCP…';
  process.stdout.write(c.gray(bootLabel));
  const mcp = new KanbanMcp({ command: agentCfg.mcpCommand, args: agentCfg.mcpArgs });
  let mcpOk = true;
  try {
    await mcp.connect({ timeoutMs: 45000 });
    process.stdout.write(c.ok(`\rMCP 已连接（${mcp.tools.length} 个工具）          \n`));
  } catch (err) {
    mcpOk = false;
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(c.warn(`\rMCP 连接失败，降级 hk_cli：${message}\n`));
    const hint = diagnoseMcpFailure(mcp.getStderrTail());
    if (hint) process.stdout.write(c.warn(`${hint}\n`));
  }

  const memory = new MemoryStore();
  const channel = new FeishuChannel(feishuCfg);
  let watcher: KanbanWatcher | null = null;

  // 写操作确认：发确认卡片（按钮回调），失败降级为文本确认；超时自动拒绝（破坏性操作更长）；
  // 决策/超时/作废后通过 onSettled 把卡片原地更新为终态（按钮消失，避免误点）
  const confirmations = new ConfirmationManager(
    async (openId, chatId, req, id, timeoutMs) => {
      if (chatId) {
        try {
          return await channel.sendCard(chatId, buildConfirmCard(req, id, timeoutMs));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[confirm] 卡片发送失败，降级文本: ${message}`);
        }
      }
      const batchHint = req.batchKey ? '，「同类免问」10 分钟内同类操作免问' : '';
      await channel.notifyOpenId(
        openId,
        `⚠️ 写操作确认\n${req.summary}\n${req.detail}\n\n回复「确认」执行（仅此次）${batchHint}，「取消」拒绝（${Math.round(timeoutMs / 1000)} 秒超时自动拒绝）。`,
      );
      return undefined;
    },
    {
      timeoutMs: 120000,
      onTimeout: (openId, req) => {
        void channel.notifyOpenId(openId, `确认超时，已自动拒绝：${req.summary}`).catch(() => {});
      },
      onSuperseded: (openId, req) => {
        void channel
          .notifyOpenId(openId, `⚠️ 上一个确认请求已作废（被新的写操作替代）：${req.summary}`)
          .catch(() => {});
      },
      onSettled: (_openId, req, settle, cardMessageId) => {
        if (!cardMessageId) return;
        void channel.updateCard(cardMessageId, buildResolvedCard(req, settle)).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[confirm] 卡片终态更新失败: ${message}`);
        });
      },
    },
  );

  channel.onCardAction = (action) => {
    const openId = action.operator?.open_id || '';
    const value = action.action?.value || {};
    if (!openId || !value.hta_confirm) return;
    const result = confirmations.resolveFromCard(openId, String(value.hta_confirm), String(value.decision || ''));
    if (result === 'approved') void channel.notifyOpenId(openId, '✅ 已批准，正在执行…').catch(() => {});
    else if (result === 'approved_batch')
      void channel
        .notifyOpenId(openId, '✅ 已批准；同类写操作 10 分钟内免问，正在执行…（回复「恢复确认」可随时撤销）')
        .catch(() => {});
    else if (result === 'denied') void channel.notifyOpenId(openId, '已取消，操作未执行。').catch(() => {});
    else void channel.notifyOpenId(openId, '该确认已处理或已过期，无需重复操作。').catch(() => {});
  };

  // 白名单为空时：首个私聊用户自动成为 owner，写回 .env（其余用户此后被拒）
  channel.onOwnerClaim = (openId) => {
    try {
      writeEnvFile({ FEISHU_ALLOWED_OPEN_IDS: openId });
      console.log(c.ok(`首个私聊用户已成为 owner 并写入白名单: ${openId}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[owner] 白名单写入失败: ${message}`);
    }
    void channel
      .notifyOpenId(openId, '👋 你已成为本机器人实例的 owner（已写入白名单），其他私聊用户将被拒绝。')
      .catch(() => {});
  };

  // 注意：router 始终持有 mcp 对象（即使启动时降级），supervisor 重连后可热切换回来
  const router = new SessionRouter(
    agentCfg,
    mcp,
    mcpOk,
    memory,
    (openId) => (req) => confirmations.request(openId, req),
  );

  const notifyOwners = (text: string): void => {
    for (const oid of channel.allowedOpenIds()) {
      void channel.notifyOpenId(oid, text).catch(() => {});
    }
  };

  /** 每用户当前运行中的 agent 轮次（/stop 中断用）。 */
  const running = new Map<string, AbortController>();

  // MCP 健康监督：60s 探测；掉线自动降级 hk_cli 并重连（退避至 ~5 分钟），恢复后切回
  let mcpAlive = mcpOk;
  let mcpFailures = 0;
  let mcpBusy = false;
  const mcpTimer = setInterval(() => {
    if (mcpBusy) return;
    mcpBusy = true;
    void (async () => {
      try {
        await mcp.ping();
        if (!mcpAlive) {
          mcpAlive = true;
          mcpFailures = 0;
          router.setMcpOk(true);
          console.log(c.ok('MCP 已恢复'));
          notifyOwners('✅ 看板 MCP 连接已恢复');
        }
      } catch {
        mcpFailures++;
        if (mcpAlive) {
          mcpAlive = false;
          router.setMcpOk(false);
          console.log(c.warn('MCP 连接丢失，降级 hk_cli，将自动重连…'));
          notifyOwners('⚠️ 看板 MCP 连接丢失，已自动降级 hk_cli（恢复后自动切回）');
        }
        if (mcpFailures <= 3 || mcpFailures % 5 === 0) {
          try {
            await mcp.reconnect();
          } catch {
            /* 下一轮再试 */
          }
        }
      } finally {
        mcpBusy = false;
      }
    })();
  }, 60000);
  mcpTimer.unref();

  const handle = async (msg: InboundMessage) => {
    const fmsg = msg as FeishuInboundMessage;

    if (fmsg.messageType && fmsg.messageType !== 'text' && fmsg.messageType !== 'post') {
      await channel.reply(msg, '暂只支持文字与富文本（post）消息。');
      return;
    }

    const text = (msg.text || '').trim();
    if (!text) {
      await channel.reply(msg, '请发送文字内容。');
      return;
    }

    confirmations.noteChat(msg.senderId, msg.sessionId);
    // 写操作确认应答优先处理：闸门在等答复，若进串行队列会死锁
    const answer = confirmations.resolveFromText(msg.senderId, text);
    if (answer === 'approved') {
      await channel.reply(msg, '✅ 已批准，正在执行…');
      return;
    }
    if (answer === 'approved_batch') {
      await channel.reply(msg, '✅ 已批准；同类写操作 10 分钟内免问，正在执行…（回复「恢复确认」可随时撤销）');
      return;
    }
    if (answer === 'denied') {
      await channel.reply(msg, '已取消，操作未执行。');
      return;
    }

    const cmd = isCommand(text);
    if (cmd === '/help') {
      await channel.reply(msg, BOT_HELP);
      return;
    }

    // 即时命令（不进串行队列，否则 /stop 会排在它要中断的任务后面）
    if (cmd === '/stop') {
      const ctl = running.get(msg.senderId);
      const gateCancelled = confirmations.cancel(msg.senderId);
      if (ctl) {
        ctl.abort();
        running.delete(msg.senderId);
      }
      if (ctl || gateCancelled) {
        await channel.reply(msg, `⏹ 已中断当前任务${gateCancelled ? '，待确认的写操作已一并取消' : ''}。`);
      } else {
        await channel.reply(msg, '当前没有正在执行的任务。');
      }
      return;
    }

    // 「同类免问」查询/撤销：即时生效（若进串行队列，等当前任务结束才撤销就晚了）
    if (cmd === '/confirm' || text === '恢复确认') {
      const session = router.getOrCreate(msg.senderId);
      if (text === '恢复确认' || text.toLowerCase() === '/confirm on') {
        const n = session.revokeBatchApprovals();
        await channel.reply(
          msg,
          n ? `✅ 已恢复逐次确认（撤销 ${n} 类「同类免问」授权）。` : '当前没有生效中的「同类免问」，无需撤销。',
        );
      } else {
        const active = session.activeBatchApprovals();
        await channel.reply(
          msg,
          active
            ? `当前有 ${active} 类写操作处于「同类免问」中；回复「恢复确认」撤销。`
            : '当前没有生效中的「同类免问」（写操作逐次确认）。',
        );
      }
      return;
    }
    if (cmd === '/status') {
      let kanbanHealth: string;
      try {
        const res = await fetch(`${agentCfg.kanbanUrl.replace(/\/+$/, '')}/api/health`, {
          signal: AbortSignal.timeout(5000),
        });
        kanbanHealth = res.ok ? 'ok' : `HTTP ${res.status}`;
      } catch {
        kanbanHealth = '不可达';
      }
      const lines = [
        `模型: ${agentCfg.llmModel}`,
        `kanban: ${kanbanHealth}（${agentCfg.kanbanUrl}）`,
        `MCP: ${mcpAlive ? `ok（${mcp.tools.length} 个工具）` : '降级 hk_cli（自动重连中）'}`,
        `lark-cli: ${checkLarkCli() ? 'ok' : '未安装（飞书读取不可用）'}`,
        `看板推送: ${process.env.KANBAN_WATCH === '0' ? '关' : '开'}`,
      ];
      await channel.reply(msg, lines.join('\n'));
      return;
    }
    if (cmd === '/tools') {
      const session = router.getOrCreate(msg.senderId);
      await channel.reply(msg, `当前工具（${session.toolNames.length} 个）\n${session.toolNames.join('、')}`);
      return;
    }

    const openId = msg.senderId;
    // 回执：闸门挂起或已有任务在跑时立即告知，避免"消息发出去没反应"
    if (confirmations.hasPending(openId)) {
      await channel.reply(
        msg,
        '⚠️ 有未处理的写操作确认卡片：请先点按钮（或回复「确认」/「取消」，超时自动拒绝）。本条消息已排队，会按顺序处理。',
      );
    } else if (router.busy(openId)) {
      await channel.reply(msg, '📥 已收到并排队：当前任务完成后依次处理。');
    }
    await router.enqueue(openId, async () => {
      const session = router.getOrCreate(openId);

      if (cmd === '/memory') {
        await channel.reply(msg, `你的记忆\n${session.formatMemory()}`);
        return;
      }
      if (cmd === '/clear') {
        session.clearHistory();
        await channel.reply(msg, '对话历史已清空（记忆保留）。');
        return;
      }
      if (cmd) {
        await channel.reply(msg, `未知命令 ${cmd}，发送 /help 查看帮助。`);
        return;
      }

      // 进度反馈：占位消息随工具调用更新，完成后替换为最终回复（超长自动拆分）
      let progressId: string | undefined;
      try {
        progressId = await channel.sendText(msg.sessionId, '⏳ 处理中…');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[feishu] 占位消息发送失败: ${message}`);
      }
      let lastPush = 0;
      const onProgress = (info: ProgressInfo) => {
        if (!progressId) return;
        const now = Date.now();
        if (now - lastPush < 2000) return; // 飞书消息更新限流
        lastPush = now;
        const text = info.type === 'tool' ? `⏳ 处理中…（调用工具 ${info.name}）` : '⏳ 思考中…';
        void channel.updateText(progressId, text).catch(() => {});
      };
      const ctl = new AbortController();
      running.set(openId, ctl);
      try {
        const reply = await session.handleUserMessage(text, onProgress, ctl.signal);
        const chunks = splitText(reply || '(无回复)');
        if (progressId) {
          try {
            await channel.updateText(progressId, chunks[0]!);
          } catch {
            await channel.sendText(msg.sessionId, chunks[0]!);
          }
          for (const chunk of chunks.slice(1)) await channel.sendText(msg.sessionId, chunk);
        } else {
          await channel.reply(msg, reply || '(无回复)');
        }
      } catch (err) {
        if (ctl.signal.aborted) {
          await channel.reply(msg, '⏹ 已中断。');
        } else {
          const message = err instanceof Error ? err.message : String(err);
          const friendly = friendlyLlmError(message);
          await channel.reply(
            msg,
            `请求失败: ${message}${friendly ? `\n${friendly}` : ''}\n你的上一条消息未处理：「${text.slice(0, 60)}${text.length > 60 ? '…' : ''}」，可修改后重发。`,
          );
        }
      } finally {
        running.delete(openId);
      }
    });
  };

  const shutdown = async () => {
    console.log('\n' + c.gray('正在退出…'));
    clearInterval(mcpTimer);
    watcher?.stop();
    await channel.stop();
    await mcp.close();
    await stopKanbanChild(kanbanChild);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  console.log(c.ok('正在建立飞书长连接…'));
  try {
    await channel.start(handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`\n长连接失败: ${message}`));
    console.error(c.gray('请确认：开放平台事件订阅已选「长连接」、已添加 im.message.receive_v1、App 已发布/可用。'));
    console.error(c.gray('改凭证可再运行一次 helios-task-agent bot（会进入向导），或编辑 ' + userEnvPath()));
    await mcp.close();
    await stopKanbanChild(kanbanChild);
    process.exit(1);
  }
  console.log(c.ok('长连接已就绪。手机飞书搜索机器人 → 私聊即可。'));

  // 看板状态主动推送：任务完成/失败、待审批 → 飞书通知（同时注入会话上下文，可直接追问）
  if (process.env.KANBAN_WATCH !== '0') {
    const intervalSec = Math.max(15, Number(process.env.KANBAN_WATCH_INTERVAL_SEC || 60) || 60);
    watcher = new KanbanWatcher({
      kanbanUrl: agentCfg.kanbanUrl,
      projectId: agentCfg.kanbanProjectId || undefined,
      intervalMs: intervalSec * 1000,
      statePath: path.join(defaultDataHome(), 'watch-state.json'),
      notify: async (event) => {
        for (const oid of channel.allowedOpenIds()) {
          try {
            await channel.notifyCardOpenId(oid, buildWatchEventCard(event));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[watch] 卡片推送失败(${oid}): ${message}，降级纯文本`);
            try {
              await channel.notifyOpenId(oid, event.text);
            } catch (err2) {
              const msg2 = err2 instanceof Error ? err2.message : String(err2);
              console.error(`[watch] 推送失败(${oid}): ${msg2}`);
            }
          }
          // 注入会话：用户追问「刚才那个怎么样 / 帮我 review」时 agent 有上下文
          try {
            router.getOrCreate(oid).injectSystemNote(`[看板事件通知 ${new Date().toLocaleString('zh-CN')}]\n${event.text}`);
          } catch {
            /* ignore */
          }
        }
      },
      log: (msg) => console.log(c.gray(`[watch] ${msg}`)),
    });
    watcher.start();
    console.log(c.gray(`看板状态推送已开启（每 ${intervalSec}s 轮询）`));
  }

  console.log(c.gray('Ctrl+C 退出'));
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
