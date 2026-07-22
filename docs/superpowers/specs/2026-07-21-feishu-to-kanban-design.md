# Feishu → Helios Kanban（写入任务）

Date: 2026-07-21  
Status: **implemented**  
Filename note: 原 `feishu-kanban-tech-design` 已更名为本文件，避免与「技术设计 / 固定 executor」混淆。

## Goal

把飞书任务中心 / 文档里拿到的内容写入 helios-kanban：

1. 用户要求写进看板
2. Agent 展示 **标题 + 需求摘要（含来源链接）** 草稿并等待确认
3. 确认后 → create
4. **不自动 start**；是否启用、用哪个 executor/variant，**完全由用户决定**

## Position in full flow

```text
[链接展开] → [本 spec：确认后 create] → [用户自行决定是否 / 如何 start]
```

Upstream: [Task Center link expand](./2026-07-21-feishu-task-link-expand-design.md).  
Overview: [WORKFLOW.md](../WORKFLOW.md).

## History（已废弃路径）

- Task Agent + `repo_fs` 写完整技术设计 → 废弃  
- create 后写死 Kimi Plan → 废弃  

## Non-goals

- 写死任一 coding agent / Plan 模式
- 创建后自动 start
- 无限制 shell

## Trigger

「写进 helios-kanban」「创建到看板」等。

## Description on create

```markdown
## 来源
- 飞书任务/文档：<链接>

## 需求摘要
…（从飞书详情提炼；可附要点/摘录）
```

## Start

仅当用户明确要求时执行；executor / variant / repo / branch 听用户或看板 Settings 默认。

## `repo_fs`

可选本机读文件。非写看板必经步骤。

## Implementation

| Piece | Role |
|-------|------|
| `src/prompt.ts` | 「飞书→看板」；禁止擅自 start |
| `src/bot.ts` / `src/cli.ts` | 帮助文案与入口 |
| `README.md` / `WORKFLOW.md` | 用户与维护者文档 |

## Success criteria

- 飞书内容确认后写入 kanban
- create 后不自动 start
- start 仅响应用户指令，且不默认某一固定 agent

## Testing

Manual: 展开飞书任务 → 「写进 kanban」→ 确认 create → 未说 start 时不应出现 workspace；再说「用 Claude 跑」才 start。
