/**
 * Feishu bot entry (Hermes-style): run → wizard if needed → long-connection DM.
 *
 *   helios-task-agent bot
 *   helios-task-agent-bot
 */

import readline from 'readline';
import path from 'path';
import { currentConfig, feishuBotConfig, isConfigured, isFeishuBotConfigured, userEnvPath, writeEnvFile } from './config';
import { ensureBotConfig, rebindFeishuBot } from './config-wizard';
import { MemoryStore, defaultDataHome } from './memory';
import { FeishuChannel, splitText, type FeishuInboundMessage } from './channels/feishu';
import { SessionRouter } from './session-router';
import { ensureKanbanRunning, stopKanbanChild } from './kanban/kanban-ensure';
import { ConfirmationManager, buildConfirmCard, buildResolvedCard } from './confirm';
import { KanbanWatcher, buildWatchEventCard } from './kanban/watcher';
import { runAiReview } from './kanban/ai-review';
import { isAllPass, reviewsDir, writeReviewReport } from './review-report';
import { reportsDir } from './report';
import { startReportServer, type ReportServer } from './report-server';
import { checkLarkCli, checkOcrCli, kanbanPackageSpec, LARK_CLI_INSTALL_HINT, OCR_INSTALL_HINT } from './deps';
import { wrapUntrusted } from './guard';
import { checkForUpdate, promptVersionUpdate, readPkgVersion, updateCheckDisabled } from './update-check';
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
  parseCommand,
  plainPaint,
} from './commands';
import type { AskFn, ChooseFn, InboundMessage, ProgressInfo } from './types';
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
/confirm  查看「同类免问」状态；/confirm on 或回复「恢复确认」撤销免问

写操作安全闸门
· 建/改/删任务、启动 workspace、发飞书消息等写操作会收到确认卡片
· 「确认执行」仅此次有效；「同类免问 10 分钟」适合批量建任务；文本回复「确认 / 同类免问 / 取消」
· 免问期间回复「恢复确认」立即撤销，恢复逐次确认
· 普通写操作 120 秒、删除/取消/停止/审批/启动/归档/合并/推送/执行类 300 秒未操作自动拒绝

