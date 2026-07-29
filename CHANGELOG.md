# Changelog

本项目的所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
