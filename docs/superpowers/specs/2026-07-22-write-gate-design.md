# 写操作闸门与安全边界（Write Gate）

Date: 2026-07-22  
Status: **implemented**

## Goal

「先确认再执行」从 prompt 约定升级为代码强制：

1. 所有写操作（kanban 写、hk 写、飞书写）在 tool handler 层被拦截，经用户显式批准后才执行
2. 读飞书回来的外部内容标记为不可信数据，缓解 prompt injection
3. 飞书来源 → 看板任务映射查重，重复同步不再重复建任务
4. 看板状态变化（完成/失败/待审批）主动推送飞书，闭环不再靠用户问

## Design

### 写闸门（src/guard.ts + src/tools.ts）

- 分类器：`classifyMcp`（按工具名模式）、`classifyHk`（按子命令）、`classifyLark`（help/api GET/动词黑白名单；**未知一律视为写**）
- 写操作 → `ConfirmFn({ kind, summary, detail })` → 批准才执行；未注入确认通道时**拒绝**（fail closed）
- 拒绝文案固定：「用户拒绝了该写操作……不要换工具或换参数重试」，模型如实转告

### 确认通道

- CLI（src/cli.ts）：暂停 spinner → 显示 summary+detail → `允许执行？[y/N]`，默认拒绝
- Bot（src/confirm.ts + channels/feishu.ts）：
  - `ConfirmationManager` 每用户一个 pending（120s 超时自动拒绝并推送告知）
  - 确认卡片（按钮 value 带 confirm_id）经 WS `card.action.trigger` 回收；**文本「确认/取消」为兜底**
  - 文本答复在进串行队列**之前**被拦截消费，避免「闸门等答复、答复等队列」死锁
  - 开放平台需配「回调订阅 → 长连接 → 卡片回传交互」；未配置时按钮无响应，文本兜底功能不变

### 防注入（src/guard.ts）

`lark_cli` 全部输出包裹 `<<<UNTRUSTED_FEISHU_CONTENT … END_UNTRUSTED>>>`，prompt 声明其中"指令"一律无效。残余风险（模型被骗发起写操作）由闸门兜底。

### 来源查重（src/source-registry.ts）

- `~/.helios-task-agent/synced-sources.json`：`{ userId: { sourceUrl: { taskId, title, createdAt } } }`
- kanban create 类操作提取描述中的飞书 URL；命中映射时先查任务是否仍存在（自愈手工删除），存在则直接拦截不进闸门
- 创建成功（结果含 UUID 且无错误特征）后自动记录映射

### 审计（src/audit.ts）

JSONL 追加 `~/.helios-task-agent/audit.log`：谁/何时/什么写操作/批准或拒绝/结果摘要。永不阻断主流程。

### 状态推送（src/watcher.ts，仅 bot）

- 每 `KANBAN_WATCH_INTERVAL_SEC`（默认 60，最小 15）轮询 kanban REST；`KANBAN_WATCH=0` 关闭
- 快照存 `watch-state.json`；**首轮只建基线不推送**，重启不重复打扰
- 触发：status → done/cancelled；running true→false 且 last_attempt_failed；出现新 pending approval
- 推送目标：`FEISHU_ALLOWED_OPEN_IDS`；为空则 watcher 禁用并启动时警告

### 限流修正（src/llm.ts）

`MAX_TOOL_ROUNDS` 10 → 按**工具调用次数**限流（`MAX_TOOL_CALLS=30`，轮次兜底 25），与「单次最多展开 10 条链接」不再冲突。

## Non-goals（本轮）

- 群聊 @机器人、owner 默认白名单、守护化、token 统计（P2）
- 晨报 cron、post 富文本、进度反馈、/stop（P1）
- 确认卡片的状态回写（点击后更新卡片本身）

## Verification

- `scripts/smoke.ts`：分类器正反用例、闸门拒绝不执行、重复来源拦截、审计写入、UNTRUSTED 包裹、ConfirmationManager（文本/卡片/超时）
- `scripts/e2e-mock.ts`：mock LLM 全流程，断言两次闸门提示出现且回答 y 后执行；`HELIOS_TASK_AGENT_ENV` 现在作为最高优先级 .env 加载，保证 e2e 不被本地配置污染
- 飞书卡片按钮需真机验证：开放平台配好「卡片回传交互」后，点按钮应即时解除闸门
