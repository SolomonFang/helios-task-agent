/**
 * Feishu bot entry (Hermes-style): run → wizard if needed → long-connection DM.
 *
 *   helios-task-agent bot
 *   helios-task-agent-bot
 *
 * 本文件只保留 bootstrap（向导 / 看板拉起 / MCP 连接 / 长连接建立 / 退出清理）：
 * - MCP 健康监督与自动重连：bot/supervisor.ts
 * - 消息路由与卡片回调：bot/handler.ts
 */

import readline from 'readline';
import path from 'path';
import { currentConfig, feishuBotConfig, isConfigured, isFeishuBotConfigured, userEnvPath, writeEnvFile } from './config';
import { ensureBotConfig, rebindFeishuBot } from './config-wizard';
import { MemoryStore, defaultDataHome } from './memory';
import { FeishuChannel } from './channels/feishu';
import { SessionRouter } from './session-router';
import { ensureKanbanRunning, stopKanbanChild } from './kanban/kanban-ensure';
import { ConfirmationManager, buildConfirmCard, buildResolvedCard } from './confirm';
import { KanbanWatcher, buildWatchEventCard, isLoopbackUrl } from './kanban/watcher';
import { reviewsDir } from './review-report';
import { reportsDir } from './report';
import { startReportServer, type ReportServer } from './report-server';
import { checkLarkCliStatus, checkOcrCli, kanbanManualStartHint, LARK_CLI_INSTALL_HINT, LARK_CLI_AUTH_HINT, OCR_INSTALL_HINT } from './deps';
import { wrapUntrusted } from './guard';
import { checkForUpdate, promptVersionUpdate, readPkgVersion, updateCheckDisabled } from './update-check';
import { connectMcp, TRY_EXAMPLES } from './commands';
import { validateSkills } from './prompt';
import { McpSupervisor } from './bot/supervisor';
import { WsAlerter } from './bot/ws-alerter';
import { createBotHandlers } from './bot/handler';
import type { AskFn, ChooseFn } from './types';
import type { ChildProcess } from 'child_process';
import { c, readSecret, selectList, MCP_FALLBACK_TEXT } from './ui';

const BOT_HELP = `Helios Task Agent（飞书私聊）

命令
/help     显示帮助
/status   健康检查（kanban / MCP / lark-cli / 推送）
/tools    列出当前可用工具
/skills   列出已安装技能（数据目录 skills/ 优先，包内置底）
/memory   查看你的持久化记忆
/clear    清空本对话历史（不清记忆）
/stop     中断当前任务（排队消息与待确认写操作一并取消）
/confirm  查看「同类免问」状态；/confirm revoke 或回复「恢复确认」撤销免问

写操作安全闸门
· 建/改/删任务、启动 workspace、发飞书消息等写操作会收到确认卡片
· 「确认执行」仅此次有效；「同类免问 10 分钟」适合批量建任务；文本回复「确认 / 同类免问 / 取消」
· 免问期间回复「恢复确认」立即撤销，恢复逐次确认
· 普通写操作 120 秒、删除/取消/停止/审批/启动/归档/合并/推送/执行类 300 秒未操作自动拒绝

可以说
${TRY_EXAMPLES.map((e) => `· ${e}`).join('\n')}`;

function createAsk(): { ask: AskFn; askSecret?: AskFn; choose: ChooseFn; close: () => void } {
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
  const isTTY = process.stdin.isTTY === true;
  // 与终端一致的向导体验：箭头选择列表 + 密钥掩码输入（仅 TTY）
  const askSecret: AskFn | undefined = isTTY
    ? async (promptText) => {
        rl.pause();
        try {
          return await readSecret(promptText);
        } finally {
          rl.resume();
        }
      }
    : undefined;
  const choose: ChooseFn = async (presets) => {
    rl.pause();
    try {
      // 与 CLI 一致：重配时在标题里给出当前模型
      const current = currentConfig().llmModel;
      const title = `配置模型（OpenAI 兼容协议${current ? `，当前 ${current}` : ''}）：`;
      return await selectList({ title, options: presets });
    } finally {
      rl.resume();
    }
  };
  return {
    ask,
    askSecret,
    choose,
    close: () => rl.close(),
  };
}