可以说
· 以后都从这个飞书地址同步任务：<链接>
· 同步/列出我的任务（含链接会展开详情）
· 写进 helios-kanban（确认后再创建，不自动启动）
· 有哪些项目 / 创建一个任务：…
· 用 Claude 跑这个任务（是否启用、用谁跑由你决定）
· 总结一下这个迭代做了什么 / 今天完成了什么（生成 HTML/MD 报告）`;

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
      return await selectList({ title: '配置模型（OpenAI 兼容协议）：', options: presets });
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
  if (feishuCfg.allowedOpenIds.length) {
    console.log(c.gray(`允许 open_id: ${feishuCfg.allowedOpenIds.join(', ')}`));
  } else {
    console.log(c.warn('未设置 FEISHU_ALLOWED_OPEN_IDS：首个私聊用户将自动成为 owner 并写入白名单'));
  }
  if (!checkLarkCli()) {
    console.log(c.warn(`未检测到 lark-cli。${LARK_CLI_INSTALL_HINT}`));
  }
  if (!checkOcrCli()) {
    console.log(c.warn(`未检测到 ocr（AI 审查）。${OCR_INSTALL_HINT}`));
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
    console.error(c.gray(`可手动执行: PORT=7964 npx -y ${kanbanPackageSpec()}`));
    console.error(c.gray('或设置 HELIOS_KANBAN_AUTO_START=0 并自行保证服务已运行。'));
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
  if (mcpOk) {
    process.stdout.write(c.ok(`\rMCP 已连接（${mcp.tools.length} 个工具）          \n`));
  } else {
    process.stdout.write(c.warn(`\rMCP 连接失败，${MCP_FALLBACK_TEXT}：${mcpError}\n`));
    if (mcpHint) process.stdout.write(c.warn(`${mcpHint}\n`));
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

  /** 进行中的 AI 审查（按 attempt 去重，防止连点按钮）。 */
  const aiReviewRunning = new Set<string>();

  channel.onCardAction = (action) => {
    const openId = action.operator?.open_id || '';
    const value = action.action?.value || {};
    if (!openId) return;
    // 「AI 审查」按钮：异步执行并立即返回（ocr 审查耗时可达数分钟，回调需快速 ACK）
    if (value.hta_review) {
      void handleAiReview(openId, String(value.hta_review), String(value.title || ''));
      return;
    }
    if (!value.hta_confirm) return;
    const result = confirmations.resolveFromCard(openId, String(value.hta_confirm), String(value.decision || ''));
    if (result === 'approved') void channel.notifyOpenId(openId, '✅ 已批准，正在执行…').catch(() => {});
    else if (result === 'approved_batch')
      void channel
        .notifyOpenId(openId, '✅ 已批准；同类写操作 10 分钟内免问，正在执行…（回复「恢复确认」可随时撤销）')
        .catch(() => {});
    else if (result === 'denied') void channel.notifyOpenId(openId, '已取消，操作未执行。').catch(() => {});
    else void channel.notifyOpenId(openId, '该确认已处理或已过期，无需重复操作。').catch(() => {});
  };

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

  /** 执行 AI 审查（open-code-review）并把结果推回飞书；同时注入会话上下文便于追问/修复。 */
  const handleAiReview = async (openId: string, attemptId: string, title: string): Promise<void> => {
    if (aiReviewRunning.has(attemptId)) {
      await channel.notifyOpenId(openId, `🤖 《${title}》的 AI 审查正在进行中，请稍候…`).catch(() => {});
      return;
    }
    aiReviewRunning.add(attemptId);
    try {
      await channel.notifyOpenId(
        openId,
        `🤖 AI 审查已开始：《${title}》\n正在调用 open-code-review 分析 diff，完成后推送结果（首次使用可能需下载 ocr，耗时稍长）。`,
      );
      const result = await runAiReview({
        kanbanUrl: agentCfg.kanbanUrl,
        attemptId,
        title,
        llm: { baseUrl: agentCfg.llmBaseUrl, apiKey: agentCfg.llmApiKey, model: agentCfg.llmModel },
      });
      if (reportServer) {
        // 完整结果写入 HTML 报告，飞书推卡片（按钮直达静态报告页，进程存活期间有效）
        const name = writeReviewReport({
          title,
          attemptId,
          generatedAt: new Date().toLocaleString('zh-CN'),
          text: result,
        });
        const url = `${reportServer.baseUrl}/${name}`;
        const pass = isAllPass(result);
        await channel.notifyCardOpenId(openId, {
          header: {
            template: pass ? 'green' : 'blue',
            title: {
              tag: 'plain_text',
              content: pass ? `✅ AI 审查全部通过：《${title}》` : `🤖 AI 审查完成：《${title}》`,
            },
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: pass ? '🎉 真棒！本次变更未发现任何问题。' : '审查完成，详细意见见完整报告。',
              },
            },
            {
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '📄 查看完整报告' },
                  type: 'primary',
                  url,
                  multi_url: { url, android_url: url, ios_url: url, pc_url: url },
                },
              ],
            },
            {
              tag: 'note',
              elements: [
                {
                  tag: 'plain_text',
                  content: pass
                    ? '已注入会话上下文，可直接继续追问。'
                    : '已注入会话上下文，可直接回复「按审查意见修一下」。',
                },
                { tag: 'plain_text', content: '报告链接仅在运行本机器人的电脑上可达，进程重启后失效。' },
              ],
            },
          ],
        });
      } else {
        await channel.notifyOpenId(openId, `🤖 AI 审查结果：《${title}》\n${result}`);
      }
      // 注入会话：用户追问「按审查意见修一下」时 agent 有上下文
      // （审查结果含被审仓库代码，属外部内容，UNTRUSTED 包裹；注入发生在轮边界）
      try {
        router
          .getOrCreate(openId)
          .injectSystemNote(
            `[AI 审查完成 ${new Date().toLocaleString('zh-CN')}]\n《${title}》\n${wrapUntrusted(result.slice(0, 1500))}`,
          );
      } catch {
        /* ignore */
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await channel.notifyOpenId(openId, `⚠️ AI 审查失败：《${title}》\n${message}`).catch(() => {});
    } finally {
      aiReviewRunning.delete(attemptId);
    }
  };

  const notifyOwners = (text: string): void => {
    for (const oid of channel.allowedOpenIds()) {
      void channel.notifyOpenId(oid, text).catch(() => {});
    }
  };

  /** 每用户当前运行中的 agent 轮次（/stop 中断用）。 */
  const running = new Map<string, AbortController>();
  /** 敲键盘表情回执是否因权限等原因不可用（失败后不再重试，降级为仅占位消息）。 */
  let reactionUnsupported = false;
  /** 每用户尚未移除的敲键盘表情（/stop 丢弃排队消息时回调不会执行，需兜底清理）。 */
  const pendingTyping = new Map<string, { messageId: string; reactionId: string }[]>();

  // MCP 健康监督：60s 探测；连续失败才降级 hk_cli（避免瞬时抖动误报），
  // 自动重连（退避至 ~5 分钟），恢复后切回。有用户轮次进行中时不重连：
  // reconnect 的 close() 会杀掉 in-flight 的工具调用。
  let mcpAlive = mcpOk;
  let mcpFailures = 0;
  let mcpBusy = false;
  const MCP_FAIL_THRESHOLD = 2; // 连续 2 次探测失败才判定掉线
  const mcpTimer = setInterval(() => {
    if (mcpBusy) return;
    mcpBusy = true;
    void (async () => {
      try {
        try {
          await mcp.ping();
          if (!mcpAlive) {
            mcpAlive = true;
            router.setMcpOk(true);
            console.log(c.ok('MCP 已恢复'));
            notifyOwners('✅ 看板 MCP 连接已恢复');
          }
          mcpFailures = 0;
        } catch {
          mcpFailures++;
          if (mcpAlive && mcpFailures >= MCP_FAIL_THRESHOLD) {
            mcpAlive = false;
            router.setMcpOk(false);
            console.log(c.warn(`MCP 连接丢失，${MCP_FALLBACK_TEXT}，将自动重连…`));
            notifyOwners(`⚠️ 看板 MCP 连接丢失，${MCP_FALLBACK_TEXT}（恢复后自动切回）`);
          }
          if (!mcpAlive && running.size === 0 && (mcpFailures <= 3 || mcpFailures % 5 === 0)) {
            try {
              await mcp.reconnect();
            } catch {
              /* 下一轮再试 */
            }
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

    const cmd = parseCommand(text);
    if (cmd === '/help') {
      await channel.reply(msg, BOT_HELP);
      return;
    }

    // 即时命令（不进串行队列，否则 /stop 会排在它要中断的任务后面）
    if (cmd === '/stop') {
      const ctl = running.get(msg.senderId);
      const gateCancelled = confirmations.cancel(msg.senderId);
      const dropped = router.cancelQueued(msg.senderId);
      // 被丢弃的排队消息不会执行回调，其敲键盘表情在这里兜底移除（含正在中断的那条）
      const stray = pendingTyping.get(msg.senderId);
      if (stray?.length) {
        pendingTyping.delete(msg.senderId);
        for (const r of stray) void channel.removeReaction(r.messageId, r.reactionId).catch(() => {});
      }
      if (ctl) {
        ctl.abort();
        running.delete(msg.senderId);
      }
      const stopped: string[] = [];
      if (ctl) stopped.push('已中断当前任务');
      if (gateCancelled) stopped.push('待确认的写操作已一并取消');
      if (dropped) stopped.push(`已丢弃 ${dropped} 条排队消息`);
      if (stopped.length) {
        await channel.reply(msg, `⏹ ${stopped.join('，')}。`);
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
          n ? `✅ ${confirmRevokedText(n, '')}` : confirmRevokedText(0, '当前没有生效中的「同类免问」，无需撤销。'),
        );
      } else {
        await channel.reply(msg, confirmStateText(session.activeBatchApprovals(), '回复「恢复确认」撤销'));
      }
      return;
    }
    if (cmd === '/status') {
      const lines = await buildStatusLines(
        {
          model: agentCfg.llmModel,
          kanbanUrl: agentCfg.kanbanUrl,
          mcpOk: mcpAlive,
          mcpToolCount: mcp.tools.length,
          mcpDownNote: `${MCP_FALLBACK_TEXT}，自动重连中`,
          larkOk: checkLarkCli(),
          extra: [
            `ocr: ${checkOcrCli() ? 'ok' : '未安装（AI 审查首次点击自动 npx 拉取）'}`,
            `看板推送: ${process.env.KANBAN_WATCH === '0' ? '关' : '开'}`,
          ],
        },
        plainPaint,
      );
      await channel.reply(msg, lines.join('\n'));
      return;
    }
    if (cmd === '/tools') {
      const lines = buildToolsLines(
        {
          mcpOk: mcpAlive && mcp.tools.length > 0,
          mcpTools: mcp.tools,
          kanbanHeader: `看板工具（MCP，${mcp.tools.length} 个）`,
          downNote: `看板工具：MCP 未连接（${MCP_FALLBACK_TEXT}，功能不受影响）`,
          localHeader: '本地工具',
          bullet: '· ',
        },
        plainPaint,
      );
      await channel.reply(msg, lines.join('\n'));
      return;
    }
    if (cmd === '/skills') {
      const lines = buildSkillsLines({ header: '已安装技能', bullet: '· ', headerWhenEmpty: true }, plainPaint);
      await channel.reply(msg, lines.join('\n'));
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
    // 即时回执：给用户消息加「敲键盘」表情（与 Hermes 一致），该条处理完成后移除；
    // 排在队列里时表情先行，用户立刻知道消息已被收到。失败（如缺表情回复权限）降级为静默跳过。
    let typingReactionId: string | undefined;
    if (!reactionUnsupported) {
      try {
        typingReactionId = await channel.addReaction(fmsg.messageId, 'Typing');
        if (typingReactionId) {
          const list = pendingTyping.get(openId) || [];
          list.push({ messageId: fmsg.messageId, reactionId: typingReactionId });
          pendingTyping.set(openId, list);
        }
      } catch (err) {
        reactionUnsupported = true;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[feishu] 敲键盘表情回执不可用，已降级为仅占位消息: ${message}`);
      }
    }
    const runQueued = async () => {
      const session = router.getOrCreate(openId);

      if (cmd === '/memory') {
        await channel.reply(msg, buildMemoryLines(session, '你的记忆').join('\n'));
        return;
      }
      if (cmd === '/clear') {
        session.clearHistory();
        await channel.reply(msg, CLEARED_TEXT);
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
          const parts = llmFailureParts(message, text, 'bot');
          await channel.reply(msg, [parts.head, parts.friendly, parts.tail].filter(Boolean).join('\n'));
        }
      } finally {
        running.delete(openId);
      }
    };
    await router.enqueue(openId, async () => {
      try {
        await runQueued();
      } finally {
        // 该条消息处理完毕（含 /memory、/clear、未知命令、中断、报错）即移除敲键盘表情
        if (typingReactionId) {
          await channel.removeReaction(fmsg.messageId, typingReactionId).catch(() => {});
          const list = pendingTyping.get(openId);
          if (list) {
            const rest = list.filter((r) => r.reactionId !== typingReactionId);
            if (rest.length) pendingTyping.set(openId, rest);
            else pendingTyping.delete(openId);
          }
        }
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

  console.log(c.gray('正在建立飞书长连接…'));
  try {
    await channel.start(handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`\n长连接失败: ${message}`));
    console.error(c.gray('请确认：开放平台事件订阅已选「长连接」、已添加 im.message.receive_v1、App 已发布/可用。'));
    console.error(
      c.gray(`改凭证请直接编辑 ${userEnvPath()}；或清空其中 FEISHU_APP_ID / FEISHU_APP_SECRET 后重新运行（会重新进入配置向导）。`),
    );
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
