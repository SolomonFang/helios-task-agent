# Changelog

本项目的所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- 「同类免问」覆盖全部写操作：此前破坏性看板操作（删除/取消/停止/审批/启动/归档/合并/推送/执行）、飞书写、记忆写、技能脚本一律逐次确认，确认卡片无「同类免问」按钮；现所有写操作都带 batchKey（看板/hk 绑定工具名+对象 id，lark 按命令路径如 `lark:im send`，技能脚本按 `skill:<名>/<脚本>`，记忆按 set/delete/note 分动作），所有确认卡片均可「同类免问」；破坏性判定改由 `ConfirmRequest.destructive` 承载（`guard.isBatchable` 更名 `isDestructive`），仅用于确认超时分级（300s vs 120s），不再影响免问资格
- 轮次内插入独立消息时的最终回复时序（bot）：确认卡片/超时提示等独立消息插在进度占位之后时，最终回复不再原地编辑占位（飞书编辑不改变消息位置，完成消息会停在卡片上方、时序颠倒），占位收尾为「✅ 已完成，结果见下方 ⬇️」，正文改发新消息落在时间线末尾；无插入消息时仍原地替换占位（见 `src/bot/handler.ts` 的 `RoundNoticeTracker` 与 `deliverReply` interleaved 分支）
- SourceRegistry 按文件 mtime 缓存解析结果，来源去重检查不再每次全量读盘；会话历史落盘改异步（串行队列，原子写/0600 语义不变），目录清理按 60s 节流；watcher 快照每 tick 只序列化一次，比较与写盘复用
- 任务状态元数据（key/中文 label）收口到 `src/kanban/status.ts` 唯一来源，report 层只保留 emoji/badge 展示扩展；删除 `InboundMessage.raw` 死字段，bot handler 签名直接收 `FeishuInboundMessage`（去掉入口强转）
- 测试与发布链路：新增 `scripts/unit-repo-fs.ts` / `scripts/unit-tools.ts`；smoke 的 MCP 调用断言修复永真问题（失败时返回错误字符串也会 PASS）；unit-kanban 契约用例补 jq/curl 探测（缺失时 SKIP）；verify 末尾补 `npm run build` + bin/dist 加载检查

### Security

- cwd .env 高危键过滤收口：`HELIOS_TASK_AGENT_ENV` 加入受限键（此前恶意仓库可借它把强制加载指向第二文件，完全绕过受限键过滤，注入 MCP 命令/LLM 外发地址），且强制加载改用 cwd .env 应用前的快照值；`OCR_LLM_URL/OCR_LLM_TOKEN/OCR_LLM_MODEL`（可劫持 AI 审查的代码 diff 外发）、`HTA_UPDATE_REGISTRY`、`HTA_TEST_CRASH` 一并纳入受限键

### Fixed

- CLI 启动窗口的信号处理：SIGINT/SIGTERM/异常处理与资源登记移到看板拉起与 MCP 连接之前（此前窗口内 SIGTERM 直接终止并遗留 MCP 孤儿子进程、Ctrl+C 不退出），并补齐此前缺失的 SIGTERM 处理
- `repo_fs` grep/list/read 异步化：大仓库的同步全树扫描不再阻塞 bot 事件循环（每 100 个文件让出一次），并新增扫描总量上限（5000 文件 / 50MB，截断时输出注明）
- 单会话创建上限（10 个）不再随 MCP 掉线重连被静默重置：创建计数提升为会话级状态，仅 `/clear` 重置（与「同类免问」授权的生命周期对齐）
- MCP start_workspace 的确认卡片/审计按分支补全后的最终参数展示（此前显示补全前旧值，与 hk 路径的惰性求值口径不一致）
- `hk_cli` 脚本定位与技能系统同口径：用户数据目录的 helios-kanban-remote 覆盖版优先，找不到回退包内脚本（此前 skill_doc 读用户版、hk_cli 却永远执行包内版）
- CLI 闸门确认因超时/Ctrl+C 中断后，不再吞掉用户在下一个提示符出现前输入的一行
- 看板自动拉起轮询先查健康再判子进程退出码，修复 detached npx 壳退出与看板就绪同时发生时的误报失败
- 飞书图片下载流加 60 秒整体超时：此前 body 读取中途 TCP 停滞会让该消息处理永久挂起且无任何用户反馈
- MCP close/重连失败时补杀残留孙进程（close 前快照子进程树、复核命令行防 pid 复用后 SIGTERM→SIGKILL），修复 supervisor 重连累积孤儿 MCP server 进程
- LLM 单轮对话加墙钟上限（默认 30 分钟，`HTA_TURN_TIMEOUT_MIN` 可覆盖），到点按「已中止」收尾并提示；轮次上限（25 轮）与工具调用上限（30 次）的提示文案区分开（此前轮次耗尽误报「工具调用已达上限 30 次」）
- kanban HTTP 层错误从 message 文本正则反解析升级为 `KanbanHttpError`（带 status 字段，message 格式不变）；ai-review 的看板响应补 validateRows/类型谓词校验，去掉裸 `as`

## [1.0.22] - 2026-08-10

### Added

