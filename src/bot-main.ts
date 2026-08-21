/**
 * Feishu bot entry: run → wizard if needed → long-connection DM.
 *
 *   helios-task-agent bot
 *   helios-task-agent-bot
 *
 * 本文件只保留 bootstrap（向导 / 看板拉起 / MCP 连接 / 长连接建立 / 退出清理）：
 * - 与 CLI 共用的启动序列（依赖告警 / 技能迁移 / 看板拉起）：bootstrap.ts
 * - MCP 健康监督与自动重连：bot/supervisor.ts
 * - 消息路由与卡片回调：bot/handler.ts
 */

import readline from 'readline';
import path from 'path';
import { currentConfig, ensureEnvLoaded, feishuBotConfig, isConfigured, isFeishuBotConfigured, userEnvPath, writeEnvFile } from './config/config';
import { ensureBotConfig, ensureConfig, rebindFeishuBot } from './config/config-wizard';
import { MemoryStore } from './agent/memory';
import { defaultDataHome } from './infra/paths';
import { FeishuChannel } from './channels/feishu';
import { SessionRouter } from './agent/session-router';
import { SessionHistoryStore } from './agent/session-store';
import { stopKanbanChild, fetchHealth } from './kanban/kanban-ensure';
import { ConfirmationManager } from './agent/confirm';
import { buildConfirmCard, buildResolvedCard, buildWatchEventCard } from './channels/feishu-cards';
import { KanbanWatcher, type WatchEvent } from './kanban/watcher';
import { isLoopbackUrl } from './infra/url-utils';
import { reviewsDir } from './report/review-report';
import { reportsDir } from './report/report';
import { startReportServer, type ReportServer } from './report/report-server';
import { checkLarkCliStatus, checkHkDeps, checkHkDepsAsync, HK_CLI_INSTALL_HINT, MCP_FALLBACK_TEXT } from './infra/deps';
import { ensureKanbanOrExit, migrateAndValidateSkills, warnStartupDeps } from './bootstrap';
import { wrapUntrusted } from './agent/guard';
import { checkForUpdate, promptVersionUpdate, readPkgVersion, updateCheckDisabled } from './infra/update-check';
import { connectMcp } from './kanban/mcp';
import { TRY_EXAMPLES } from './commands';
import { wizardAskSecret, wizardChoose } from './config/wizard-io';
import { McpSupervisor } from './bot/supervisor';
import { WsAlerter } from './bot/ws-alerter';
import { DailyBrief, parseDailyBriefTime, type DailyBriefTime } from './bot/daily-brief';
import { createBotHandlers, createRoundNoticeTracker } from './bot/handler';
import { errMessage } from './infra/err';
import type { AskFn, ChooseFn } from './types';
import type { ChildProcess } from 'child_process';
import { c } from './infra/ui';

const BOT_HELP = `Helios Task Agent（飞书私聊）

命令
/help     显示帮助
/status   健康检查（看板 / 看板连接 / 飞书读取 / 推送）
/tools    列出当前可用工具
/skills   列出技能；install <路径> 安装（升级不丢失）；uninstall <名称> 卸载
/memory   查看你的持久化记忆
/clear    清空本对话历史（不清记忆）
/stop     中断当前任务与进行中的 AI 审查（排队消息与待确认写操作一并取消）
/confirm  查看「同类免问」状态；/confirm revoke 或回复「恢复确认」撤销免问

写操作安全闸门
· 建/改/删任务、启动任务的工作区、发飞书消息等写操作会收到确认卡片
· 「确认执行」仅此次有效；「同类免问（本会话）」适合批量建任务；文本回复「确认 / 同类免问 / 取消」
· 免问期间回复「恢复确认」立即撤销，恢复逐次确认
· 普通写操作 120 秒、破坏性操作（删除/停止/审批等）300 秒未操作自动拒绝

可以说
${TRY_EXAMPLES.map((e) => `· ${e}`).join('\n')}`;

/** bot 子命令用法文案（--help 与未知参数报错共用；两个入口同一份，第二行覆盖独立入口）。 */
const BOT_CLI_USAGE = `用法: helios-task-agent bot [选项]
      helios-task-agent-bot [选项]（独立入口，等同上一行）

选项
  --rebind      换绑飞书机器人（只重跑飞书凭证向导，保留模型/看板配置）
  --reconfig    重跑模型/看板配置向导（飞书凭证保留）
  --version     打印版本号
  --help        显示本帮助`;

