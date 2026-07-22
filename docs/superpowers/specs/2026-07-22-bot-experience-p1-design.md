# Bot 体验补全（post 富文本 / /stop 中断 / /status）

Date: 2026-07-22  
Status: **implemented**  
Upstream: [trust-batch-progress-design](./2026-07-22-trust-batch-progress-design.md)

## Goal

P1 收尾：让飞书 bot 在输入兼容性、可中断性、可观测性上对齐终端体验。

## 实现

### post 富文本（channels/feishu.ts `parsePostContent`）

- 飞书 post 消息摊平为纯文本：title + 段落；`a` → `文字(href)`、`at` → `@名字`、`img/media` → 占位符、`code_block` 保留
- 图片/文件/音频等其他类型仍礼貌回绝（「暂只支持文字与富文本（post）消息」）

### /stop 中断（全链路 AbortSignal）

- `runAgentTurn` 接受 `signal`：每轮/每次工具调用前检查；传入 OpenAI 请求（SDK 原生支持）
- 工具层：`execFile` 带 `signal`（立即杀子进程）；`KanbanMcp.callTool` 透传 `RequestOptions.signal`
- bot：每用户 `running: Map<openId, AbortController>`；`/stop` 在**串行队列之外**即时处理（否则排在它要停的任务后面）
- 中断路径：正常返回 `（已被用户中断）` 或抛 AbortError → bot 统一回「⏹ 已中断」

### /status 与 /tools（bot.ts）

- `/status`：模型、kanban `/api/health`、MCP（含降级/重连状态）、lark-cli、看板推送、晨报
- `/tools`：当前会话工具清单；二者均不进队列
- `/config` 仍终端专属（向导需要 TTY）

## Non-goals

- 群聊 @机器人、语音转写、图片/文件内容理解
- 确认卡片等待中的 /stop（等价于回复「取消」）

## Verification

- `scripts/smoke.ts`：`parsePostContent` 混合节点摊平；预中止 signal 下 `runAgentTurn` 不发起 LLM 请求直接返回
- `npm run typecheck && npm run build && npm run test:e2e` 全绿
- 真机验证项：post 消息渲染、长任务中 /stop 的即时性