- 图片消息接入（bot，`LLM_VISION=1` 开启，默认关）：图片消息下载后随当次请求以多模态 content 发给模型（需模型支持图片输入）；字节全程内存不落盘、不进会话历史（历史只存 `[图片] 配文` 占位），单张上限 10MB，流式下载中途超限即熔断，超限/下载失败均有友好中文提示；单测可注入 imageFetcher，不触网络
- 定时晨报（bot，`HTA_DAILY_BRIEF=HH:MM`，默认关）：每天到点向 owner 推送当前迭代看板概览（进行中/待审阅/已完成/失败分组；未配置 `HELIOS_KANBAN_ITERATION` 时范围为全部迭代）；到点前进程未启动当天可补推；推送日期落盘（`daily-brief-state.json`），重启当天不重复推；看板不可达/推送失败跳过并按 1→2→4…分钟指数退避重试（封顶 30 分钟）；owner 未认领不推；按 owner 粒度补投
- 会话历史持久化：`sessions/` 目录按用户分文件（原子写 0600、目录 0700、文件名防穿越），每轮对话结束落盘，重启/会话重建自动恢复上下文；`/clear` 同步清盘；注入的 system note 与「同类免问」授权维持内存态不落盘；目录文件上限 100 按 mtime 清理；读侧校验文件版本与 tool_calls 结构，版本不符按无历史处理、畸形条目丢弃
- 群 @ 回执（bot）：群里 @机器人 回一句私聊指引（每群 24 小时冷却，发送成功才记冷却；bot open_id 懒加载，获取失败按 10 分钟冷却重试）——此前群消息完全静默，用户无从得知 bot 只收私聊
- 进度占位静默期心跳（bot）：LLM 长思考无工具事件时每 10 秒刷新一次占位消息（附已等待秒数与 /stop 提示），回复就绪即停——此前占位原地不动，用户分不清「在想」还是「死了」

### Changed

- README 进度描述与实际行为对齐（原为「约每 2 秒原地更新」，实为工具调用事件驱动 + 静默期心跳），并补明群消息处理策略、会话历史持久化与图片消息/定时晨报两个新开关

## [1.0.21] - 2026-08-07

### Added

- 新增 `scripts/unit-feishu-filter.ts`：WS 事件入口过滤的真实单测（p2p 过滤、bot 发送者忽略、message_id 去重与 TTL、卡片回调 open_id 白名单、owner 认领 fail-closed 与阻断集）——此前这些防线零覆盖，唯一的「白名单」用例实际绕过了 feishu 层

### Changed

- 「同类免问」从 10 分钟 TTL 改为**会话级**：批准后同类写操作在本会话内持续免问（内存态授权，重启即失效），批量建任务不再被中途过期打断；授权仍可随时经「恢复确认」/ `/confirm revoke` 撤销，破坏性操作依然逐次确认、授权仍绑定任务标识。确认词表新增「一直允许 / 始终允许 / always」
- 大型函数拆分：`bot/handler.ts` 的 `handle`（约 260 行）按命令表驱动分发拆为十余个命名函数，`tools.ts` 的 `buildTools`（约 485 行）收敛为纯装配层 + 各工具工厂函数，`kanban/watcher.ts` 的 `tick`（约 140 行）拆为 diff / 投递 / 落盘三段——行为均保持不变
- 公共启动序列抽为 `src/bootstrap.ts`（cli 与 bot 此前逐字重复且 OCR 检查只在 bot 侧，已漂移）；「发卡片失败降级纯文本」收敛为 `sendCardWithTextFallback`
- 数据目录路径与包根路径收敛为 `src/paths.ts`（原 8 个模块为拿路径 import memory；4 处散落的 `__dirname` 假设统一为 `packageRoot` 并注明 CJS 前提）；`prompt.ts ↔ skills.ts` import 循环随之断开
- 全仓 45 处手写 `err instanceof Error ? err.message : String(err)` 收敛为 `src/err.ts` 的 `errMessage`；`deps.ts` 同步/异步探测器共用 `parseLarkCliAuth`
- `src/bot.ts` 改名 `src/bot-main.ts`，消除与 `src/bot/` 目录的同名歧义；删除零引用的 `channels/index.ts` barrel 与 `SUGGESTED_MEMORY_KEYS`
- `npm run typecheck` 通过 `tsconfig.typecheck.json` 覆盖 scripts/ 测试脚本（此前 7 个测试文件无类型检查）
- 最低 Node 版本升至 20（Node 18 已 EOL），`@types/node` 对齐到 `^20`；tsconfig 开启 `noUncheckedIndexedAccess`
- `src/` 根目录按领域下沉为 `config/`（配置与向导）、`report/`（HTML 报告与服务）、`agent/`（LLM 会话/工具/闸门/记忆/技能）、`infra/`（路径/私密文件/审计/探测等基础件），入口与编排留根，发布产物路径不变
- 技能子系统（frontmatter 解析/加载/校验）从 `prompt.ts` 并入 `skills.ts`；飞书卡片构建收口为 `channels/feishu-cards.ts`；两套报告渲染器共享 `report-page.ts` 公共 CSS；原子写收敛为 `writeFileAtomicPrivateSync`；`config.ts` 去除 import 时副作用（显式 `ensureEnvLoaded()`，删除死导出 `ENV_PATH`）；`helios-task-agent-bot` bin 改为纯分发（参数解析单一来源 `parseBotArgs`）；`deps.ts` 同步探针收敛为 `probeSync`
- 看板 TS 客户端（`kanban/http.ts`）与 bash 客户端（`hk.sh`）增加契约测试（信封语义/任务 URL/健康端点一致性），防两侧静默漂移
- CI/发布：新增 push/PR 级 `ci.yml`（Node 20/22 matrix + typecheck + 单测 + audit）；`npm publish` 启用 `--provenance`；`prepack` 先 `rm -rf dist` 再构建（防 stale 产物入包）；lockfile resolved 统一到 npmjs 官方 registry
- e2e/smoke 支持 `HTA_REQUIRE_E2E=1` 严格模式（前置缺失时 SKIP 记为失败）；smoke 的审计写入改到临时目录（此前污染真实 `~/.helios-task-agent/audit.log`）

### Security