/**
 * bot 子命令参数解析：
 * --rebind   换绑飞书机器人（只重跑飞书凭证向导，保留模型/看板配置）
 * --reconfig 重跑模型/看板配置向导（飞书凭证保留）
 * 与独立入口 helios-task-agent-bot 行为一致：--help / --version 打印后退出（退出码 0），
 * 未知参数报错并以非零退出（此前静默忽略、直接启动 bot）。
 */
export function parseBotArgs(argv: string[]): { rebind: boolean; reconfig: boolean } {
  // 经统一入口 helios-task-agent bot … 进入时 argv 首位是子命令名本身，先剥掉
  const args = (argv[0] === 'bot' ? argv.slice(1) : argv).map((a) => a.toLowerCase());
  if (args.includes('help') || args.includes('-h') || args.includes('--help')) {
    console.log(BOT_CLI_USAGE);
    process.exit(0);
  }
  if (args.includes('version') || args.includes('-v') || args.includes('--version')) {
    console.log(readPkgVersion());
    process.exit(0);
  }
  const unknown = args.filter((a) => a !== 'rebind' && a !== '--rebind' && a !== 'reconfig' && a !== '--reconfig');
  if (unknown.length) {
    console.error(`未知参数: ${unknown.join(' ')}\n\n${BOT_CLI_USAGE}`);
    process.exit(1);
  }
  return {
    rebind: args.some((a) => a === 'rebind' || a === '--rebind'),
    reconfig: args.some((a) => a === 'reconfig' || a === '--reconfig'),
  };
}

/**
 * 发卡片失败降级纯文本（确认卡片与看板事件推送共用）：
 * 卡片失败记 cardFailLog 后发文本；文本也失败记 textFailLog（可选）并以 error 返回，
 * 是否抛出由调用方决定（confirm 需抛给管理器走 onSendFailed，watch 先注入会话再抛以记重投）。
 */
async function sendCardWithTextFallback<T>(opts: {
  sendCard: () => Promise<T>;
  sendText: () => Promise<unknown>;
  cardFailLog: (message: string) => void;
  textFailLog?: (message: string) => void;
}): Promise<{ card?: T; error?: unknown }> {
  try {
    return { card: await opts.sendCard() };
  } catch (err) {
    opts.cardFailLog(errMessage(err));
  }
  try {
    await opts.sendText();
    return {};
  } catch (err) {
    opts.textFailLog?.(errMessage(err));
    return { error: err };
  }
}

function createAsk(): { ask: AskFn; askSecret?: AskFn; choose: ChooseFn; close: () => void } {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  const ask: AskFn = (promptText) =>
    new Promise((resolve) => {
      // 正常回答后必须摘掉 close 监听：rl.once('close') 每次提问挂一个、不摘则残留，
      // 首跑向导多次提问 + 校验重试累积超过 10 个会触发 MaxListenersExceededWarning
      const onClose = () => resolve(null);
      rl.question(promptText, (ans) => {
        rl.removeListener('close', onClose);
        resolve(ans);
      });
      rl.once('close', onClose);
    });
  const isTTY = process.stdin.isTTY === true;
  // 与终端一致的向导体验：箭头选择列表 + 密钥掩码输入（仅 TTY），交互原语见 wizard-io
  const askSecret = wizardAskSecret(rl, isTTY);
  const choose: ChooseFn = wizardChoose(rl);
  return {
    ask,
    askSecret,
    choose,
    close: () => rl.close(),
  };
}

