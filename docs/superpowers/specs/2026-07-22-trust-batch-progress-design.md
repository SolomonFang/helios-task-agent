# 信任基线与主动体验（Owner 认领 / 批量确认 / 进度反馈 / 晨报 / MCP 重连 / 通知可行动化）

Date: 2026-07-22  
Status: **implemented**  
Upstream: [write-gate-design](./2026-07-22-write-gate-design.md)

## Goal

在写闸门之上补齐三块产品体验：

1. **信任基线**：白名单为空不再等于"任何陌生人可指挥你的看板"；长连接常驻进程具备自愈能力
2. **主路径体验**：批量操作不被确认弹窗淹没；长任务有进度反馈；从"人找任务"到"任务找人"
3. **通知可行动化**：推送带链接与上下文，用户可直接追问

## ① 信任基线

### Owner 认领（channels/feishu.ts `createAccessChecker`）

- `FEISHU_ALLOWED_OPEN_IDS` 非空：仅列表内用户可用（原行为）
- 为空：首个私聊用户 `claim` 成为 owner → bot 写回 `.env`（`writeEnvFile`）并欢迎；其余用户此后 `deny`，仅首次收到礼貌拒绝
- watcher/晨报等推送目标读 `channel.allowedOpenIds()`（运行时认领即时生效）

### 启动检查与 MCP 自愈（src/deps.ts / src/bot.ts supervisor / src/mcp.ts）

- bot 启动即 `checkLarkCli()`，缺失时警告（不阻断）
- supervisor 每 60s `mcp.ping()`（listTools 探测）：掉线 → `router.setMcpOk(false)` 全量降级 hk_cli 并通知 owner；按 3 次连试后每 5 轮退避重连；恢复 → `setMcpOk(true)` 热切回（`AgentSession.setMcpOk` 重建工具与系统提示，**保留对话历史**）
- router 始终持有 mcp 对象（即使启动降级），保证热切换可行

## ② 主路径体验

### 批量确认（src/guard.ts `withBatchApproval`）

- `ConfirmRequest.batchKey`：kanban 按 MCP 工具名、hk 按子命令；**delete/cancel/stop/deny 与 lark 写操作不带 key**，永远逐次确认
- 批准后 10 分钟内同 key 自动放行；拒绝不缓存；CLI 批准后打印提示

### 进度反馈与长回复（channels/feishu.ts / bot.ts）

- `sendText` 返回 message_id；`updateText` 走 `im.v1.message.update` 原地更新
- 处理期间占位消息随 `onProgress` 更新（≥2s 节流）：「⏳ 处理中…（调用工具 xxx）」
- 完成后占位消息替换为回复首段；超长回复按段落边界 `splitText`（≤3000）拆多条，不再 3500 字截断（`reply`/`notifyOpenId` 同样拆分）

### 晨报（src/scheduler.ts / bot.ts）

- `BOT_DAILY_REPORT=HH:MM`：每天该时刻对每个 owner 在各自串行队列里「只读」跑「同步我的任务」并推送结果（明确指示不写看板，避免清晨确认卡片轰炸；写闸门仍兜底，推送末尾引导用户回复「写进 helios-kanban」接续）
- 写操作仍走确认闸门（夜间未确认则 120s 超时自动拒绝，安全语义不变）

## ③ 通知可行动化（src/watcher.ts / bot.ts）

- 推送文案带任务看板链接（`/local-projects/<pid>/tasks/<tid>`）
- 每条推送同时 `session.injectSystemNote()` 注入该用户会话上下文；用户回「这个怎么样 / 帮我 review」时 agent 知道指代哪个任务

## Non-goals

- 群聊 @机器人、post 富文本、/stop 中断、守护化、token 统计（后续批次）
- 确认卡片点击后的卡片自体更新（当前以文本 ack 代替）

## Verification

- `scripts/smoke.ts`：`withBatchApproval`（同类放行/异类重问/拒绝不缓存）、`splitText`、`createAccessChecker`（认领/放行/拒绝）、`parseDailyTime`；既有闸门与查重用例回归
- `npm run typecheck && npm run build && npm run test:e2e` 全绿
- 需真机验证：`im.v1.message.update` 进度刷新、`card.action.trigger` 按钮回调
