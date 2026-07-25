# Helios Task Agent

[中文](#中文) | [English](#english)

终端 / 飞书私聊智能体：把飞书任务与文档整理进 [helios-kanban](https://github.com/SolomonFang/vibe-kanban)。  
Terminal / Feishu DM agent that turns Lark/Feishu tasks & docs into [helios-kanban](https://github.com/SolomonFang/vibe-kanban) cards.

**是否启动 coding agent、用哪个 executor，由你决定。**  
**Whether (and with which executor) to start a coding agent is always your choice.**

---

## 中文

### 端到端主流程

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

### 安全机制

「agent 不擅自行动」由**代码闸门**保障，不靠 prompt 自觉：

| 机制 | 说明 |
|------|------|
| 写操作闸门 | 建/改/删任务、start/stop/follow-up、审批、飞书发消息等，执行前必须确认。终端：`y`（仅此次）/`b`（同类免问）/`N`。飞书：三按钮确认卡片，或回复「确认 / 都允许 / 取消」（仅严格同义词，随意「好/ok」无效）。普通操作 120 秒、破坏性 300 秒超时自动拒绝；决策/超时后卡片更新为终态。新确认会**作废**未处理的旧确认并通知你。闸门缺失时**全部写操作失败关闭** |
| 批量确认 | 「同类免问」后 10 分钟内同类型写操作自动放行；「确认」默认**仅此次**。删除/取消/停止/deny 等破坏性操作始终逐次确认。**飞书写操作不支持同类免问**。回复「恢复确认」或 `/confirm on` 立即撤销 |
| 会话创建上限 | 单会话最多创建 **10** 个看板任务；超限需 `/clear` 后再建 |
| 只读白名单 | `lark_cli`：list/get/search 等只读直接放行；写操作与未知命令进闸门；`api` 仅 GET 免确认 |
| 防注入标记 | `lark_cli` 读回内容包裹 UNTRUSTED；其中「指令」无效。被骗发起写操作仍会被闸门拦下，且拒绝后禁止换工具重试同一操作 |
| owner 认领 | `FEISHU_ALLOWED_OPEN_IDS` 留空时，首个私聊用户自动成为 owner 并写回 `.env`；其余用户拒绝（每人只提示一次） |
| 来源查重 | 飞书链接 → 任务映射存 `synced-sources.json`；重复同步拦截。原任务已删则映射清理后可再同步；看板不可达时保守拦截 |
| 审计日志 | 请求/批准/拒绝/拦截重复/`blocked_dup` 等追加到 `audit.log`（JSONL） |
| workspace 就绪 | start 时补齐仓库 `base_branch`；检测 setup 静默失败，避免 UI 无限转圈 |

### 看板状态推送（bot）

约每 60s 轮询看板（可调）。任务进入待审阅（`inreview`，附 diff 直链）/完成（附摘要）/取消、执行失败、新待审批 → 推送飞书并注入会话上下文，可直接回「这个怎么样 / 帮我 review」。

- 首轮只建基线（`watch-state.json`），重启不重复打扰  
- **不**推送「新创建的任务」  
- 若配置了 `HELIOS_KANBAN_PROJECT_ID`，只监控该项目  
- `KANBAN_WATCH=0` 关闭；`KANBAN_WATCH_INTERVAL_SEC` 调间隔（最小 15）

### MCP 健康监督（bot）

约每 60s 探测 MCP：掉线降级 `hk_cli` 并自动重连，恢复后切回（掉线/恢复都会通知）。`hk_cli` **始终注册**（内置 `skills/helios-kanban-remote/scripts/hk.sh`）；MCP 优先，缺能力或掉线时用 `hk_cli` 补充。

### 安装

```bash
npm i -g helios-task-agent
# 或
npx helios-task-agent
```

Node.js >= 18。读飞书需要 **lark-cli**：

```bash
npm i -g @larksuite/cli && lark-cli auth login
```

不装则飞书读取不可用，看板功能不受影响。

### 配置目录（Hermes 风格）

```text
~/.helios-task-agent/.env
~/.helios-task-agent/memory.json
~/.helios-task-agent/synced-sources.json   # 飞书来源 → 看板任务（查重）
~/.helios-task-agent/audit.log             # 写操作审计（JSONL）
~/.helios-task-agent/watch-state.json      # 看板推送快照
```

#### 终端

```bash
helios-task-agent
```

首次运行引导配置 LLM（可选预设：Kimi Coding / Moonshot 国内·国际 / OpenAI / DeepSeek / 自定义），并可填写看板 URL / 默认 project、repo、iteration。也可直接编辑 `.env`。

#### 飞书私聊机器人

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

### 命令

| 命令 | 作用 |
|------|------|
| `helios-task-agent` | 交互式终端 Agent |
| `helios-task-agent bot` | 飞书私聊机器人（缺凭证则向导） |
| `helios-task-agent-bot` | 同上 |
| `helios-task-agent help` / `-h` / `--help` | 帮助 |

本地开发：`npm start` / `npm run bot`。

**看板进程**：仅当 `HELIOS_KANBAN_URL` 指向本机时才会自动 `npx helios-kanban`。CLI 退出**保留**自动拉起的看板；bot 退出会**停掉**该子进程。远程 URL 需自行保证看板已运行。

### 环境变量

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

#### 开放平台清单

1. 创建企业自建应用 → 启用机器人  
2. 事件订阅 → **长连接** → `im.message.receive_v1`  
3. （可选）回调订阅 → **长连接** → `card.action.trigger`（确认卡片按钮）；不配则纯文本确认，功能不变  
4. 权限：读单聊消息、以应用身份发消息 → 发布  
5. 复制 App ID / App Secret  

### 飞书 / 终端里可以说

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

### 工具一览

| 工具 | 作用 |
|------|------|
| `lark_cli` | 飞书读写（任务、文档、群消息等） |
| kanban MCP | 优先的看板操作 |
| `hk_cli` | 始终可用；跑内置 `hk.sh`（HTTP REST），MCP 掉线或缺能力时补充 |
| `repo_fs` | 可选：对看板关联仓库本机 path 做 `list` / `read` / `grep`（不可越界） |
| `memory_*` | 持久化偏好与备注 |

包内自带技能目录：`skills/helios-kanban-remote/`（含 `SKILL.md`、`scripts/hk.sh`）。

### 依赖组件

- **helios-kanban**：本机 URL 未就绪时可自动拉起（`HELIOS_KANBAN_AUTO_START=0` 关闭）  
- **lark-cli**（推荐）：读飞书  

### 开发

```bash
npm install
npm run typecheck
npm run smoke
npm run test:e2e   # mock 链路，不需真实 LLM
npm run build
```

设计文档：[docs/superpowers/](docs/superpowers/)。也可作为库嵌入（见 `src/index.ts` 导出）。

---

## English

### End-to-end flow

```text
Feishu Task Center / docs / group chats
  → List or read; expand Feishu URLs in title/description one hop (display only; ~10 expands per turn)
  → “Write to helios-kanban”: draft title + requirements summary
       → code write-gate confirm (terminal y/b/N or Feishu card) → create (no auto start)
  → Same Feishu source already synced → block and point to existing task
       (if that task was deleted, the mapping self-heals and sync can proceed)
  → Whether to start, and which executor: your call
```

| Stage | Who | Output |
|-------|-----|--------|
| Fetch / expand | Task Agent + `lark_cli` | In-chat summary |
| Write to board | Task Agent + MCP / `hk_cli` | Kanban task (source + requirements) |
| Run task | **You choose** | Workspace (optional) |

### Safety (code-enforced)

| Mechanism | Behavior |
|-----------|----------|
| Write gate | Creates/updates/deletes, start/stop/follow-up, approvals, Feishu sends require confirm. Terminal: `y` (once) / `b` (batch) / `N`. Feishu: 3-button card or strict phrases (确认 / 都允许 / 取消 — casual “ok” ignored). Timeouts 120s / 300s (destructive). New confirm **supersedes** a pending one. Missing gate → all writes fail closed |
| Batch approval | “Allow similar” for 10 minutes on the same write class; plain confirm is **once**. Destructive ops always re-ask. **Feishu writes never batch.** `/confirm on` or 恢复确认 revokes |
| Session create cap | Max **10** kanban creates per session; `/clear` resets |
| Read allowlist | `lark_cli` reads (list/get/search…) free; writes/unknown → gate; `api` GET only exempt |
| Untrusted wrap | `lark_cli` output marked UNTRUSTED; injected “instructions” ignored; rejected writes must not be retried via another tool |
| Owner claim | Empty `FEISHU_ALLOWED_OPEN_IDS` → first DM user becomes owner (written to `.env`); others rejected once |
| Source dedupe | URL → task map in `synced-sources.json`; self-heals after deletes; unreachable kanban conservatively blocks |
| Audit log | Approvals/denies/dup blocks → `audit.log` (JSONL) |
| Workspace ready | Fills `base_branch` on start; detects silent setup failures |

### Kanban status push (bot)

Polls ~every 60s. Pushes on in-review (diff link), done (summary), cancel, failure, new approvals — and injects session context so you can reply in-thread.

- First poll is baseline only (`watch-state.json`)  
- Does **not** notify on brand-new tasks  
- With `HELIOS_KANBAN_PROJECT_ID`, watches that project only  
- `KANBAN_WATCH=0` off; `KANBAN_WATCH_INTERVAL_SEC` (min 15)

### MCP health supervisor (bot)

~60s probe. On drop: fall back to `hk_cli`, reconnect, notify; on recover: switch back. `hk_cli` is **always** registered (bundled `hk.sh`); MCP is preferred.

### Install

```bash
npm i -g helios-task-agent
# or
npx helios-task-agent
```

Node.js >= 18. Feishu reads need **lark-cli**:

```bash
npm i -g @larksuite/cli && lark-cli auth login
```

### Config home (Hermes-style)

```text
~/.helios-task-agent/.env
~/.helios-task-agent/memory.json
~/.helios-task-agent/synced-sources.json
~/.helios-task-agent/audit.log
~/.helios-task-agent/watch-state.json
```

#### Terminal

```bash
helios-task-agent
```

First-run LLM wizard (presets: Kimi Coding / Moonshot CN·INTL / OpenAI / DeepSeek / custom) plus optional kanban defaults — or edit `.env`.

#### Feishu DM bot

```bash
helios-task-agent bot
# or
helios-task-agent-bot
```

1. Wizard when credentials are missing (online validation by default; you may force-save and fix later)  
2. Open Platform: long connection + `im.message.receive_v1`  
3. DM only (p2p); no public webhook; process must stay up  

**Reconfigure**: edit `~/.helios-task-agent/.env`. Bot has **no** `/config`; re-running bot with existing `FEISHU_*` does **not** reopen the wizard — clear those vars first. Terminal has `/config`.

### Commands

| Command | Purpose |
|---------|---------|
| `helios-task-agent` | Interactive terminal agent |
| `helios-task-agent bot` | Feishu DM bot (wizard if unconfigured) |
| `helios-task-agent-bot` | Same |
| `helios-task-agent help` / `-h` / `--help` | Help |

Local: `npm start` / `npm run bot`.

**Kanban process**: auto-start only for **localhost** URLs. CLI exit **keeps** an auto-started board; bot exit **stops** that child. Remote URLs must already be up.

### Environment variables

| Variable | Meaning |
|----------|---------|
| `LLM_*` | Required (wizard can write) |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Required for bot |
| `FEISHU_ALLOWED_OPEN_IDS` | Allowlist; empty → first DM user is owner |
| `HELIOS_KANBAN_URL` | Default `http://localhost:7964` |
| `HELIOS_KANBAN_AUTO_START` | Auto-spawn local board; `0` off |
| `HELIOS_KANBAN_MCP_COMMAND` / `ARGS` | Default `npx` + `-y helios-kanban@latest --mcp` |
| `HELIOS_KANBAN_PROJECT_ID` / `REPO_ID` / `ITERATION` | Optional defaults; `PROJECT_ID` scopes bot watch |
| `HELIOS_TASK_AGENT_HOME` / `ENV` | Data dir / forced `.env` path |
| `KANBAN_WATCH` / `KANBAN_WATCH_INTERVAL_SEC` | Status push |
| `HTA_DEBUG` | `1` = kanban/MCP debug logs |

Load order: project → cwd → home `.env` (later wins); `HELIOS_TASK_AGENT_ENV` highest. See [.env.example](.env.example).

#### Open-platform checklist

1. Company app → enable Bot  
2. Events → **long connection** → `im.message.receive_v1`  
3. (Optional) Callbacks → **long connection** → `card.action.trigger`  
4. Permissions: read DMs, send as app → publish  
5. Copy App ID / Secret  

### What you can say

**Terminal**: `/help` `/config` `/status` `/tools` `/memory` `/clear` `/confirm` `/confirm on` `/exit` `/quit` (Ctrl+C interrupts a turn; during a confirm prompt it rejects that write)

**Feishu**: `/help` `/status` `/tools` `/memory` `/clear` `/confirm` `/confirm on` `/stop`. Instant: `/stop` `/confirm` `/status` `/tools`. Queued: `/memory` `/clear` and normal chat.

**Examples**: sync/list Feishu tasks; write to helios-kanban; turn a group chat into tasks; start with a named executor; list projects; follow-up / status.

Bot accepts text + post; other types rejected. Replies split ~3000 chars; progress ~every 2s. Per-user serial queue; `message_id` dedupe 10 minutes.

Memory tools: `memory_set` / `get` / `delete` / `note`. Keys: `feishu_task_source`, `feishu_chat_id`, `preferred_*`, `last_sync_at`.

### Tools

| Tool | Role |
|------|------|
| `lark_cli` | Feishu/Lark I/O |
| kanban MCP | Preferred board API |
| `hk_cli` | Always on; bundled `hk.sh` REST fallback/supplement |
| `repo_fs` | Optional `list` / `read` / `grep` under a kanban repo path |
| `memory_*` | Persistent prefs & notes |

Bundled skill: `skills/helios-kanban-remote/`.

### Dependencies

- **helios-kanban** (local auto-start optional)  
- **lark-cli** (recommended for Feishu reads)  

### Development

```bash
npm install
npm run typecheck
npm run smoke
npm run test:e2e   # mock path, no real LLM
npm run build
```

Design notes: [docs/superpowers/](docs/superpowers/). Embeddable via `src/index.ts` exports.

---

## License

ISC
