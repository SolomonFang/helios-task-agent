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
| `HELIOS_TASK_AGENT_ENV` | 强制指定 `.env` 写入路径 |

加载顺序：用户目录 `.env` → 项目 `.env` → 当前目录 `.env`（后者覆盖前者）。完整示例见 [.env.example](.env.example)。

### 开放平台清单（向导也会打印）

1. 创建企业自建应用 → 启用机器人  
2. 事件订阅 → **使用长连接接收事件** → `im.message.receive_v1`  
3. 权限：读取单聊消息、以应用身份发消息 → 发布版本  
4. 复制 App ID / App Secret  

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
