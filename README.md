# Helios Task Agent

**中文** | [English](./README.en.md)

终端 / 飞书私聊智能体：把飞书任务与文档整理进 [helios-kanban](https://github.com/SolomonFang/vibe-kanban)（npm 包名是 `helios-kanban`，GitHub 仓库名是 `SolomonFang/vibe-kanban`，同一个项目，搜仓库时请用后者）。

**是否启动 coding agent、用哪个 executor，由你决定。**

核心亮点：

- **写操作安全闸门（代码强制，不靠 prompt 自觉）**：建/改/删任务、start/stop、审批、发飞书消息等，执行前必须确认——终端 `y/batch/N`，飞书端确认卡片；闸门缺失时全部写操作失败关闭
- **看板零预装**：本机 helios-kanban 不可达时自动拉起，马上就能建任务
- **自然语言驱动**：「同步我的飞书任务」→「写进 helios-kanban」→「用 Claude 跑这个任务」，是否启动、用谁跑都听你的

## 60 秒跑起来（只需一个 LLM API Key）

```bash
npx helios-task-agent@latest
```

向导只需选一个 LLM 预设并填 API Key（看板默认值可一路回车跳过）。看板**无需预装**，本机不可达时自动拉起——马上就能建任务、跑任务。首次自动拉起看板时 npx 需下载 helios-kanban 组件（约几十秒，网络慢时重试即可）。飞书相关为可选升级：读飞书任务/文档需另装 lark-cli（约 2 分钟，见「安装」一节）；飞书私聊机器人见下文。

## 两种形态：CLI 与飞书 bot

- **终端 CLI**（`helios-task-agent`）：快速试用与调试。对话、写操作确认（`y/batch/N`）、看板操作全部可用。
- **飞书私聊 bot**（`helios-task-agent bot`）：完整体验。在 CLI 能力之上多出几项 bot 专属能力——**看板状态推送**（任务待审阅/完成主动推卡片）、**确认卡片**（按钮点选确认）、**AI 审查**（待审阅 diff 一键调用 open-code-review，推 HTML 报告链接）、**定时晨报**（`HTA_DAILY_BRIEF=HH:MM`，每天定时向白名单用户（owner）推送当前迭代看板概览）、**图片消息**（`LLM_VISION=1`，需模型支持图片输入）。

## 安装

要求：Node.js ≥ 20，macOS / Linux。

```bash
npm i -g helios-task-agent
```

然后直接运行（首次启动进入交互向导，配置自动写入 `~/.helios-task-agent/.env`）：

```bash
helios-task-agent        # 终端交互 agent
helios-task-agent bot    # 飞书私聊机器人
helios-task-agent --version   # 查看版本
```

**自动更新检查**：启动时会探测 npm 上的新版本（结果缓存 24 小时，离线自动跳过；跟随你 npm 配置的 registry 镜像），发现新版本会附变更记录（CHANGELOG）链接并请示是否立即更新。`HTA_UPDATE_CHECK=0` 关闭；手动更新：`npm i -g helios-task-agent@latest`。

**helios-kanban 无需预装**：本机看板不可达时 agent 会自动 `npx -y helios-kanban@latest` 拉起（默认跟随最新版，`HELIOS_KANBAN_PACKAGE` 可覆盖为指定版本；监听地址默认 `127.0.0.1`）。可用 `HELIOS_KANBAN_URL` 指向已有实例，`HELIOS_KANBAN_AUTO_START=0` 关闭自动拉起。

**飞书读取需另装 lark-cli**（不装则飞书任务/文档读取不可用，看板功能不受影响）：

```bash
npm i -g @larksuite/cli && lark-cli auth login
```

从源码开发：`npm install && npm start`。

## 端到端主流程

```text
飞书任务中心 / 文档 / 群聊
  → 列出或读取；标题/描述含飞书链接则展开一层详情（仅展示，不自动写看板；单次最多展开约 10 条）
  → 「写进 helios-kanban」：展示标题 + 需求摘要草稿
       → 代码层写操作闸门确认（终端 y/batch/N，或飞书确认卡片）→ create（不自动 start）
  → 同一飞书来源已同步过 → 拦截并提示已有任务（任务被删后映射会自愈，可再同步）
  → 之后是否 start、用谁跑：听你的（Claude / Kimi / Codex / 看板默认 …）
```

| 阶段 | 谁做 | 产物 |
|------|------|------|
| 拉任务 / 展开链接 | Task Agent + `lark_cli` | 对话里的任务/文档摘要 |
| 写入看板 | Task Agent + MCP / `hk_cli` | kanban 任务（来源 + 需求内容） |
| 启用任务 | **你指定** | 工作区（可选） |

## 安全机制

「agent 不擅自行动」由**代码闸门**保障，不靠 prompt 自觉：

| 机制 | 说明 |
|------|------|
| 写操作闸门 | 建/改/删任务、start/stop/follow-up、审批、飞书发消息等，执行前必须确认。终端：`y`（仅此次）/`batch`（同类免问）/`N`（应答词表与飞书端一致：确认/批准/同意/执行、同类免问/批量允许 等）；普通写操作 120 秒、破坏性操作 300 秒未操作自动拒绝，确认提示时 Ctrl+C = 拒绝。飞书：确认卡片（所有写操作都带「同类免问（本会话）」按钮），或回复「确认 / 同类免问 / 取消」（仅严格同义词，随意「好/ok」无效）；超时策略与终端一致；决策/超时后卡片更新为终态。新确认会**作废**未处理的旧确认并通知你。闸门缺失时**全部写操作失败关闭** |
| 批量确认 | 「同类免问」后本会话内同类型写操作自动放行（内存态授权，重启即失效）；「确认」默认**仅此次**。**所有写操作都可同类免问**，免问粒度分两档：启动/创建类按工具成类（`start_workspace`、`hk start` 点一次免问后，本会话内批量启动任意任务的工作区不再逐次确认）；删除/取消/停止/审批/更新等按工具名+对象标识成类（免问仅对同一对象生效，防止借授权改任意任务；卡片与回执如实标注「同对象免问」）。飞书写按命令路径+接收对象各自成类（如 `im send` 发给 `ou_x` 与发给 `ou_y` 不同类），技能脚本按具体脚本+参数成类，记忆写按 set/delete/note 分动作。删除/取消/停止/审批/启动/归档/合并/推送/执行等破坏性操作只是确认超时更长（300 秒），不再被排除在免问之外。回复「恢复确认」或 `/confirm revoke` 立即撤销（`/confirm on` 为兼容别名） |
| 会话创建上限 | 单会话最多创建 **10** 个看板任务；超限需 `/clear` 后再建 |
| 只读白名单 | `lark_cli`：list/get/search 等只读直接放行；写操作与未知命令进闸门；`api` 仅 GET 免确认；`update`（自更新）与夹带参数的 `--help` 按写操作处理 |
| 防注入标记 | `lark_cli` / 看板工具（MCP、`hk_cli`）/ `repo_fs` 的读回内容，以及看板事件、AI 审查结果的会话注入，统一包裹 UNTRUSTED；其中「指令」无效。被骗发起写操作仍会被闸门拦下，且拒绝后禁止换工具重试同一操作 |
| owner 认领 | `FEISHU_ALLOWED_OPEN_IDS` 留空时，首个私聊用户自动成为 owner 并写回 `.env`；其余用户拒绝（每人只提示一次） |
| 来源查重 | 飞书链接 → 任务映射按用户分桶存 `synced-sources.json`；重复同步拦截。原任务已删则映射清理后可再同步；看板不可达时保守拦截 |
| 审计日志 | 批准/拒绝/重复拦截（`blocked_dup`）/无闸门/执行结果等追加到 `audit.log`（JSONL） |
| 工作区就绪 | start 时补齐仓库 `base_branch`；检测 setup 静默失败，避免 UI 无限转圈 |

## 看板状态推送（bot）

约每 60s 轮询看板（可调）。任务进入待审阅（`inreview`，附 diff 直链）/完成（附摘要）/取消、执行失败、新待审批 → 推送飞书并注入会话上下文，可直接回「这个怎么样 / 帮我审一下」。

待审阅卡片带两个按钮：「🔍 人工审查」打开看板 diff 视图；「🤖 AI 审查」调用 [open-code-review](https://github.com/alibaba/open-code-review)（`ocr`）审查该 attempt 的 diff（与看板 diff 视图同口径：merge-base(target)..attempt 分支），结果要求简体中文输出，完整内容渲染为 HTML 报告（写入数据目录 `reviews/`，由 bot 内置静态服务托管），飞书只推报告链接（长结果不再截断），同时注入会话（可直接回「按审查意见修一下」）。

- 首轮只建基线（`watch-state.json`），重启不重复打扰  
- **不**推送「新创建的任务」  
- 推送失败不推进状态快照，恢复后自动重投（可能重复，优于丢事件）  
- 若配置了 `HELIOS_KANBAN_PROJECT_ID`，只监控该项目  
- `KANBAN_WATCH=0` 关闭；`KANBAN_WATCH_INTERVAL_SEC` 调间隔（最小 15）
- AI 审查：`ocr` 未安装时自动 `npx` 拉取（钉版本，`OCR_PACKAGE` 可覆盖；首次较慢）；LLM 默认复用机器人模型配置（派生 `OCR_LLM_*`，即 ocr 子进程会获得你的 LLM key `OCR_LLM_TOKEN`——可用独立的 `OCR_LLM_TOKEN` 环境变量覆盖以隔离主 key），已显式配置 `OCR_LLM_URL` 或 `~/.opencodereview/config.json` 时优先用你自己的配置；整体超时 15 分钟；报告服务监听随机空闲端口（绑定地址 `HELIOS_REPORT_HOST`，默认 `127.0.0.1`）；报告链接主机名取值规则：`HELIOS_KANBAN_URL` 为回环地址（localhost/127.0.0.1/::1）时沿用其主机名（与看板链接可达性一致）；看板为非回环地址（如局域网 IP）时链接主机名取报告服务**绑定地址**——默认即 `127.0.0.1`（此时报告链接仅本机可开），绑定 `0.0.0.0` 时链接主机名会回退为本机主机名（`os.hostname()`），局域网/手机端未必能解析，建议显式绑定本机局域网 IP；进程存活期间有效，历史报告 30 天自动清理

> **手机可达性**：推送卡片里的看板链接与 AI 审查报告链接都指向运行 bot 的机器。`HELIOS_KANBAN_URL` 为默认 `http://localhost:7964` 时这些链接**仅本机可开，手机上全是死链**（bot 启动时会就此输出警告）。手机审查的正确配法：`HELIOS_KANBAN_URL` 配为该机器的局域网 IP 或 Tailscale 地址，**同时**把 `HELIOS_REPORT_HOST` 显式设为同一局域网 IP（不要设 `0.0.0.0`——链接主机名会回退为本机主机名（`os.hostname()`），手机端未必能解析）；只改 `HELIOS_KANBAN_URL` 时报告链接主机名会退回默认绑定地址 `127.0.0.1`，手机仍打不开。若看板保持回环地址，报告链接主机名也跟随回环，**目前没有让手机访问报告的办法**。报告 URL 带随机 token。

## MCP 健康监督（bot）

约每 60s 探测 MCP：连续探测失败才降级 `hk_cli`（避免瞬时抖动误报）并自动重连（退避至约 5 分钟一次；有任务执行中不重连，避免打断进行中的工具调用），恢复后切回（掉线/恢复都会通知）。`hk_cli` **始终注册**（内置 `skills/helios-kanban-remote/scripts/hk.sh`）；MCP 优先，缺能力或掉线时用 `hk_cli` 补充。

## 配置目录

```text
~/.helios-task-agent/.env
~/.helios-task-agent/memory.json
~/.helios-task-agent/synced-sources.json   # 飞书来源 → 看板任务（查重）
~/.helios-task-agent/audit.log             # 写操作审计（JSONL）
~/.helios-task-agent/watch-state.json      # 看板推送快照
~/.helios-task-agent/daily-brief-state.json # 定时晨报推送日期（当天不重复推）
~/.helios-task-agent/sessions/             # 会话历史（每用户一个文件，重启后恢复上下文；/clear 同步清除）
~/.helios-task-agent/skills/               # 用户技能目录（/skills install 安装到这里）
~/.helios-task-agent/reviews/              # AI 审查报告（HTML，30 天自动清理）
~/.helios-task-agent/reports/              # 工作总结报告
~/.helios-task-agent/update-check.json     # 更新检查缓存（24h）
```

### 终端

```bash
helios-task-agent
```

首次运行引导配置 LLM（可选预设：Kimi Coding / Moonshot 国内·国际 / OpenAI / DeepSeek / 自定义；API Key 掩码输入），并可填写看板 URL / 默认 project、repo、iteration。也可直接编辑 `.env`。

### 飞书私聊机器人

```bash
helios-task-agent bot
# 或
helios-task-agent-bot
```

1. **缺凭证时**进入向导：开放平台清单 + App ID / Secret（及 LLM），并**默认联网校验**（无效可重输；也可选择仍保存后再排查）  
2. 在 [飞书开放平台](https://open.feishu.cn/) 建机器人（长连接 + `im.message.receive_v1`）  
3. 保存后建立长连接；手机**私聊**即可（仅 p2p，忽略群消息）  

无需公网 Webhook。进程在线才能收消息；常驻运行可用 `pm2 start helios-task-agent -- bot`（或任何进程守护方式）。

**改配置**：换模型 / Base URL / API Key 用 `helios-task-agent bot --reconfig` 重跑模型/看板配置向导（飞书凭证保留），不用手编 `.env`；也可直接编辑 `~/.helios-task-agent/.env`。bot **没有** `/config`；凭证已存在时重跑 bot **不会**再进向导——绑错机器人要换绑时用 `helios-task-agent bot --rebind`（只重跑飞书凭证向导，模型/看板配置保留；白名单可输入 `-` 清除）。终端可用 `/config` 改模型与看板地址。

## 命令

| 命令 | 作用 |
|------|------|
| `helios-task-agent` | 交互式终端 Agent |
| `helios-task-agent bot` | 飞书私聊机器人（缺凭证则向导） |
| `helios-task-agent bot --rebind` | 换绑飞书机器人（只重跑飞书凭证向导） |
| `helios-task-agent bot --reconfig` | 重跑模型/看板配置向导，飞书凭证保留（换模型/Base URL/Key 不用手编 `.env`） |
| `helios-task-agent-bot` | 同 `bot`（同样支持 `--rebind` / `--reconfig`） |
| `helios-task-agent help` / `-h` / `--help` | 帮助 |
| `helios-task-agent --version` / `-v` | 查看版本 |

本地开发：`npm start` / `npm run bot`。

## 添加技能

文档型技能：在 `<数据目录>/skills/<技能名>/` 下放一个带 frontmatter 的 `SKILL.md` 即可——启动时自动扫描，无需改代码。数据目录为 `HELIOS_TASK_AGENT_HOME` 或默认 `~/.helios-task-agent`（与 `.env`、记忆同级）；自定义技能放这里，`npm i -g` 升级不会被抹掉。扫描顺序：**用户数据目录优先，包内 `skills/` 作内置兜底**，同名技能以用户目录为准。

安装与卸载有正式入口（CLI 与飞书 bot 一致）：`/skills install <技能目录路径>` 把本地技能目录复制进数据目录（同名覆盖即更新），`/skills uninstall <技能名>` 卸载（包内内置技能不可卸载）。**不要**把自定义技能放进包内 `skills/`（npm 安装目录，升级会被整目录替换）——历史误放的技能会在启动时自动迁移到数据目录并打印提示。frontmatter 就是技能契约：

```markdown
---
name: my-skill
description: 一句话说明什么时候用这个技能（路由依据，始终注入系统提示词）
digest_sections:        # 声明哪些 `## ` 章节注入系统提示词（大小写不敏感子串匹配）
  - Quick workflow
  - Safety rules
---

# My Skill
正文……未声明的章节不进提示词，agent 需要细节时会用 `skill_doc` 工具按需读取全文（渐进式披露）。
```

- `name` / `description` 缺失或 `digest_sections` 匹配不到章节时，`validateSkills()` 会报出契约问题——启动时即告警（CLI 与 bot 都会打印），并有单元测试覆盖，而不是静默降级。
- 用户侧可用 `/skills`（CLI 与飞书 bot 一致）或直接问「你有什么技能」查看已安装技能。
- 技能自带脚本（node/shell/python 等）可直接运行：在 SKILL.md 里写明用法，agent 会用 `skill_exec` 工具执行——脚本路径限定在技能目录内（拒绝 `..`/绝对路径/符号链接逃逸），按扩展名自动选解释器（`.sh`→bash、`.js/.mjs/.cjs`→node、`.py`→python3，其他需显式 `interpreter`，白名单 bash/sh/node/python3/python），工作目录为技能目录，**每次执行都向用户弹确认**（任意代码执行，按破坏性对待、超时 300 秒；「同类免问」按具体脚本+参数生效），子进程只继承最小环境变量。

**看板进程**：仅当 `HELIOS_KANBAN_URL` 指向本机时才会自动 `npx helios-kanban`。CLI 退出**保留**自动拉起的看板；bot 退出会**停掉**该子进程。远程 URL 需自行保证看板已运行。注意：看板 API 无鉴权，`HELIOS_KANBAN_URL` 指向非本机地址时流量为明文且无认证，请仅在可信网络（内网 / Tailscale）使用。

## 环境变量

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 必填（向导可写） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | bot 必填（向导可写） |
| `FEISHU_ALLOWED_OPEN_IDS` | 可选 open_id 白名单；**留空则首个私聊用户成为 owner**（先聊先得，机器人可被他人搜到时存在被抢占风险，建议显式配置） |
| `HELIOS_KANBAN_URL` | 看板地址，默认 `http://localhost:7964` |
| `HELIOS_KANBAN_AUTO_START` | 默认开；本机看板未就绪时自动拉起；`0` 关闭 |
| `HELIOS_KANBAN_MCP_COMMAND` / `HELIOS_KANBAN_MCP_ARGS` | MCP 启动命令，默认 `npx` + `-y helios-kanban@latest --mcp` |
| `HELIOS_KANBAN_PACKAGE` | 自动拉起 / MCP 默认的 helios-kanban 包规格，默认 `helios-kanban@latest` 跟随最新版，可改为指定版本 |
| `HELIOS_KANBAN_HOST` | 自动拉起看板的监听地址，默认 `127.0.0.1`（看板 Web/API 无鉴权，谨慎改为 `0.0.0.0`） |
| `HELIOS_REPORT_HOST` | AI 审查报告静态服务的监听地址，默认 `127.0.0.1`（**不跟随** `HELIOS_KANBAN_HOST`；报告含代码 diff，确需对外暴露才改） |
| `OCR_PACKAGE` | AI 审查在 `ocr` 未安装时 npx 拉取的包规格，默认钉版本 `@alibaba-group/open-code-review@1.8.0` |
| `OCR_LLM_TOKEN` | AI 审查专用 LLM key；设置后优先于机器人主 key 派生（避免把主 key 交给第三方 ocr 子进程），URL/模型仍回退机器人配置 |
| `OCR_LLM_URL` / `OCR_LLM_MODEL` | 显式指定 AI 审查的 LLM 端点/模型；设置后优先于从机器人配置派生 |
| `HELIOS_KANBAN_PROJECT_ID` / `HELIOS_KANBAN_REPO_ID` / `HELIOS_KANBAN_ITERATION` | 可选默认；设了 `HELIOS_KANBAN_PROJECT_ID` 时 bot 推送只盯该项目 |
| `HELIOS_TASK_AGENT_HOME` | 数据目录，默认 `~/.helios-task-agent` |
| `HELIOS_TASK_AGENT_ENV` | 强制 `.env` 路径（写入目标；加载优先级最高） |
| `KANBAN_WATCH` | bot 看板推送，默认开；`0` 关闭 |
| `KANBAN_WATCH_INTERVAL_SEC` | 推送间隔秒（默认 60，最小 15） |
| `HTA_UPDATE_CHECK` | 启动时检查 npm 新版本，默认开；`0` 关闭 |
| `HTA_UPDATE_REGISTRY` | 更新检查用的 npm registry（默认跟随 `npm config get registry`） |
| `LLM_VISION` | `1` 时 bot 支持图片消息：下载图片随当次请求发给模型（**需模型支持图片输入**；图片不进会话历史、不落盘，单张上限 10MB）。默认关，关闭时图片消息仍提示仅支持文字 |
| `HTA_DAILY_BRIEF` | 定时晨报（仅 bot）：本地时间 `HH:MM`（如 `09:30`）每天向白名单用户（owner）推送当前迭代看板概览（进行中/待审阅/已完成/失败；未配置 `HELIOS_KANBAN_ITERATION` 时范围为全部迭代）。未设置或非法值 = 关闭 |
| `HTA_TURN_TIMEOUT_MIN` | 单轮对话的墙钟时间上限（分钟），默认 30；超时按「已中止」收尾并提示 |
| `HTA_DEBUG` | `1` 时输出 kanban 子进程 / MCP 调试日志 |

加载顺序：项目 `.env` → 当前目录 `.env` → 用户目录 `.env`（后者覆盖；用户目录是向导写入目标），`HELIOS_TASK_AGENT_ENV` 最高。见 [.env.example](.env.example)。注意：**当前目录 `.env` 中的凭证/命令类高危键不参与覆盖**（`LLM_API_KEY`、`FEISHU_*`、`HELIOS_KANBAN_MCP_COMMAND/ARGS`、`HELIOS_KANBAN_PACKAGE`、`HELIOS_KANBAN_URL`、代理与 npm registry 等，防供应链/命令注入；被忽略时仅输出一行 `console.warn`）——这类键请写入 `~/.helios-task-agent/.env`（或 shell 环境 / 项目 `.env`）。

### 开放平台清单

1. 创建企业自建应用 → 启用机器人  
2. 事件订阅 → **长连接** → `im.message.receive_v1`  
3. （可选）回调订阅 → **长连接** → `card.action.trigger`（确认卡片按钮）；不配则纯文本确认，功能不变  
4. 权限：读单聊消息、以应用身份发消息、添加消息表情回复（敲键盘回执，缺失时自动降级为文字占位）→ 发布  
5. 复制 App ID / App Secret  

## 飞书 / 终端里可以说

**终端命令**：`/help` `/config` `/status` `/tools` `/skills` `/memory` `/clear` `/confirm`（查免问状态）`/confirm revoke`（撤销免问；`/confirm on` 为兼容别名）`/exit` 或 `/quit`（运行中 Ctrl+C 只中断当前轮；确认提示时 Ctrl+C = 拒绝该写操作）

**飞书命令**：`/help` `/status` `/tools` `/skills` `/memory` `/clear` `/confirm` `/confirm revoke` `/stop`（中断当前任务、取消待确认写操作并丢弃排队消息）。`/help` `/stop` `/confirm` `/status` `/tools` `/skills` **即时响应**；`/memory` `/clear` 与普通对话一样排队。回复「恢复确认」等同撤销免问。

**自然语言示例**：

- 「以后都从这个飞书地址同步任务：\<链接\>」
- 「同步 / 列出我的任务」（含链接则展开详情）
- 「写进 helios-kanban」（确认后创建；不自动启动）
- 「把 xx 群最近的聊天整理成任务」
- 「用 Claude 跑这个任务」「start」（你指定何时、用谁）
- 「有哪些项目」「创建一个任务：…」「跑得怎么样」「再跟它说一句…」

bot 支持文字与富文本消息（链接/@/图片/文件/代码块等转纯文本）；`LLM_VISION=1` 时可直接发图片消息（随当次请求发给模型分析，不落盘、不进会话历史，单张上限 10MB）；其它消息类型会提示不支持。长回复按约 3000 字拆分；进度占位随工具调用更新（约 2 秒节流），LLM 静默思考期间每 10 秒心跳刷新一次（附已等待秒数）。同一 `message_id` 10 分钟内去重。每用户消息串行；忙或确认挂起时新消息会收到排队/提示回执。群消息不处理，但在群里 @机器人 会回一句私聊指引（每群 24 小时最多一次），避免误以为机器人掉线。会话历史按用户落盘（`sessions/`），重启后自动恢复上下文，`/clear` 同步清除磁盘历史。

记忆按飞书 `open_id`（bot）或 `local`（终端）分桶。工具：`memory_set` / `get` / `delete` / `note`（备注约保留最近 50 条）。常用键：`feishu_task_source`、`feishu_chat_id`、`preferred_project_id` / `repo_id` / `iteration`、`last_sync_at`。

## 工具一览

| 工具 | 作用 |
|------|------|
| `lark_cli` | 飞书读写（任务、文档、群消息等） |
| kanban MCP | 优先的看板操作 |
| `hk_cli` | 始终可用；跑内置 `hk.sh`（HTTP REST），MCP 掉线或缺能力时补充 |
| `repo_fs` | 可选：对看板关联仓库本机 path 做 `list` / `read` / `grep`（不可越界） |
| `work_summary` | 生成工作总结报告（HTML/MD） |
| `skill_doc` | 按需读取已安装技能完整文档（SKILL.md） |
| `skill_exec` | 运行技能目录内脚本（默认逐次确认，同类免问按具体脚本+参数生效） |
| `memory_*` | 持久化偏好与备注 |

包内自带技能目录：`skills/helios-kanban-remote/`（含 `SKILL.md`、`scripts/hk.sh`）。

## 依赖组件

- **helios-kanban**：本机 URL 未就绪时可自动拉起（`HELIOS_KANBAN_AUTO_START=0` 关闭）  
- **lark-cli**（推荐）：读飞书  

## 开发

```bash
npm install
npm run typecheck
npm test          # 纯逻辑单元测试，无外部依赖
npm run smoke
npm run test:e2e   # mock 链路，不需真实 LLM
npm run build
```

也可作为库嵌入（导出见 GitHub 上的 [`src/index.ts`](https://github.com/SolomonFang/helios-task-agent/blob/main/src/index.ts)，发布包内对应 `dist/index.d.ts`）。

## 发布（维护者）

打 tag 即触发 GitHub Action 自动发布（`.github/workflows/publish.yml`）：

```bash
npm version patch          # 或 minor / major，自动改 version 并打 tag
git push --follow-tags     # 推送 commit + tag，触发发布
```

tag 必须与 `package.json` 的 `version` 一致（CI 会校验）。预发布版本（如 `1.1.0-beta.0`）自动发到 npm `next` 频道，正式版发到 `latest`。CI 发布前跑 typecheck + build（`prepublishOnly` / `prepack`）；smoke / e2e 依赖本机 helios-kanban，请在打 tag 前本地执行 `npm run verify`。

需要在仓库 Secrets 配置 `NPM_TOKEN`（npm → Access Tokens → Granular Token，勾选 publish 权限）。

## License

ISC
