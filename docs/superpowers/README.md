# docs/superpowers

Helios Task Agent 设计与流程文档索引。用户入口仍是仓库根目录 [README.md](../../README.md)。

## 当前产品约定（2026-07-21）

1. **拉飞书**：任务中心列表；标题/描述含飞书链接则展开一层详情（只展示）
2. **写看板**：用户说「写进 kanban」→ 草稿确认 → create（来源 + 需求摘要）
3. **启用任务**：不自动 start；executor / variant 由用户指定（或看板默认）

## 文档

| 文件 | 说明 |
|------|------|
| [WORKFLOW.md](./WORKFLOW.md) | 端到端流程图、模块对照、审查备注 |
| [specs/2026-07-21-feishu-task-link-expand-design.md](./specs/2026-07-21-feishu-task-link-expand-design.md) | 链接展开（implemented） |
| [specs/2026-07-21-feishu-to-kanban-design.md](./specs/2026-07-21-feishu-to-kanban-design.md) | 写入看板（implemented） |
| [plans/](./plans/) | 实现计划存档 |

> 旧文件名 `*feishu-kanban-tech-design*` 已更名为 `*feishu-to-kanban*`（不再暗示「技术设计 / Kimi Plan」主路径）。