- 写操作确认展示改为「首尾双向摘要 + 省略长度警示」（`summarizeBothEnds`），注入载荷无法再藏在单向截断点之后——所见即所执行
- 审计日志 `detail` 落盘前同样脱敏，`redactSnippet` 增加 `--token xxx` 等 CLI flag 形态（此前 detail 明文记录完整命令行与 memory value）
- 「同类免问」batchKey 纳入任务标识（task_id / hk argv 中的 UUID），免问窗口不再对任意任务的写操作放行
- `repo_fs` denylist 按路径整体拒绝 `.git/` 目录与 credentials 类文件（此前仅按 basename 匹配，`.git/config` 中带 token 的 remote URL 可被读回）；list/grep 同样前置拦截，grep 正则增加嵌套量词 ReDoS 启发式拒绝
- memory 写入前中和伪造的 `<<<USER_MEMORY` / `END_USER_MEMORY>>>` 标记（持久化注入缺口）
- `--help` 豁免不再优先于写动词检查：命中写动词的命令一律按写处理
- `readSkillDoc` 拒绝读取符号链接；`hta_review` 的 git ref 增加 refname 校验；`update-check` 的 `npm config` 调用补齐最小环境变量
- 当前目录 `.env` 高危键清单扩充：新增 `PATH`/`HOME`/`SHELL`/`NODE_OPTIONS`/`NODE_PATH`/`LD_*`/`DYLD_*`（此前可经 cwd `.env` 注入 PATH 劫持子进程可执行文件解析）与 `HELIOS_KANBAN_HOST`/`HELIOS_REPORT_HOST`（此前可把无鉴权看板/报告服务绑到局域网）
- `lark_cli api` 仅放行以 `/open-apis/` 开头且不含 `://` 的相对路径（此前 `api GET` 一律判只读，完整 URL 可构成数据外发通道）
- `repo_fs` grep 的 ReDoS 启发式加宽：拒绝连续相邻量词段（`.*.*` 等无括号形态此前可绕过）；敏感文件 denylist 补 `*credentials*.json`/`token.json`/`service-account*.json` 及 `.docker`/`.kube` 的 config.json
- 审计脱敏补 URL query（`?access_token=`）与裸 `KEY=value` 环境赋值两种形态；数据目录统一收紧为 0700（`ensurePrivateDirSync`，文件此前已是 0600）
- `update-check` 的 registry 仅接受 `https://`；看板健康判定改为信封字段组合校验（本机进程占端口伪造 `"success":true"` 不再冒充看板）
- 依赖漏洞清零：`@modelcontextprotocol/sdk` 最低版本升至 `^1.30.0`（传递引入的 fast-uri / ip-address / hono 等 5 个已知漏洞修复），`npm audit` 纳入 CI 与发布闸门

### Fixed

- 飞书 REST 调用配置 20s 超时（SDK 默认 axios 实例此前无超时，挂死连接会让用户队列与看板推送永久停摆）
- bot / CLI 入口注册 `unhandledRejection` / `uncaughtException` 兜底：rejection 记日志，未捕获异常走优雅退出（此前漏网 rejection 直接 crash 且绕过 shutdown 清理）
- watcher 未送达事件增加 24h TTL，过期丢弃并记日志（此前 pending 随 owner 不可达无限增长）；旧 state 文件兼容加载
- 确认卡片与文本降级都发送失败时立即以「拒绝」收尾并经 `onSendFailed` 告知用户（此前工具干等 120/300s 超时）
- 飞书 bot 端 `/confirm revoke` 此前不生效（parseCommand 只取首个分词，`cmd === '/confirm revoke'` 永不可达），免问授权看似撤销实际仍在放行；现改为对完整文本判定
- 进程崩溃语义：`uncaughtException` 路径以退出码 1 结束（此前 exit 0，launchd/systemd 视崩溃为干净停止、不触发重启）；CLI cleanup 补齐幂等标志与 8s 强退兜底（对齐 bot）
- MCP 连接窗口期（最长 45s）收到 SIGINT 时 in-flight 的 MCP 子进程未登记清理；`connectMcp` 新增 `onCreate` 回调，实例创建即登记
- watcher 的 `/approvals` 拉取失败时沿用上一轮快照（视为「未知」而非「空」），端点恢复后不再把全部待审批当新审批重推
- AI 审查报告写盘/卡片推送失败不再误报「AI 审查失败」，降级为纯文本投递结果；`deliverReply` 多段续发逐段兜底，中段失败不再静默丢失后续段
- supervisor 重连退避节奏对齐注释（前 3 次连续，之后每 5 个周期）；MCP 探活追加看板后端健康检查（节流），看板假死时经 onLost 通道告知 owner
- report-server listen 成功后的 `error` 事件不再被静默吞掉；确认超时定时器补 `unref`（与全仓定时器纪律一致）
- README 多处修正：终端确认按键 `y/b/N` → `y/batch/N`（`b` 此前会被当成取消）；AI 审查报告链接主机名规则按实际代码改写；即时命令与工具一览补全；说明当前目录 `.env` 高危键不参与覆盖
- `/stop` 可中断进行中的 AI 审查：`runAiReview` 支持 AbortSignal 并真正杀掉 ocr 子进程（此前要等 15 分钟自身超时）
- supervisor `stop()` 对在途重连加竞速超时；用户单条消息增加 8000 字符上限，超限直接拒答
- 测试修复：技能契约用例不再扫描用户数据目录（本机第三方技能曾致 `npm test` 环境性失败）；batchApproval TTL 过期路径、LLM 错误映射、无断言用例、SDK 私有字段脆性断言逐一补实
- 目录重构复审收尾：断开 `agent/confirm.ts ↔ channels/feishu-cards.ts` 值级循环依赖（`kindLabel`/`ConfirmSettle` 下沉 `guard.ts`，删除兼容 re-export）；`ui.ts` 下沉 `infra/`（此前 `config/` 反向依赖顶层文件），`MCP_FALLBACK_TEXT`、`defaultDataHome`、`SKILLS_DIR` 的中转 re-export 全部收口为直引 `infra/`
- smoke 的 `repo_fs list` 用例适配下沉后的目录布局（断言 `src/agent` 下的文件，此前仍假设扁平 `src/`、注册仓库场景下必 FAIL）
- bot 长连接失败退出路径改走统一 `shutdown`（此前手写清理 mcp + 看板子进程，漏掉已登记的 supervisor / reportServer / channel）；`helios-task-agent-bot --help` 用法文案补独立入口命令名；统一入口 cli 分支与 bot 对称校验未知参数（此前静默进 REPL）
- 文档对齐：`.env.example` 补 `OCR_LLM_MODEL`；README 环境变量表 `REPO_ID`/`ITERATION` 缩写更正为全名（照抄不生效）；`hk.sh` 默认地址表述与代码统一为 `http://localhost:7964`；skill `reference.md` 端点表补 `GET /tags`；README.en 补译两处中文新增说明

