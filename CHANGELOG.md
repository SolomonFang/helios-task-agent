# Changelog

本项目的所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
