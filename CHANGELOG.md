# Changelog

本项目的所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- helios-kanban 的 npx 包规格默认改为 `@latest` 跟随最新版（原钉 `0.1.36`），需要钉版本时仍可用 `HELIOS_KANBAN_PACKAGE` 覆盖

- AI 审查结果改为中文 HTML 报告：`--background` 注入简体中文输出要求；完整结果渲染为自包含 HTML（轻量 markdown：标题/列表/代码围栏/行内格式，全量转义防注入），写入数据目录 `reviews/`（30 天自动清理），由 bot 内置静态服务托管（随机空闲端口、仅服务目录内 `*.html`、路径穿越 404，链接主机名取 `HELIOS_KANBAN_URL`），飞书推送带「查看完整报告」按钮的卡片直达报告页，长结果不再按 4000 字符截断；审查全部通过时报告页展示绿色庆祝横幅（随机夸赞语）；报告服务启动失败时回退原文本推送

- 确认卡片视觉重设计：头部按通道区分颜色与图标（看板 🔧 橙 / 飞书 ✉️ 蓝），操作类型与裁决时效改为 fields 双栏，命令详情改为等宽代码块，提示文本下沉为 note 小号字；终态卡同样式并附时间戳；卡片禁止转发（enable_forward=false）
- 批量免问的广告回复词统一为「同类免问」（原「都允许」歧义——像「全部放行」——且与按钮/「恢复确认」术语不一致）；「都允许」作为旧同义词仍兼容可用，终端同时接受输入「同类免问」
- 对话历史在条数上限（40 条）之外增加字符预算上限（10 万字符），双维度裁剪，避免大工具输出撑爆小上下文模型
- SessionRouter 会话数上限 50（LRU 淘汰最旧空闲会话），长驻 bot 不再无界累积
- 更新检查的 npm registry 解析改为异步（不再同步阻塞事件循环）

### Added

- 待审阅卡片新增「🤖 AI 审查」按钮（原「查看 Diff」改名「🔍 人工审查」）：点击后 bot 调 [open-code-review](https://github.com/alibaba/open-code-review)（`ocr review`）审查该 attempt 的 diff——自动定位 workspace 仓库目录（`container_ref`+`agent_working_dir`，兜底看板注册仓库 path），按 merge-base(target_branch)..attempt 分支取 diff（与看板 diff 视图同口径），任务标题作为 `--background` 传入；结果推回飞书并注入会话上下文便于追问/修复；`ocr` 未安装时自动 `npx` 拉取，LLM 默认复用机器人模型配置（显式 `OCR_LLM_*` 或已有 `~/.opencodereview/config.json` 优先），整体超时 15 分钟、按 attempt 去重防连点；`/status` 与启动日志增加 ocr 可用性检查
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