## [1.0.20] - 2026-08-07

### Added

- 技能管理命令 `/skills install <路径>` / `/skills uninstall <名称>`（CLI 与飞书 bot 一致）：安装即复制到数据目录 `skills/`（`HELIOS_TASK_AGENT_HOME` 或 `~/.helios-task-agent`），`npm i -g` 升级不再丢失；同名覆盖即更新；包内内置技能不可卸载。启动时自动把历史误放进包内 `skills/`（npm 安装目录）的非内置技能迁移到数据目录并打印提示——此前没有安装入口，用户只能手动拷目录，且界面上唯一可见的 `skills/` 路径是包内那个，放进去一升级就没

## [1.0.19] - 2026-08-06

### Added

- 新增 `skill_exec` 工具：技能目录内脚本（node/shell/python 等）可直接运行——此前技能只有文档注入（`skill_doc`），带脚本的技能除硬编码的 `hk_cli` 外无任何执行通道。脚本路径限定在技能目录内（realpath 校验，拒绝 `..`/绝对路径/符号链接逃逸），按扩展名推断解释器（`.sh`→bash、`.js/.mjs/.cjs`→node、`.py`→python3，其他需显式 `interpreter`，白名单 bash/sh/node/python3/python），工作目录为技能目录；执行任意脚本不可预判读写，每次调用逐次弹用户确认（不参与「同类免问」，无确认通道 fail-closed），子进程沿用最小环境变量并写审计日志
- `helios-task-agent bot --reconfig`：凭证已存在时重跑模型/看板配置向导，飞书凭证保留（换模型 / Base URL / API Key 不用再手编 `.env`）；`--rebind` 仍只重跑飞书凭证向导
- 审计增加 read 类记录：`lark_cli` 读路径、`repo_fs` 读取及敏感文件 denylist 拒绝均写入 `audit.log`（此前只有写操作与拦截有审计）
- 新增单元测试 `scripts/unit-safety.ts` / `unit-kanban.ts` / `unit-resilience.ts` / `unit-bot.ts` / `unit-handler.ts`（覆盖安全闸门、看板进程回收、LLM 重试与事件推送、bot 产品交互、消息路由）

### Changed

- 发往 LLM 网关的非首位 system 注入降级为 user 消息 + UNTRUSTED 包裹（此前部分网关不接受多条 system 消息）
- 配置向导飞书凭证分支校验失败的默认动作统一为「回车=重试、`s`=保存」（与模型分支一致）
- npm 更新确认词表独立为 `UPDATE_YES_RE`，不再复用写闸门确认词表
- bot 看板事件 watcher 按 owner 粒度接线
- hk_cli 启动分支补全的三份拷贝下沉为 `workspace-ready.ts` 的 `fillHkStartBranches`（单一实现）
- `mcp.ts` 去掉对 `ui` 的分层倒挂 import

### Security

- cwd `.env` 高危键扩展：`HELIOS_KANBAN_MCP_COMMAND` / `HELIOS_KANBAN_MCP_ARGS` / `HELIOS_KANBAN_PACKAGE` / `OCR_PACKAGE` / `HELIOS_KANBAN_URL` / `HELIOS_TASK_AGENT_HOME` 不再允许 cwd `.env` 覆盖——此前在含恶意 `.env` 的目录启动可借这些键注入子进程命令、重定向看板地址或数据目录
- `repo_fs` 增加敏感文件 denylist：`.env*` / 私钥 / `.npmrc` 等路径直接拒绝读取（此前只靠仓库边界，仓库内的密钥文件可被读回）
- helios-kanban 默认包钉版本 `helios-kanban@0.1.39`（此前默认 `@latest` 跟随最新版，供应链风险过大）；`HELIOS_KANBAN_PACKAGE` 仍可覆盖

### Fixed