async function main(): Promise<void> {
  // helios-task-agent bot --rebind / --reconfig / --help / --version：见 parseBotArgs 注释
  // 尽早解析：--help / --version / 未知参数在打印启动横幅前就退出
  const { rebind, reconfig } = parseBotArgs(process.argv.slice(2));

  // env 显式初始化（import config 不再自动加载 .env，见 config.ts ensureEnvLoaded）；
  // 放在 parseBotArgs 之后：--help / --version 不需要读盘
  ensureEnvLoaded();

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
    reportServer: ReportServer | null;
    dailyBrief: DailyBrief | null;
  } = { channel: null, mcp: null, watcher: null, kanbanChild: null, supervisor: null, wsAlerter: null, reportServer: null, dailyBrief: null };
  let shuttingDown = false;
  /**
   * 优雅退出：exitCode 由触发路径决定——正常信号（SIGINT/SIGTERM）传 0；
   * uncaughtException 传 1：崩溃被 launchd/systemd 当成干净停止（退出码 0）时不会自动重启。
   * 注意异常路径触发后若卡在清理里被 forceTimer 强退，退出码会是 1（与传入一致兜底见下）。
   */
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) return; // 幂等：二次 Ctrl+C / SIGINT+SIGTERM 不重入
    shuttingDown = true;
    // 整体超时兜底：channel.stop / mcp.close 挂住时强制退出，避免进程永不退。
    // 强退用 1 而非透传 exitCode：挂住本身是异常状态，干净停止（0）不该出现在超时路径
    const forceTimer = setTimeout(() => {
      console.error(c.err('退出清理超时，强制结束进程'));
      process.exit(1);
    }, 8000);
    forceTimer.unref();
    console.log('\n' + c.gray('正在退出…'));
    try {
      // 先等在途重连结束再 close MCP：connect 中途完成会残留无人持有的子进程
      await cleanup.supervisor?.stop();
      cleanup.wsAlerter?.stop();
      await cleanup.watcher?.stop();
      await cleanup.dailyBrief?.stop();
      cleanup.reportServer?.close();
      await cleanup.channel?.stop();
      await cleanup.mcp?.close();
      await stopKanbanChild(cleanup.kanbanChild);
    } catch {
      /* 尽力清理，任何一步失败都继续退出 */
    }
    clearTimeout(forceTimer);
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // 长驻进程兜底：漏网 rejection 只记日志不退出（保持进程可用）；
  // uncaughtException 说明状态已不可信，记日志后复用 shutdown 优雅退出（8s 强退兜底仍在）——
  // 退出码必须非 0：以 0 退出会被 launchd/systemd 当成干净停止而不触发自动重启。
  // handler 自身不得再抛异常（否则绕过清理直接 crash），故只做同步日志 + 幂等 shutdown。
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[bot] 未处理的 Promise rejection（进程保持运行）: ${msg}`);
  });
  process.on('uncaughtException', (err) => {
    console.error(`[bot] 未捕获异常，执行优雅退出: ${err.stack || err.message}`);
    void shutdown(1);
  });
  // 测试钩子（HTA_TEST_CRASH=1）：让子进程测试能真实触发 uncaughtException 路径，
  // 验证崩溃退出码为 1（setImmediate 抛出才走 uncaughtException，同步 throw 只会 reject main）
  if (process.env.HTA_TEST_CRASH) setImmediate(() => { throw new Error('HTA_TEST_CRASH'); });

  const { ask, askSecret, choose, close } = createAsk();
  let agentCfg;
  let feishuCfg;
  try {
    if (rebind && isConfigured() && isFeishuBotConfigured()) {
      const rb = await rebindFeishuBot(ask, { askSecret });
      agentCfg = currentConfig();
      feishuCfg = rb.feishu;
      console.log(c.gray(`已加载配置: ${rb.envPath}`));
    } else if (reconfig && isConfigured() && isFeishuBotConfigured()) {
      // 只重跑模型向导：writeEnv 合并写保留飞书凭证；看板默认值在向导中回显当前值
      agentCfg = await ensureConfig(ask, { force: true, choose, askSecret });
      feishuCfg = feishuBotConfig();
    } else {
      if (rebind || reconfig) console.log(c.gray('配置尚不完整，进入完整配置向导。'));
      const ready = await ensureBotConfig(ask, { force: false, choose, askSecret });
      agentCfg = ready.agent;
      feishuCfg = ready.feishu;
      console.log(c.gray(`已加载配置: ${ready.envPath}`));
    }
  } catch (err) {
    close();
    const message = errMessage(err);
    console.error(c.err(`配置失败: ${message}`));
    process.exit(1);
  }
  close();

  // Refresh from env after wizard
  agentCfg = currentConfig();
  feishuCfg = feishuBotConfig();

  // npm 更新检查：发现新版本先请示（结果缓存 24h，离线静默；HTA_UPDATE_CHECK=0 关闭）
  if (!updateCheckDisabled() && process.stdin.isTTY === true) {
    const info = await checkForUpdate({ current: version });
    if (info) {
      const { ask: upAsk, close: upClose } = createAsk();
      try {
        // 与 CLI 对齐传 log：跳过/失败时给用户可见反馈（不传则静默跳过，分不清是没识别还是已跳过）
        const outcome = await promptVersionUpdate({ info, ask: upAsk, log: (m) => console.log(c.gray(m)) });
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
    console.log(
      c.warn(
        '⚠️ 安全警告：未设置 FEISHU_ALLOWED_OPEN_IDS，首个私聊本机器人的用户将自动成为唯一 owner 并写入白名单' +
          '（先聊先得，机器人可被他人搜到时存在被抢占风险）；如需固定 owner，请先在 .env 中配置该白名单。',
      ),
    );
  }
  const larkStatus = checkLarkCliStatus();
  // bot 无 banner，lark-cli 需完整告警文案；OCR 检查为 bot 特有（AI 审查功能依赖）
  warnStartupDeps(larkStatus, { style: 'bot', checkOcr: true });
  // hk_cli 降级链依赖（jq/curl）：缺失时 MCP 掉线后看板读写不可用，不能宣称「功能不受影响」
  const hkMissing = checkHkDeps();
  if (hkMissing.length) {
    console.log(
      c.warn(`hk_cli 降级链缺少 ${hkMissing.join('、')}：MCP 掉线时看板读写将不可用（${HK_CLI_INSTALL_HINT}）`),
    );
  }
  migrateAndValidateSkills();

  const ensured = await ensureKanbanOrExit({
    kanbanUrl: agentCfg.kanbanUrl,
    onLog: (msg) => console.log(c.gray(msg)),
    // 就绪等待期间（最长 90s）收到退出信号时，shutdown 需要拿到 child 才能清理
    onSpawn: (child) => {
      cleanup.kanbanChild = child;
    },
    failLabel: '看板启动失败',
  });
  cleanup.kanbanChild = ensured.child;

  // 报告静态服务：AI 审查（reviews/）与工作总结（reports/）两类报告都推 HTTP 链接，
  // 避免长文本截断与本机路径在手机飞书打不开的问题
  let reportServer: ReportServer | null = null;
  try {
    reportServer = await startReportServer([reviewsDir(), reportsDir()], agentCfg.kanbanUrl);
    cleanup.reportServer = reportServer;
    console.log(c.gray(`报告服务: ${reportServer.baseUrl}`));
  } catch (err) {
    const message = errMessage(err);
    console.warn(c.warn(`报告服务启动失败，报告将回退为文本/本机路径推送: ${message}`));
  }

  const bootLabel = '正在连接 helios-kanban MCP…';
  process.stdout.write(c.gray(bootLabel));
  const { mcp, ok: mcpOk, error: mcpError, hint: mcpHint } = await connectMcp(agentCfg, {
    // 实例一创建即登记：45s 连接窗口内收到退出信号时，shutdown 能拿到 mcp 做 close
    //（其 in-flight stdio 子进程由 closePending 兜底关闭），不等 connect resolve
    onCreate: (instance) => {
      cleanup.mcp = instance;
    },
    // 连接等待期每 ~10 秒覆写当前行补进度（bot 无 spinner，否则最长 45s 无反馈像卡死）
    onLog: (msg) => process.stdout.write(c.gray(`\r${msg}`)),
  });
  if (mcpOk) {
    process.stdout.write(c.ok(`\rMCP 已连接（${mcp.tools.length} 个工具）          \n`));
  } else {
    // 原始错误是英文 SDK 原文，只进调试输出；用户面给中文结论 + 已知模式排查提示
    if (process.env.HTA_DEBUG && mcpError) console.error(`[mcp] 连接失败原文: ${mcpError}`);
    process.stdout.write(c.warn(`\rMCP 连接失败，${MCP_FALLBACK_TEXT}          \n`));
    if (mcpHint) process.stdout.write(c.warn(`${mcpHint}\n`));
  }

  const memory = new MemoryStore();
  const channel = new FeishuChannel(feishuCfg);
  cleanup.channel = channel;

  // 写操作确认：发确认卡片（按钮回调），失败降级为文本确认；超时自动拒绝（破坏性操作更长）；
  // 决策/超时/作废后通过 onSettled 把卡片原地更新为终态（按钮消失，避免误点）
  // roundNotices：确认卡片/回执插在「处理中」占位之后时标记，最终回复改发新消息保持时间线顺序
  const roundNotices = createRoundNoticeTracker();
  const confirmations = new ConfirmationManager(
    async (openId, chatId, req, id, timeoutMs) => {
      roundNotices.mark(openId);
      const sendText = () => {
        const batchHint = req.batchKey ? '，「同类免问」本会话内同类操作免问' : '';
        // detail 缩进成块，避免长命令与正文混排（对齐卡片的代码块视觉）
        const detailBlock = req.detail
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n');
        return channel.notifyOpenId(
          openId,
          `⚠️ 写操作确认\n${req.summary}\n──────\n${detailBlock}\n──────\n\n回复「确认」执行（仅此次）${batchHint}，「取消」拒绝（${Math.round(timeoutMs / 1000)} 秒超时自动拒绝）。`,
        );
      };
      if (chatId) {
        const r = await sendCardWithTextFallback({
          sendCard: () => channel.sendCard(chatId, buildConfirmCard(req, id, timeoutMs)),
          sendText,
          cardFailLog: (m) => console.error(`[confirm] 卡片发送失败，降级文本: ${m}`),
        });
        // 文本降级也失败：抛给管理器按拒绝收尾并走 onSendFailed 通知
        if (r.error) throw r.error;
        return r.card;
      }
      await sendText();
      return undefined;
    },
    {
      timeoutMs: 120000,
      onTimeout: (openId, req) => {
        roundNotices.mark(openId);
        void channel
          .notifyOpenId(openId, `确认超时，已自动拒绝：${req.summary}。如仍需执行，直接再跟我说一声即可。`)
          .catch(() => {});
      },
      onSuperseded: (openId, req) => {
        roundNotices.mark(openId);
        void channel
          .notifyOpenId(openId, `⚠️ 上一个确认请求已作废（被新的写操作替代）：${req.summary}`)
          .catch(() => {});
      },
      onSettled: (_openId, req, settle, cardMessageId) => {
        if (!cardMessageId) return;
        void channel.updateCard(cardMessageId, buildResolvedCard(req, settle)).catch((err) => {
          const message = errMessage(err);
          console.error(`[confirm] 卡片终态更新失败: ${message}`);
        });
      },
      // 卡片与文本降级都发送失败：管理器已按拒绝收尾，这里走最后可达路径告知用户，
      // 避免"操作默默没执行"（仍失败只能落日志，等待方已拿到明确拒绝、不会干等）
      onSendFailed: (openId, req, error) => {
        roundNotices.mark(openId);
        void channel
          .notifyOpenId(openId, `⚠️ 写操作确认发送失败，本次操作未执行：${req.summary}\n原因：${error}\n请稍后重试或检查机器人网络。`)
          .catch((err) => {
            const message = errMessage(err);
            console.error(`[confirm] 发送失败通知也未送达(${openId}): ${message}`);
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
      const message = errMessage(err);
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
    new SessionHistoryStore(),
  );

  const notifyOwners = (text: string): void => {
    for (const oid of channel.allowedOpenIds()) {
      void channel.notifyOpenId(oid, text).catch(() => {});
    }
  };

  // MCP 健康监督：60s 探测；连续失败才降级 hk_cli，自动重连（退避至 ~5 分钟），恢复后切回。
  // 有用户轮次进行中时不重连（reconnect 的 close 会杀 in-flight 工具调用），竞态防护见 supervisor。
  // kanbanHealth：mcp.ping 只证明 stdio 活着，看板假死时探活会误判健康——每 5 分钟
  //（失败后逐 tick）补一次真实看板健康调用，连续失败走同一 onLost 降级/告警通道。
  const supervisor = new McpSupervisor({
    mcp,
    initiallyAlive: mcpOk,
    kanbanHealth: async () => {
      if (!(await fetchHealth(agentCfg.kanbanUrl))) throw new Error('看板健康检查未通过');
    },
    onLost: () => {
      router.setMcpOk(false);
      void (async () => {
        // hk_cli 降级链依赖（jq/curl）缺失时「已切换备用通道」是谎言：按探测结果条件化
        const hkMissing = await checkHkDepsAsync();
        const fallback = hkMissing.length
          ? `看板读写暂不可用，缺少 ${hkMissing.join('/')}（${HK_CLI_INSTALL_HINT}）`
          : MCP_FALLBACK_TEXT;
        console.log(c.warn(`MCP 连接丢失，${fallback}，将自动重连…`));
        notifyOwners(`⚠️ 看板 MCP 连接丢失，${fallback}（恢复后自动切回）`);
      })();
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
    roundNotices,
  });
  channel.onCardAction = handlers.onCardAction;

  console.log(c.gray('正在建立飞书长连接…'));
  try {
    await channel.start(handlers.handle);
  } catch (err) {
    const message = errMessage(err);
    console.error(c.err(`\n长连接失败: ${message}`));
    console.error(c.gray('请确认：开放平台事件订阅已选「长连接」、已添加 im.message.receive_v1、App 已发布/可用。'));
    console.error(
      c.gray(`改凭证请直接编辑 ${userEnvPath()}；或清空其中 FEISHU_APP_ID / FEISHU_APP_SECRET 后重新运行（会重新进入配置向导）。`),
    );
    // 统一走 shutdown：此时 supervisor / reportServer / channel 等已登记进 cleanup，
    // 手写清理 mcp + kanbanChild 会漏掉它们（shutdown 幂等且有 8s 强退兜底）
    await shutdown(1);
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
    // 单 owner 推送：卡片失败降级纯文本；会话注入保持全局、不按送达成败跳过
    // （重投时 injectSystemNote 按事件 id 去重，不会因重试而重复注入）
    const notifyWatchOwner = async (event: WatchEvent, oid: string, eventId: string): Promise<void> => {
      const r = await sendCardWithTextFallback({
        sendCard: () => channel.notifyCardOpenId(oid, buildWatchEventCard(event)),
        sendText: () => channel.notifyOpenId(oid, event.text),
        cardFailLog: (m) => console.error(`[watch] 卡片推送失败(${oid}): ${m}，降级纯文本`),
        textFailLog: (m) => console.error(`[watch] 推送失败(${oid}): ${m}`),
      });
      // 注入会话：用户追问「刚才那个怎么样 / 帮我 review」时 agent 有上下文
      // （看板事件文本属外部内容，UNTRUSTED 包裹，其中「指令」对 agent 无效；
      //   注入发生在轮边界，不会打断进行中的 tool 配对）
      try {
        router
          .getOrCreate(oid)
          .injectSystemNote(
            `[看板事件通知 ${new Date().toLocaleString('zh-CN')}]\n${wrapUntrusted(event.text)}`,
            `watch:${eventId}`,
          );
      } catch {
        /* ignore */
      }
      // 发送失败抛出：watcher 把该 (事件, owner) 记入待重投，下轮仅重投未送达的 owner
      if (r.error) throw r.error;
    };
    const watcher = new KanbanWatcher({
      kanbanUrl: agentCfg.kanbanUrl,
      projectId: agentCfg.kanbanProjectId || undefined,
      intervalMs: intervalSec * 1000,
      statePath: path.join(defaultDataHome(), 'watch-state.json'),
      owners: () => channel.allowedOpenIds(),
      notifyOwner: notifyWatchOwner,
      // owners/notifyOwner 均已提供 → 启用 (事件, owner) 粒度送达追踪；
      // notify 仅作缺任一时的旧整批回退路径
      notify: async (event, eventId) => {
        let firstErr: unknown = null;
        for (const oid of channel.allowedOpenIds()) {
          try {
            await notifyWatchOwner(event, oid, eventId);
          } catch (err) {
            firstErr = err;
          }
        }
        if (firstErr) throw firstErr;
      },
      log: (msg) => console.log(c.gray(`[watch] ${msg}`)),
    });
    cleanup.watcher = watcher;
    watcher.start();
    console.log(c.gray(`看板状态推送已开启（每 ${intervalSec}s 轮询）`));
  }

  // 定时晨报：HTA_DAILY_BRIEF=HH:MM（本地时间）开启，默认关闭；非法值告警并关闭
  let dailyBriefTime: DailyBriefTime | null = null;
  try {
    dailyBriefTime = parseDailyBriefTime(process.env.HTA_DAILY_BRIEF);
  } catch (err) {
    console.warn(c.warn(`${errMessage(err)}，定时晨报已关闭`));
  }
  if (dailyBriefTime) {
    const brief = new DailyBrief({
      time: dailyBriefTime,
      statePath: path.join(defaultDataHome(), 'daily-brief-state.json'),
      kanbanUrl: agentCfg.kanbanUrl,
      projectId: agentCfg.kanbanProjectId || undefined,
      iteration: agentCfg.kanbanIteration || undefined,
      owners: () => channel.allowedOpenIds(),
      notifyOwner: (oid, text) => channel.notifyOpenId(oid, text),
      log: (msg) => console.log(c.gray(`[daily-brief] ${msg}`)),
    });
    cleanup.dailyBrief = brief;
    brief.start();
    const hh = String(dailyBriefTime.hour).padStart(2, '0');
    const mm = String(dailyBriefTime.minute).padStart(2, '0');
    console.log(c.gray(`定时晨报已开启（每天 ${hh}:${mm} 推送）`));
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
