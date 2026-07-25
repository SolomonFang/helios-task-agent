# Helios Task Agent

**中文** | [English](./README.en.md)

终端 / 飞书私聊智能体：把飞书任务与文档整理进 [helios-kanban](https://github.com/SolomonFang/vibe-kanban)。

**是否启动 coding agent、用哪个 executor，由你决定。**

## 安装

要求：Node.js ≥ 18，macOS / Linux。

```bash
npm i -g helios-task-agent
```

然后直接运行（首次启动进入交互向导，配置自动写入 `~/.helios-task-agent/.env`）：

```bash
helios-task-agent        # 终端交互 agent
helios-task-agent bot    # 飞书私聊机器人
```

**helios-kanban 无需预装**：本机看板不可达时 agent 会自动 `npx -y helios-kanban` 拉起。可用 `HELIOS_KANBAN_URL` 指向已有实例，`HELIOS_KANBAN_AUTO_START=0` 关闭自动拉起。

**飞书读取需另装 lark-cli**（不装则飞书任务/文档读取不可用，看板功能不受影响）：

```bash
npm i -g @larksuite/cli && lark-cli auth login
```

从源码开发：`npm install && npm start`。

## 发布（维护者）

打 tag 即触发 GitHub Action 自动发布（`.github/workflows/publish.yml`）：

```bash
npm version patch          # 或 minor / major，自动改 version 并打 tag
git push --follow-tags     # 推送 commit + tag，触发发布
```

tag 必须与 `package.json` 的 `version` 一致（CI 会校验）。预发布版本（如 `1.1.0-beta.0`）自动发到 npm `next` 频道，正式版发到 `latest`。CI 发布前跑 typecheck + build（`prepublishOnly` / `prepack`）；smoke / e2e 依赖本机 helios-kanban，请在打 tag 前本地执行 `npm run verify`。

需要在仓库 Secrets 配置 `NPM_TOKEN`（npm → Access Tokens → Granular Token，勾选 publish 权限）。

## 端到端主流程

```text
飞书任务中心 / 文档 / 群聊
  → 列出或读取；标题/描述含飞书链接则展开一层详情（仅展示，不自动写看板；单次最多展开约 10 条）
  → 「写进 helios-kanban」：展示标题 + 需求摘要草稿
       → 代码层写操作闸门确认（终端 y/b/N，或飞书确认卡片）→ create（不自动 start）
  → 同一飞书来源已同步过 → 拦截并提示已有任务（任务被删后映射会自愈，可再同步）
  → 之后是否 start、用谁跑：听你的（Claude / Kimi / Codex / 看板默认 …）
```

| 阶段 | 谁做 | 产物 |
|------|------|------|
| 拉任务 / 展开链接 | Task Agent + `lark_cli` | 对话里的任务/文档摘要 |
| 写入看板 | Task Agent + MCP / `hk_cli` | kanban 任务（来源 + 需求内容） |
| 启用任务 | **你指定** | workspace（可选） |

## 安全机制

「agent 不擅自行动」由**代码闸门**保障，不靠 prompt 自觉：

| 机制 | 说明 |
|------|------|
| 写操作闸门 | 建/改/删任务、start/stop/follow-up、审批、飞书发消息等，执行前必须确认。终端：`y`（仅此次）/`b`（同类免问）/`N`；无超时（确认提示时 Ctrl+C = 拒绝）。飞书：确认卡片（仅非破坏性操作带「同类免问 10 分钟」按钮），或回复「确认 / 都允许 / 取消」（仅严格同义词，随意「好/ok」无效）；可批量操作 120 秒、破坏性操作与飞书写操作 300 秒超时自动拒绝；决策/超时后卡片更新为终态。新确认会**作废**未处理的旧确认并通知你。闸门缺失时**全部写操作失败关闭** |
| 批量确认 | 「同类免问」后 10 分钟内同类型写操作自动放行；「确认」默认**仅此次**。删除/取消/停止/deny 等破坏性操作始终逐次确认。**飞书写操作不支持同类免问**。回复「恢复确认」或 `/confirm on` 立即撤销 |
| 会话创建上限 | 单会话最多创建 **10** 个看板任务；超限需 `/clear` 后再建 |
| 只读白名单 | `lark_cli`：list/get/search 等只读直接放行；写操作与未知命令进闸门；`api` 仅 GET 免确认 |
| 防注入标记 | `lark_cli` 读回内容包裹 UNTRUSTED；其中「指令」无效。被骗发起写操作仍会被闸门拦下，且拒绝后禁止换工具重试同一操作 |
| owner 认领 | `FEISHU_ALLOWED_OPEN_IDS` 留空时，首个私聊用户自动成为 owner 并写回 `.env`；其余用户拒绝（每人只提示一次） |
| 来源查重 | 飞书链接 → 任务映射按用户分桶存 `synced-sources.json`；重复同步拦截。原任务已删则映射清理后可再同步；看板不可达时保守拦截 |
| 审计日志 | 批准/拒绝/重复拦截（`blocked_dup`）/无闸门/执行结果等追加到 `audit.log`（JSONL） |
| workspace 就绪 | start 时补齐仓库 `base_branch`；检测 setup 静默失败，避免 UI 无限转圈 |

## 看板状态推送（bot）

约每 60s 轮询看板（可调）。任务进入待审阅（`inreview`，附 diff 直链）/完成（附摘要）/取消、执行失败、新待审批 → 推送飞书并注入会话上下文，可直接回「这个怎么样 / 帮我 review」。

- 首轮只建基线（`watch-state.json`），重启不重复打扰  
- **不**推送「新创建的任务」  
- 若配置了 `HELIOS_KANBAN_PROJECT_ID`，只监控该项目  
- `KANBAN_WATCH=0` 关闭；`KANBAN_WATCH_INTERVAL_SEC` 调间隔（最小 15）

## MCP 健康监督（bot）

约每 60s 探测 MCP：掉线降级 `hk_cli` 并自动重连（退避至约 5 分钟一次），恢复后切回（掉线/恢复都会通知）。`hk_cli` **始终注册**（内置 `skills/helios-kanban-remote/scripts/hk.sh`）；MCP 优先，缺能力或掉线时用 `hk_cli` 补充。

## 配置目录（Hermes 风格）

```text
~/.helios-task-agent/.env
~/.helios-task-agent/memory.json
~/.helios-task-agent/synced-sources.json   # 飞书来源 → 看板任务（查重）
~/.helios-task-agent/audit.log             # 写操作审计（JSONL）
~/.helios-task-agent/watch-state.json      # 看板推送快照
```

### 终端

```bash
helios-task-agent
```

首次运行引导配置 LLM（可选预设：Kimi Coding / Moonshot 国内·国际 / OpenAI / DeepSeek / 自定义），并可填写看板 URL / 默认 project、repo、iteration。也可直接编辑 `.env`。

### 飞书私聊机器人

```bash
helios-task-agent bot
# 或
helios-task-agent-bot
```

1. **缺凭证时**进入向导：开放平台清单 + App ID / Secret（及 LLM），并**默认联网校验**（无效可重输；也可选择仍保存后再排查）  
2. 在 [飞书开放平台](https://open.feishu.cn/) 建机器人（长连接 + `im.message.receive_v1`）  
3. 保存后建立长连接；手机**私聊**即可（仅 p2p，忽略群消息）  

无需公网 Webhook。进程在线才能收消息。

**改配置**：编辑 `~/.helios-task-agent/.env`。bot **没有** `/config`；凭证已存在时重跑 bot **不会**再进向导——要重跑向导请先删掉或清空 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。终端可用 `/config` 改模型与看板地址。

## 命令

| 命令 | 作用 |
|------|------|
| `helios-task-agent` | 交互式终端 Agent |
| `helios-task-agent bot` | 飞书私聊机器人（缺凭证则向导） |
| `helios-task-agent-bot` | 同上 |
| `helios-task-agent help` / `-h` / `--help` | 帮助 |

本地开发：`npm start` / `npm run bot`。

**看板进程**：仅当 `HELIOS_KANBAN_URL` 指向本机时才会自动 `npx helios-kanban`。CLI 退出**保留**自动拉起的看板；bot 退出会**停掉**该子进程。远程 URL 需自行保证看板已运行。

## 环境变量

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 必填（向导可写） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | bot 必填（向导可写） |
| `FEISHU_ALLOWED_OPEN_IDS` | 可选 open_id 白名单；**留空则首个私聊用户成为 owner** |
| `HELIOS_KANBAN_URL` | 看板地址，默认 `http://localhost:7964` |
| `HELIOS_KANBAN_AUTO_START` | 默认开；本机看板未就绪时自动拉起；`0` 关闭 |
| `HELIOS_KANBAN_MCP_COMMAND` / `HELIOS_KANBAN_MCP_ARGS` | MCP 启动命令，默认 `npx` + `-y helios-kanban@latest --mcp` |
| `HELIOS_KANBAN_PROJECT_ID` / `REPO_ID` / `ITERATION` | 可选默认；设了 `PROJECT_ID` 时 bot 推送只盯该项目 |
| `HELIOS_TASK_AGENT_HOME` | 数据目录，默认 `~/.helios-task-agent` |
| `HELIOS_TASK_AGENT_ENV` | 强制 `.env` 路径（写入目标；加载优先级最高） |
| `KANBAN_WATCH` | bot 看板推送，默认开；`0` 关闭 |
| `KANBAN_WATCH_INTERVAL_SEC` | 推送间隔秒（默认 60，最小 15） |
| `HTA_DEBUG` | `1` 时输出 kanban 子进程 / MCP 调试日志 |

加载顺序：项目 `.env` → 当前目录 `.env` → 用户目录 `.env`（后者覆盖；用户目录是向导写入目标），`HELIOS_TASK_AGENT_ENV` 最高。见 [.env.example](.env.example)。

### 开放平台清单

1. 创建企业自建应用 → 启用机器人  
2. 事件订阅 → **长连接** → `im.message.receive_v1`  
3. （可选）回调订阅 → **长连接** → `card.action.trigger`（确认卡片按钮）；不配则纯文本确认，功能不变  
4. 权限：读单聊消息、以应用身份发消息 → 发布  
5. 复制 App ID / App Secret  

## 飞书 / 终端里可以说

**终端命令**：`/help` `/config` `/status` `/tools` `/memory` `/clear` `/confirm`（查免问状态）`/confirm on`（撤销免问）`/exit` 或 `/quit`（运行中 Ctrl+C 只中断当前轮；确认提示时 Ctrl+C = 拒绝该写操作）

**飞书命令**：`/help` `/status` `/tools` `/memory` `/clear` `/confirm` `/confirm on` `/stop`（中断当前任务并取消待确认写操作）。`/stop` `/confirm` `/status` `/tools` **即时响应**；`/memory` `/clear` 与普通对话一样排队。回复「恢复确认」等同撤销免问。

**自然语言示例**：

- 「以后都从这个飞书地址同步任务：\<链接\>」
- 「同步 / 列出我的任务」（含链接则展开详情）
- 「写进 helios-kanban」（确认后创建；不自动启动）
- 「把 xx 群最近的聊天整理成任务」
- 「用 Claude 跑这个任务」「start」（你指定何时、用谁）
- 「有哪些项目」「创建一个任务：…」「跑得怎么样」「再跟它说一句…」

bot 支持文字与 post（富文本：链接/@/图片/文件/代码块等转纯文本）；其它消息类型会提示不支持。长回复按约 3000 字拆分；进度约每 2 秒原地更新。同一 `message_id` 10 分钟内去重。每用户消息串行；忙或确认挂起时新消息会收到排队/提示回执。

记忆按飞书 `open_id`（bot）或 `local`（终端）分桶。工具：`memory_set` / `get` / `delete` / `note`（备注约保留最近 50 条）。常用键：`feishu_task_source`、`feishu_chat_id`、`preferred_project_id` / `repo_id` / `iteration`、`last_sync_at`。

## 工具一览

| 工具 | 作用 |
|------|------|
| `lark_cli` | 飞书读写（任务、文档、群消息等） |
| kanban MCP | 优先的看板操作 |
| `hk_cli` | 始终可用；跑内置 `hk.sh`（HTTP REST），MCP 掉线或缺能力时补充 |
| `repo_fs` | 可选：对看板关联仓库本机 path 做 `list` / `read` / `grep`（不可越界） |
| `memory_*` | 持久化偏好与备注 |

包内自带技能目录：`skills/helios-kanban-remote/`（含 `SKILL.md`、`scripts/hk.sh`）。

## 依赖组件

- **helios-kanban**：本机 URL 未就绪时可自动拉起（`HELIOS_KANBAN_AUTO_START=0` 关闭）  
- **lark-cli**（推荐）：读飞书  

## 开发

```bash
npm install
npm run typecheck
npm run smoke
npm run test:e2e   # mock 链路，不需真实 LLM
npm run build
```

也可作为库嵌入（见 `src/index.ts` 导出）。

## License

ISC