- 自动拉起看板的子进程回收：`stopKanbanChild` 去掉 exitCode 短路，npx 壳已退出时进程组内的看板孙进程也能被回收（此前壳一死孙进程即成孤儿占端口）
- `.env` 写盘值安全序列化：含 `#` / 空格 / 引号的值 round-trip 不再被截断
- LLM 请求 `maxRetries` 1→3：SDK 内建退避覆盖 429 / 5xx / 连接错误，瞬时抖动不再直接抛给用户
- 看板事件推送改为按事件粒度追踪送达：一批事件中部分推送失败不再导致已送达事件重复推送
- 飞书长连接断线告警刷屏：SDK 每次网络抖动都触发 reconnecting/reconnected，原实现对每次状态变化成对通知 owner；改为 `WsAlerter`（`src/bot/ws-alerter.ts`）宽限期静默——3 分钟内恢复不打扰（覆盖 SDK 一个完整重连周期：首试 0~30s，重试间隔 120s），持续断线超时告警一次、重连彻底失败（SDK 终态）只报一次
- `FeishuChannel.stop()` 实际调用 `wsClient.close()`（此前长连接不断开）
- 报告静态服务纳入 bot shutdown 清理
- LLM 失败回复的 bot 指引补 `--reconfig`（此前只指向手编 `.env`）
- 「Hermes」内部代号残留清理

## [1.0.18] - 2026-08-05

### Changed