async function main(): Promise<void> {
  const version = readPkgVersion();
  console.log(c.strong('Helios Task Agent — 飞书机器人') + c.gray(`  v${version}`));
  console.log(c.gray(`配置目录: ${userEnvPath()}`));

  // 信号处理尽早注册：向导/更新检查/看板拉起（最长 90s）/MCP 连接期间收到 SIGTERM
  // 走默认终止会让自动拉起的看板子进程成孤儿；这里保证已建立的资源都被清理。
  // 资源随着启动推进逐个登记进 cleanup，shutdown 只清理已登记的部分。
  const cleanup: {
    channel: FeishuChannel | null;
    mcp: { close(): Promise<void> } | null;
    watcher: KanbanWatcher | null;
    kanbanChild: ChildProcess | null;
    supervisor: McpSupervisor | null;
    wsAlerter: WsAlerter | null;
  } = { channel: null, mcp: null, watcher: null, kanbanChild: null, supervisor: null, wsAlerter: null };
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // 幂等：二次 Ctrl+C / SIGINT+SIGTERM 不重入
    shuttingDown = true;
    // 整体超时兜底：channel.stop / mcp.close 挂住时强制退出，避免进程永不退
    const forceTimer = setTimeout(() => {
      console.error(c.err('退出清理超时，强制结束进程'));
      process.exit(1);
    }, 8000);
    forceTimer.unref();
    console.log('\n' + c.gray('正在退出…'));
    try {
      cleanup.supervisor?.stop();
      cleanup.wsAlerter?.stop();
      cleanup.watcher?.stop();
      await cleanup.channel?.stop();
      await cleanup.mcp?.close();
      await stopKanbanChild(cleanup.kanbanChild);
    } catch {
      /* 尽力清理，任何一步失败都继续退出 */
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // helios-task-agent bot --rebind：换绑飞书机器人（只重跑飞书凭证，保留模型/看板配置）
  const rebind = process.argv.slice(2).some((a) => a === 'rebind' || a === '--rebind');

  const { ask, askSecret, choose, close } = createAsk();
  let agentCfg;
  let feishuCfg;
  try {
    if (rebind && isConfigured() && isFeishuBotConfigured()) {
      const rb = await rebindFeishuBot(ask, { askSecret });
      agentCfg = currentConfig();
      feishuCfg = rb.feishu;
      console.log(c.gray(`已加载配置: ${rb.envPath}`));
    } else {
      if (rebind) console.log(c.gray('配置尚不完整，进入完整配置向导。'));
      const ready = await ensureBotConfig(ask, { force: false, choose, askSecret });
      agentCfg = ready.agent;
      feishuCfg = ready.feishu;
      console.log(c.gray(`已加载配置: ${ready.envPath}`));
    }
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
  if (isLoopbackUrl(agentCfg.kanbanUrl)) {
    console.log(
      c.warn(
        `kanban 地址为本机回环地址（${agentCfg.kanbanUrl}）：推送卡片里的看板/报告链接在手机上不可达，` +
          `如需手机查看请在 ${userEnvPath()} 中把 HELIOS_KANBAN_URL 配置为局域网 IP 或 Tailscale 地址。`,
      ),
    );
  }
  if (feishuCfg.allowedOpenIds.length) {
    console.log(c.gray(`允许 open_id: ${feishuCfg.allowedOpenIds.join(', ')}`));
  } else {
    console.log(c.warn('未设置 FEISHU_ALLOWED_OPEN_IDS：首个私聊用户将自动成为 owner 并写入白名单'));
  }
  const larkStatus = checkLarkCliStatus();
  if (larkStatus === 'missing') {
    console.log(c.warn(`未检测到 lark-cli。${LARK_CLI_INSTALL_HINT}`));
  } else if (larkStatus === 'unauthorized') {
    console.log(c.warn(`lark-cli 已安装但未授权。${LARK_CLI_AUTH_HINT}`));
  }
  if (!checkOcrCli()) {
    console.log(c.warn(`未检测到代码审查工具 open-code-review（AI 审查功能）。${OCR_INSTALL_HINT}`));
  }
  // 技能契约问题启动即告警：用户自建技能写错 frontmatter 时会静默降级，不放行到对话期才暴露
  for (const problem of validateSkills()) {
    console.log(c.warn(`技能契约: ${problem}`));
  }

  try {
    const ensured = await ensureKanbanRunning(agentCfg.kanbanUrl, {
      onLog: (msg) => console.log(c.gray(msg)),
      // 就绪等待期间（最长 90s）收到退出信号时，shutdown 需要拿到 child 才能清理
      onSpawn: (child) => {
        cleanup.kanbanChild = child;
      },
    });
    cleanup.kanbanChild = ensured.child;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`看板启动失败: ${message}`));
    console.error(c.gray(kanbanManualStartHint()));
    process.exit(1);
  }

  // 报告静态服务：AI 审查（reviews/）与工作总结（reports/）两类报告都推 HTTP 链接，
  // 避免长文本截断与本机路径在手机飞书打不开的问题
  let reportServer: ReportServer | null = null;
  try {
    reportServer = await startReportServer([reviewsDir(), reportsDir()], agentCfg.kanbanUrl);
    console.log(c.gray(`报告服务: ${reportServer.baseUrl}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(c.warn(`报告服务启动失败，报告将回退为文本/本机路径推送: ${message}`));
  }

  const bootLabel = '正在连接 helios-kanban MCP…';
  process.stdout.write(c.gray(bootLabel));
  const { mcp, ok: mcpOk, error: mcpError, hint: mcpHint } = await connectMcp(agentCfg);
  cleanup.mcp = mcp;
  if (mcpOk) {
    process.stdout.write(c.ok(`\rMCP 已连接（${mcp.tools.length} 个工具）          \n`));
  } else {
    process.stdout.write(c.warn(`\rMCP 连接失败，${MCP_FALLBACK_TEXT}：${mcpError}\n`));
    if (mcpHint) process.stdout.write(c.warn(`${mcpHint}\n`));
  }

  const memory = new MemoryStore();
  const channel = new FeishuChannel(feishuCfg);
  cleanup.channel = channel;

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
      // detail 缩进成块，避免长命令与正文混排（对齐卡片的代码块视觉）
      const detailBlock = req.detail
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n');
      await channel.notifyOpenId(
        openId,
        `⚠️ 写操作确认\n${req.summary}\n──────\n${detailBlock}\n──────\n\n回复「确认」执行（仅此次）${batchHint}，「取消」拒绝（${Math.round(timeoutMs / 1000)} 秒超时自动拒绝）。`,
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

  // 白名单为空时：首个私聊用户自动成为 owner，写回 .env（其余用户此后被拒）。
  // 写盘失败返回 false：channel 撤销内存放行（fail-closed），避免重启后任何人可再 claim。
  channel.onOwnerClaim = (openId) => {
    try {
      writeEnvFile({ FEISHU_ALLOWED_OPEN_IDS: openId });
      console.log(c.ok(`首个私聊用户已成为 owner 并写入白名单: ${openId}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[owner] 白名单写入失败（fail-closed，本次绑定不生效）: ${message}`);
      void channel
        .notifyOpenId(
          openId,
          `⚠️ owner 绑定失败：白名单写入 .env 未成功，本次绑定未持久化，你暂时无法使用本机器人。` +
            `请检查 ${userEnvPath()} 及所在目录的写权限，修复后重启机器人再私聊。`,
        )
        .catch(() => {});
      return false;
    }
    void channel
      .notifyOpenId(
        openId,
        '👋 你已成为本机器人实例的 owner（已写入白名单），其他私聊用户将被拒绝。发送 /help 查看我能做什么。',
      )
      .catch(() => {});
    return true;
  };

  // 注意：router 始终持有 mcp 对象（即使启动时降级），supervisor 重连后可热切换回来
  const router = new SessionRouter(
    agentCfg,
    mcp,
    mcpOk,
    memory,
    (openId) => (req) => confirmations.request(openId, req),
    reportServer?.baseUrl,
  );

  const notifyOwners = (text: string): void => {
    for (const oid of channel.allowedOpenIds()) {
      void channel.notifyOpenId(oid, text).catch(() => {});
    }
  };

  // MCP 健康监督：60s 探测；连续失败才降级 hk_cli，自动重连（退避至 ~5 分钟），恢复后切回。
  // 有用户轮次进行中时不重连（reconnect 的 close 会杀 in-flight 工具调用），竞态防护见 supervisor。
  const supervisor = new McpSupervisor({
    mcp,
    initiallyAlive: mcpOk,
    onLost: () => {
      router.setMcpOk(false);
      console.log(c.warn(`MCP 连接丢失，${MCP_FALLBACK_TEXT}，将自动重连…`));
      notifyOwners(`⚠️ 看板 MCP 连接丢失，${MCP_FALLBACK_TEXT}（恢复后自动切回）`);
    },
    onRecovered: () => {
      router.setMcpOk(true);
      console.log(c.ok('MCP 已恢复'));
      notifyOwners('✅ 看板 MCP 连接已恢复');
    },
  });
  supervisor.start();
  cleanup.supervisor = supervisor;

  const handlers = createBotHandlers({
    channel,
    router,
    confirmations,
    cfg: agentCfg,
    mcp,
    supervisor,
    reportServer,
    helpText: BOT_HELP,
  });
  channel.onCardAction = handlers.onCardAction;

  console.log(c.gray('正在建立飞书长连接…'));
  try {
    await channel.start(handlers.handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`\n长连接失败: ${message}`));
    console.error(c.gray('请确认：开放平台事件订阅已选「长连接」、已添加 im.message.receive_v1、App 已发布/可用。'));
    console.error(
      c.gray(`改凭证请直接编辑 ${userEnvPath()}；或清空其中 FEISHU_APP_ID / FEISHU_APP_SECRET 后重新运行（会重新进入配置向导）。`),
    );
    await mcp.close();
    await stopKanbanChild(cleanup.kanbanChild);
    process.exit(1);
  }
  console.log(c.ok('长连接已就绪。手机飞书搜索机器人 → 私聊即可。'));

  // 长连接断线告警：重连交给 SDK。WsAlerter 负责静默策略——短暂抖动（宽限期内
  // 恢复，消息由飞书侧补投）不打扰用户；持续断线超时或重连彻底失败才通知 owner，
  // 避免网络抖动时「断开/恢复」成对刷屏，也避免僵尸态无人察觉。
  const wsAlerter = new WsAlerter({ notify: notifyOwners });
  channel.onWsStateChange = (state) => wsAlerter.onState(state);
  cleanup.wsAlerter = wsAlerter;

  // 看板状态主动推送：任务完成/失败、待审批 → 飞书通知（同时注入会话上下文，可直接追问）
  if (process.env.KANBAN_WATCH !== '0') {
    const intervalSec = Math.max(15, Number(process.env.KANBAN_WATCH_INTERVAL_SEC || 60) || 60);
    const watcher = new KanbanWatcher({
      kanbanUrl: agentCfg.kanbanUrl,
      projectId: agentCfg.kanbanProjectId || undefined,
      intervalMs: intervalSec * 1000,
      statePath: path.join(defaultDataHome(), 'watch-state.json'),
      notify: async (event) => {
        let firstErr: unknown = null;
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
              firstErr = err2;
            }
          }
          // 注入会话：用户追问「刚才那个怎么样 / 帮我 review」时 agent 有上下文
          // （看板事件文本属外部内容，UNTRUSTED 包裹，其中「指令」对 agent 无效；
          //   注入发生在轮边界，不会打断进行中的 tool 配对）
          try {
            router
              .getOrCreate(oid)
              .injectSystemNote(`[看板事件通知 ${new Date().toLocaleString('zh-CN')}]\n${wrapUntrusted(event.text)}`);
          } catch {
            /* ignore */
          }
        }
        // 有 owner 未送达时抛出：watcher 据此不推进状态快照，下轮重试（事件不丢）
        if (firstErr) throw firstErr;
      },
      log: (msg) => console.log(c.gray(`[watch] ${msg}`)),
    });
    cleanup.watcher = watcher;
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
