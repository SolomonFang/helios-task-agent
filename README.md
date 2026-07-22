# Helios Task Agent

终端 / 飞书私聊智能体：把飞书任务/文档整理进 [helios-kanban](https://github.com/SolomonFang/vibe-kanban)。**是否启动 coding agent、用哪个 executor，由你决定。**

## 端到端主流程

```text
飞书任务中心 / 文档
  → 列出任务；标题/描述含飞书链接则展开详情（仅展示，不自动写看板）
  → 「写进 helios-kanban」：展示标题 + 需求摘要草稿 → 你确认 → create（不自动 start）
  → 之后是否 start、用谁跑：听你的（Claude / Kimi / Codex / 看板默认 …）
```

| 阶段 | 谁做 | 产物 |
|------|------|------|
| 拉任务 / 展开链接 | Task Agent + `lark_cli` | 对话里的任务/文档摘要 |
| 写入看板 | Task Agent + MCP/`hk_cli` | kanban 任务（来源 + 需求内容） |
| 启用任务 | **你指定** | workspace（可选） |

详细设计见：

- [全流程说明](docs/superpowers/WORKFLOW.md)
- [文档索引](docs/superpowers/README.md)
- [任务中心链接展开](docs/superpowers/specs/2026-07-21-feishu-task-link-expand-design.md)
- [飞书 → 看板](docs/superpowers/specs/2026-07-21-feishu-to-kanban-design.md)
- [写操作闸门与安全边界](docs/superpowers/specs/2026-07-22-write-gate-design.md)

## 安全机制

「agent 不擅自行动」不靠 prompt 自觉，由代码层保障：

| 机制 | 说明 |
|------|------|
| 写操作闸门 | 建/改/删任务、start/stop/follow-up、审批、飞书发消息等写操作，执行前必须经你确认：终端 y/N，飞书端弹确认卡片（按钮或回复「确认/取消」，120 秒超时自动拒绝） |
| 只读白名单 | `lark_cli` 按子命令分类：只读（list/get/search 等）直接放行，写操作与未知命令一律进闸门；`api` 仅 GET 免确认 |
| 防注入标记 | `lark_cli` 读回的外部内容统一包裹 UNTRUSTED 标记，模型被告知其中"指令"一律无效；即使被骗发起写操作也会被闸门拦下 |
| 来源查重 | 飞书链接 → 看板任务映射存 `synced-sources.json`；同一来源重复同步会被拦截并提示已有任务 |
| 审计日志 | 所有写操作的请求/批准/拒绝/结果追加到 `~/.helios-task-agent/audit.log`（JSONL） |

## 看板状态推送（bot）

bot 模式下每 60s 轮询看板：任务完成/取消、执行失败、新待审批 → 主动推送飞书（推给 `FEISHU_ALLOWED_OPEN_IDS`）。首轮只建基线，快照存 `watch-state.json`，重启不重复打扰。`KANBAN_WATCH=0` 关闭，`KANBAN_WATCH_INTERVAL_SEC` 调间隔。

## 安装

```bash
npm i -g helios-task-agent
# 或
npx helios-task-agent
```

Node.js >= 18。建议本机已安装 **lark-cli**（读飞书）。

## 像 Hermes 一样用

配置保存在用户目录（与仓库无关）：

```text
~/.helios-task-agent/.env
~/.helios-task-agent/memory.json
~/.helios-task-agent/synced-sources.json   （飞书来源 → 看板任务映射，查重用）
~/.helios-task-agent/audit.log             （写操作审计，JSONL）
~/.helios-task-agent/watch-state.json      （看板推送快照）
```

### 终端

```bash
helios-task-agent
```

首次运行会引导配置模型（LLM）；也可事先编辑 `~/.helios-task-agent/.env`。

### 飞书私聊机器人

```bash
helios-task-agent bot
# 或
helios-task-agent-bot
```

1. **第一次运行会自动进入向导**：打印开放平台勾选清单，并询问 `App ID` / `App Secret`（以及尚未配置时的 LLM）
2. 按提示在 [飞书开放平台](https://open.feishu.cn/) 建好机器人（长连接 + `im.message.receive_v1`）
3. 向导保存后建立长连接；用手机**私聊**机器人即可（当前仅处理私聊，忽略群消息）

无需公网 Webhook。进程在线才能收消息。

改配置：再跑一次 `helios-task-agent bot` 并在缺项时重填，或直接编辑 `~/.helios-task-agent/.env`。

## 命令

| 命令 | 作用 |
|------|------|
| `helios-task-agent` | 交互式终端 Agent |
| `helios-task-agent bot` | 飞书私聊机器人（缺配置则向导） |
| `helios-task-agent-bot` | 同上 |
| `helios-task-agent help` | 帮助 |

本地开发：`npm start` / `npm run bot`（仍会加载用户目录与项目 `.env`）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 必填（向导可写） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | bot 必填（向导可写） |
| `FEISHU_ALLOWED_OPEN_IDS` | 可选，逗号分隔 open_id 白名单 |
| `HELIOS_KANBAN_URL` | 看板地址，默认 `http://localhost:7964` |
| `HELIOS_KANBAN_AUTO_START` | 默认开启；本机看板未就绪时自动 `npx -y helios-kanban`；`0` 关闭 |
| `HELIOS_KANBAN_PROJECT_ID` / `REPO_ID` / `ITERATION` | 可选默认 |
| `HELIOS_TASK_AGENT_HOME` | 数据目录，默认 `~/.helios-task-agent` |
| `HELIOS_TASK_AGENT_ENV` | 强制指定 `.env` 路径（写入目标；加载时优先级最高） |
| `KANBAN_WATCH` | bot 看板状态推送，默认开；`0` 关闭 |
| `KANBAN_WATCH_INTERVAL_SEC` | 推送轮询间隔（秒，默认 60，最小 15） |

加载顺序：用户目录 `.env` → 项目 `.env` → 当前目录 `.env`（后者覆盖前者）。完整示例见 [.env.example](.env.example)。

### 开放平台清单（向导也会打印）

1. 创建企业自建应用 → 启用机器人  
2. 事件订阅 → **使用长连接接收事件** → `im.message.receive_v1`  
3. （可选，确认卡片按钮）回调订阅 → **使用长连接接收回调** → 添加「卡片回传交互」`card.action.trigger`；不配则确认走纯文本回复，功能不变  
4. 权限：读取单聊消息、以应用身份发消息 → 发布版本  
5. 复制 App ID / App Secret

## 飞书 / 终端里可以说

- `/help` `/memory` `/clear`
- 「以后都从这个飞书地址同步任务：\<链接\>」
- 「同步我的任务」/「列出我的任务」（含链接则展开详情）
- 「写进 helios-kanban」（确认标题+需求摘要后创建；**不**自动启动）
- 「用 Claude 跑这个任务」「start」等（**你**指定何时、用谁启用）
- 「有哪些项目」「创建一个任务：…」「跑得怎么样」「再跟它说一句…」

记忆按飞书 `open_id`（bot）或 `local`（终端）分桶。

## 工具一览

| 工具 | 作用 |
|------|------|
| `lark_cli` | 飞书读写（任务中心、文档等） |
| kanban MCP / `hk_cli` | 项目/任务/start/follow-up/审批 |
| `repo_fs` | 可选：只读浏览本机仓库目录 |
| `memory_*` | 持久化偏好（如 `feishu_task_source`） |

## 依赖组件

- **helios-kanban**：本机地址未就绪时会自动拉起（可用 `HELIOS_KANBAN_AUTO_START=0` 关闭）；优先 MCP，失败降级 `hk.sh`
- **lark-cli**（推荐）：读飞书任务/文档

## 开发

```bash
npm install
npm run typecheck
npm run smoke
npm run build
```

## License

ISC