- UED 全面审查与体验修复（明细见 [docs/ued-issues.md](https://github.com/SolomonFang/helios-task-agent/blob/main/docs/ued-issues.md)，五轮 34 项）：配置向导校验失败两个分支默认动作统一为「回车=重试、`s`=保存」且可改模型名；确认卡片「取消」去掉 danger 红色、「裁决时效」改「确认有效期」、标题加分隔；新增 `/confirm revoke` 语义化命令（`/confirm on` 保留兼容）；owner 被拒文案附本人 open_id 自救指引；删除「Hermes」「post 消息」「ocr」等黑话；banner 长行顶破边框修复（`box()` 自适应加宽）；看板就绪超时改为秒并给出路；README / README.en / `.env.example` 与产品内文案同步

## [1.0.17] - 2026-08-03

仅版本号发布，无代码变更。

## [1.0.16] - 2026-08-03

> 注：1.0.16 未发布到 npm（npm 上 1.0.15 之后直接是 1.0.17），以下变更随 1.0.17 一并发布。

### Security

- `hk.sh` 的 `tasks list --limit` 参数强制纯数字校验：此前该值直接拼入 jq 程序字符串，恶意值可注入 jq 程序读取子进程环境变量（含 `LLM_API_KEY` 等）
- 子进程环境变量收敛为最小白名单（`src/proc-env.ts`）：lark-cli、hk.sh、npx 拉起的看板/OCR 不再无条件继承完整 `process.env`，`LLM_API_KEY`、`FEISHU_APP_SECRET` 等密钥不再暴露给第三方 CLI 与 npx 拉取的包；OCR 仅保留显式派生的 `OCR_LLM_*`
- 看板写操作闸门改为 fail-closed：`classifyHk` 对未知 hk 子命令默认按写操作处理（此前默认放行），hk.sh 新增写子命令不会再绕过确认
- cwd `.env` 不再允许覆盖 `LLM_BASE_URL` / `LLM_API_KEY` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ALLOWED_OPEN_IDS`：在含恶意 `.env` 的目录启动不再能把 LLM 请求劫持到攻击者端点（非受限键优先级不变）
- `memory_set` / `memory_delete` / `memory_note` 接入写确认闸门（确认类型「记忆」，逐次确认、不参与「同类免问」）：堵住经持久化记忆回注系统提示词的跨会话 prompt 注入通道
- AI 审查报告与工作报告文件权限收紧为 0600；报告 URL 带 128-bit 随机 token（无 token / 错 token 一律 404）；报告服务监听地址独立为 `HELIOS_REPORT_HOST`（默认仍 `127.0.0.1`），不再跟随 `HELIOS_KANBAN_HOST`——避免看板绑 `0.0.0.0` 时含代码 diff 的报告连带暴露局域网
- 飞书卡片按钮回调增加白名单校验：非白名单用户点击「AI 审查」等按钮直接忽略，不再消耗 LLM 配额读取本机仓库 diff

### Fixed

- 配置向导模型校验失败后可选修改 Base URL（此前只能重输 API Key，Base URL 填错只能退出重来）
- 确认已超时/已处理后回复「确认」「取消」等确认词，立即提示「当前没有待确认的写操作」，不再落入普通对话发给 LLM（单字母 y/n/b 不拦截，避免误伤正常对话）
- `/status` 的依赖探测（lark-cli 授权态、jq、curl、ocr）全部改异步：此前 `execFileSync` 串在 bot 事件循环里，最坏阻塞十几秒，飞书回调/心跳全被卡住
- MCP 自动重连竞态：决定重连后即同步占位，新轮次一律等重连结束再开始，「无进行中轮次」检查与 `close()` 之间不再可能插入新轮次而杀掉 in-flight 工具调用；重连逻辑抽为 `McpSupervisor`（`src/bot/supervisor.ts`）并补全单元测试（此前零覆盖）
- 确认词表移除单字「都」（随口一个字即批准 10 分钟「同类免问」太危险）；「以后都」「都允许」仍覆盖该意图
- `helios-task-agent-bot` 对 `--help` 与未知参数给出帮助/报错并非零退出（此前乱参数直接启动 bot）
- 用户自建技能契约问题（缺 `name`/`description`、`digest_sections` 匹配不到章节）启动时即告警（CLI 与 bot 一致），不再只在测试期暴露
- README.en 补齐 AI 审查整段说明（双语漂移）

### Changed

- 看板 HTTP 层收口为 `src/kanban/http.ts`：信封解析（`success` 校验策略统一：存在则必须为 true，无信封宽松回退 `data ?? 原始 JSON`）、任务页/diff URL 拼接、最新 attempt 挑选（优先未归档按创建时间）全部共享，watcher / summary / ai-review / workspace-ready 四处的 6+ 份重复实现删除
- `bot.ts`（765 行上帝文件）拆分：MCP supervisor（`src/bot/supervisor.ts`）、消息路由与卡片回调（`src/bot/handler.ts`），bootstrap 留在 `bot.ts`

- 自动拉起看板失败时快速报错：补挂子进程 `error` 监听，npx 缺失/不可执行不再抛未捕获异常或白等 90 秒，错误信息指向真实原因
- 看板启动失败的 CLI 手动提示去掉 `HOST=0.0.0.0`（与看板无鉴权、只应绑回环的安全警告自相矛盾），改随 `HELIOS_KANBAN_PACKAGE` 输出正确的包规格，并提示「多数情况是首次下载慢，重新运行即可」；CLI 与 bot 共用同一文案
- `SourceRegistry` / `MemoryStore` 写盘前先读盘合并：CLI 与 bot 并发、bot 多会话实例之间不再互相覆盖丢失数据（去重注册表丢失会导致重复创建看板任务）；`MemoryStore.persist` 失败不再抛给调用方
- `.env` 写盘原子化（tmp + rename）：写盘中途被杀不再截断凭证文件，历史 0644 的 `.env` 重写后收敛为 0600
- bot 退出可靠性：SIGINT/SIGTERM handler 提到启动流程最前（启动中途收信号也能正确清理），`shutdown()` 幂等防重入并加 8 秒强制退出兜底；自动拉起的看板改按进程组管理，bot 退出不再留下占端口的孤儿进程（npx 壳与真正的看板孙进程一并回收）
- 飞书长连接可观测：接入 SDK 的断线/重连事件，断开与恢复均通知 owner；`/status` 显示连接状态与最近事件时间，告别「进程活着但收不到消息」的静默僵尸态
- 手机可达性：`HELIOS_KANBAN_URL` 为 loopback 时 bot 启动即警告「推送链接在手机上不可达」；看板事件卡片注脚区分「仅本机」与「同网络」两种情形（原注脚对 loopback 地址的可达性描述是错的）
- 依赖检查升级为能力探测：lark-cli 区分「未安装 / 未授权 / 可用」三态（未授权直接提示 `lark-cli auth login`，不再绿点误导）；新增 hk_cli 降级链的 jq/curl 检查，MCP 掉线且 jq 缺失时 banner 与 `/status` 明确警示「降级链不可用」（原宣称「功能不受影响」）

## [1.0.15] - 2026-08-03

仅版本号发布，无代码变更。

## [1.0.14] - 2026-07-31

### Added

- 文档型技能系统：扫描 `skills/*/SKILL.md`（用户数据目录优先、包内内置兜底），frontmatter（`name` / `description` / `digest_sections`）即技能契约，摘要注入系统提示词；`skill_doc` 工具按需读取全文（渐进式披露）；`/skills` 命令（CLI 与飞书 bot）列出已安装技能；`validateSkills()` 契约校验纳入单元测试
- 配置向导统一交互：模型预设箭头选择列表 + API Key 掩码输入（CLI 与 bot 一致）
- `audit.log` 大小轮转：超过 5MB 自动轮转为 `audit.log.1`（只保留 1 代），长驻 bot 不再无限累积审计日志；审计写入仍永不抛出
- 看板事件卡片与 AI 审查完成卡片注明链接可达范围（仅在运行 bot 的电脑/所在网络可达，进程重启后失效）
- owner 绑定成功欢迎语补「发送 /help 查看我能做什么」引导；非白名单用户被拒文案补充「联系实例 owner 开通或自行部署」说明
- 飞书 bot 即时回执改为「敲键盘」表情（与 Hermes 一致）：收到待处理消息即在用户消息上加 Typing 表情，该条处理完成（含中断、报错、/stop 丢弃排队消息）后移除；无表情回复权限时自动降级为原文字占位，不再重试

### Fixed

- CLI 任务运行中按 Ctrl+C 现在正确中断当前 LLM 请求/工具：terminal 模式下 readline 会拦截 ^C，补挂 rl 级 SIGINT handler（此前无 listener 时默认 `rl.close()`，直接关闭输入流而非中断任务）
- 归档/合并/推送/执行类看板操作不再被「同类免问」批量放行：批量判定收进 `guard.isBatchable()`（唯一来源），词表补上 `archive|merge|push|execute`，与写操作分类词表对齐
- 报告静态服务默认绑定回环地址 `127.0.0.1`（原 `0.0.0.0` 会把含代码 diff 的报告暴露到局域网）；跟随看板的 `HELIOS_KANBAN_HOST` 约定
- CLI 写操作确认增加超时自动拒绝（可批量 120s / 破坏性 300s，与飞书 bot 语义一致），用户离开后 agent 不再永久挂起；Ctrl+C 中断仍即时生效
- CLI 确认提示不再把内部 `kind` 枚举（`hk`/`lark`）原样输出，统一复用 bot 的「看板/飞书」映射
- 飞书端 `work_summary` 报告改推 HTTP 链接（原输出运行机器的本机路径，手机飞书打不开）；报告静态服务纳入 `reports/` 目录，CLI 场景保留本机路径
- 失败任务事件卡片按钮「📄 查看日志」实际链到任务页，更名「📋 查看任务」
- Banner 中模型与 kanban 地址两行改用中性灰点（仅为配置展示、未做健康检查，原绿点易被误读为「连接正常」）
- npm 更新提示复用统一确认词表（「确认 / 同意 / 批准 / y」等均接受），默认仍为否

### Changed

- 确认应答词表两端统一：批准/同类免问/拒绝词表抽为共享常量（`confirm.ts`），CLI 与飞书 bot 取并集后引用同一词表（CLI 现在也认「批准」「执行」「批量允许」等）
- 用户自定义技能目录迁出 npm 包安装目录：改为 `<数据目录>/skills/`（`HELIOS_TASK_AGENT_HOME` 或 `~/.helios-task-agent/skills`），`npm i -g` 升级不再抹掉自定义技能；同名技能用户目录优先
- 版本更新提示附 CHANGELOG 链接，升级前可查看变更内容
- CLI 与飞书 bot 入口壳层去重：MCP 连接与降级诊断、`/status`、`/tools`、`/skills`、`/memory`、`/clear`、「同类免问」查询/撤销、LLM 失败回复（friendlyLlmError + 原消息截断）抽为共享模块 `src/commands.ts`，通道差异经 Paint/文案参数保留（纯重构，两端文案、顺序与降级逻辑不变）
- MCP 降级术语统一为「已自动切换为 hk_cli（看板 HTTP 接口）」（原「降级 hk_cli」「已自动降级 hk_cli」「已降级为 HTTP/hk.sh」三种写法并存）
- 主动取消措辞两端统一为「已取消，操作未执行」（CLI 原「已拒绝」）；超时仍保留「已自动拒绝」以区分主动/被动
- `renderReply` 终端渲染增强：`#` 标题渲染为加粗、简单 markdown 表格列对齐（结构不完整的表格退化为原样）、代码块内容先抽占位不再被标题/表格规则误渲染

### Security

- owner 白名单写回 `.env` 失败时 fail-closed：撤销内存放行并阻断该用户重试（重启前按拒绝处理），同时向其发送「绑定未持久化、检查 .env 写权限」告警；此前写失败仅打日志，内存 access checker 已放行，重启后任何人可重新认领 owner
- 用户记忆注入系统提示词加 `USER_MEMORY` 包裹标记（与 `guard.wrapUntrusted` 同一思路），明确声明记忆内容由历史对话生成、不得作为指令执行，堵住持久化 prompt 注入通道；`memory_set` 工具描述同步提示只保存事实性偏好

## [1.0.13] - 2026-07-30

仅版本号发布，无代码变更。

## [1.0.12] - 2026-07-30

### Changed

- helios-kanban 的 npx 包规格默认改为 `@latest` 跟随最新版（原钉 `0.1.36`），需要钉版本时仍可用 `HELIOS_KANBAN_PACKAGE` 覆盖

## [1.0.11] - 2026-07-30

### Changed

- AI 审查完成后推送带「📄 查看完整报告」按钮的卡片，一键直达静态报告页（不再只发文本链接）

## [1.0.10] - 2026-07-30

### Changed

- 审查 HTML 报告结构化渲染：ocr 输出解析为「概览 + 分级卡片 + diff 高亮」（按类别/严重度分组统计），识别不到结构时回退扁平 markdown 渲染
- 审查全部通过时报告页展示绿色庆祝横幅（随机夸赞语）

## [1.0.9] - 2026-07-30

### Changed

- AI 审查结果改为中文 HTML 报告：`--background` 注入简体中文输出要求；完整结果渲染为自包含 HTML（轻量 markdown：标题/列表/代码围栏/行内格式，全量转义防注入），写入数据目录 `reviews/`（30 天自动清理），由 bot 内置静态服务托管（随机空闲端口、仅服务目录内 `*.html`、路径穿越 404，链接主机名取 `HELIOS_KANBAN_URL`），长结果不再按 4000 字符截断；报告服务启动失败时回退原文本推送
- 看板事件 / AI 审查结果注入会话上下文改为轮边界注入（`injectSystemNote`），不再打断进行中的 tool 配对

### Security

- 自动拉起的 helios-kanban 默认绑定回环地址（`HOST=127.0.0.1`，可用 `HELIOS_KANBAN_HOST` 覆盖）：看板 Web/API 无鉴权，绑 `0.0.0.0` 会暴露到局域网

## [1.0.8] - 2026-07-30

### Added

- 待审阅卡片新增「🤖 AI 审查」按钮（原「查看 Diff」改名「🔍 人工审查」）：点击后 bot 调 [open-code-review](https://github.com/alibaba/open-code-review)（`ocr review`）审查该 attempt 的 diff——自动定位 workspace 仓库目录（`container_ref`+`agent_working_dir`，兜底看板注册仓库 path），按 merge-base(target_branch)..attempt 分支取 diff（与看板 diff 视图同口径），任务标题作为 `--background` 传入；结果推回飞书并注入会话上下文便于追问/修复；`ocr` 未安装时自动 `npx` 拉取，LLM 默认复用机器人模型配置（显式 `OCR_LLM_*` 或已有 `~/.opencodereview/config.json` 优先），整体超时 15 分钟、按 attempt 去重防连点；`/status` 与启动日志增加 ocr 可用性检查

## [1.0.7] - 2026-07-30

### Fixed

- 全触点 UED 审查修复：配置向导改用箭头选择列表与密钥掩码输入（bot 与终端体验对齐）；有未处理确认卡片 / 任务进行中时新消息即时回执（不再「发出去没反应」）；`SessionRouter.busy` 清理失效修复（原任务完成后永真，影响排队回执与 LRU 淘汰）；`/stop` 一并丢弃排队消息；LLM 错误指引按通道区分（bot 不再提示不存在的 `/config`，改为指向 `.env`）

## [1.0.6] - 2026-07-29

### Changed

- 看板状态变更通知从纯文本改为飞书交互卡片（沿用确认卡片风格）：任务待审阅/完成/失败卡片化，待审阅卡片带「查看 Diff」按钮直达看板 diff 视图

## [1.0.5] - 2026-07-29

### Added

- 创建/更新任务支持优先级（urgent / high / medium / low，省略默认 medium）：用户说「紧急」→ urgent、「高优」→ high；确认卡片与回复模板同步展示优先级

## [1.0.4] - 2026-07-29

### Changed

- 确认卡片视觉重设计：头部按通道区分颜色与图标（看板 🔧 橙 / 飞书 ✉️ 蓝），操作类型与裁决时效改为 fields 双栏，命令详情改为等宽代码块，提示文本下沉为 note 小号字；终态卡同样式并附时间戳；卡片禁止转发（enable_forward=false）
- 批量免问的广告回复词统一为「同类免问」（原「都允许」歧义——像「全部放行」——且与按钮/「恢复确认」术语不一致）；「都允许」作为旧同义词仍兼容可用，终端同时接受输入「同类免问」
- 对话历史在条数上限（40 条）之外增加字符预算上限（10 万字符），双维度裁剪，避免大工具输出撑爆小上下文模型
- SessionRouter 会话数上限 50（LRU 淘汰最旧空闲会话），长驻 bot 不再无界累积
- 更新检查的 npm registry 解析改为异步（不再同步阻塞事件循环）

### Added

- 模型返回「上下文超限」错误时自动恢复：逐级丢弃最旧对话轮次并重试（最多 3 次），不再直接把 400 抛给用户（不可恢复时保留原有友好指引）
- MCP 连接失败时捕获子进程 stderr 并诊断已知模式：识别「看板端口文件（vibe-kanban.port）被系统清理」场景，提示重启看板即可恢复（此前只有裸 `Connection closed`，无从下手）
- `helios-task-agent --version` / `-v`（及 `version` 子命令）查看版本；bot 启动日志显示版本号

### Security

- `repo_fs` 显式 `root` 必须是 helios-kanban 已注册仓库（或其子目录），未注册路径拒绝、kanban 不可达时失败关闭——杜绝借道读取任意本机路径
- 数据文件统一收紧为 0600：`memory.json`、`synced-sources.json`、`audit.log`、`watch-state.json`、`update-check.json`（此前仅 `.env`）
- 启动时自动检查 npm 新版本并请示是否更新：结果缓存 24h（`update-check.json`），registry 跟随 `npm config`（含 npmmirror 镜像）、请求 8s 超时、离线静默跳过；`HTA_UPDATE_CHECK=0` 关闭、`HTA_UPDATE_REGISTRY` 显式指定；源码仓库内（本地开发）自动跳过；确认更新后执行 `npm i -g` 并提示重启
- 配置向导新增 LLM 凭证联网预检（GET /models）：Key 无效可当场重输；端点不支持预检/网络不通时可选择仍保存
- LLM 请求失败的友好排查指引（401 / 429 / 上下文超长 / 模型不存在 / 连接失败 → 对应操作建议），终端与飞书通道同时生效
- 单元测试新增：semver 比较（含预发布标识符）、更新检查缓存与失败静默、更新请示流程、LLM 错误映射、会话创建上限

## [1.0.3] - 2026-07-29

### Fixed

- `/clear` 现在会重建工具闭包、真正重置「单会话创建 10 个看板任务」上限（此前只清对话历史，创建计数仍在，与文档承诺的「超限 /clear 后再建」不符）
- 中断（/stop、Ctrl+C）或工具调用超限发生在多工具批次中途时，为未执行的 tool_calls 补占位响应，修复后续对话被 API 拒绝（orphan tool_calls）的问题；新增 `sanitizeToolPairs` 防御性修复历史残留
- 成功结果的头 300 字符含 error/失败 字样时不再误判为失败：操作成功判定与来源映射记录改用强失败信号（命令执行失败/调用失败/HTTP 状态/API error 等），修复「已同步来源漏记导致重复建任务」
- `repo_fs` 解析符号链接真实路径，拦截指向仓库根目录之外的链接逃逸；仓库 path 解析请求增加 8s 超时
- lark-cli 未安装时返回安装指引，而非裸 `spawn ENOENT`

### Security

- `~/.helios-task-agent/.env`（含 LLM_API_KEY / FEISHU_APP_SECRET）落盘权限收紧为 0600，重写历史文件时一并 chmod

### Added

- 纯逻辑单元测试 `scripts/unit.ts`（31 项：guard 分类、确认状态机、history 修剪/修复、runAgentTurn 中断与超限、飞书解析、查重注册表、记忆、repo_fs 边界、.env 权限），`npm test` 运行并纳入 `npm run verify` 与发布 CI
- CLI `/config` 修改看板地址后提示 MCP 仍连接旧实例，建议重启重连

## [1.0.0] - 2026-07-25

初始发布。

- 双通道智能体：交互式终端 REPL 与飞书私聊机器人（长连接，无需公网 Webhook）
- 代码层写操作闸门：建/改/删任务、start/stop、飞书发消息等写操作执行前必须确认（终端 y/b/N，飞书确认卡片），支持「同类免问 10 分钟」，破坏性操作始终逐次确认
- 来源查重：飞书链接 → 看板任务映射持久化，重复同步自动拦截，任务删除后映射自愈
- 审计日志：批准/拒绝/重复拦截/执行结果追加 JSONL 审计记录
- helios-kanban 集成：MCP 优先、`hk_cli` 兜底；本机看板不可达时自动 `npx -y helios-kanban` 拉起（可用 `HELIOS_KANBAN_AUTO_START=0` 关闭）
- 飞书读取：通过 `lark_cli` 工具读取任务/文档/群消息，只读命令白名单直接放行，写操作进闸门；读回内容包裹 UNTRUSTED 防注入
- 看板状态推送（bot）：任务待审阅/完成/失败、新待审批自动推送飞书
- 首启交互向导：配置自动写入 `~/.helios-task-agent/.env`，飞书凭证联网校验
