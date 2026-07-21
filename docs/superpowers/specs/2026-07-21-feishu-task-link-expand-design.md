# Feishu Task Center link expand (display-only)

Date: 2026-07-21  
Status: approved (approach 1 — prompt rules)

## Goal

When the agent lists Feishu **Task Center** tasks (`lark-cli task`), if a task’s **title** or **description** contains a Feishu URL, fetch that URL’s details via `lark_cli` and **show** them to the user. Do **not** auto-write to helios-kanban.

## Non-goals

- No new tools or code-side enrich pipeline
- No recursive expand of links found inside the fetched document
- No automatic kanban create/update from expanded content
- No change to Feishu bot transport / MCP / memory schema

## Trigger

Any user intent that loads Task Center lists, including but not limited to:

- 「拉取/列出我的任务」
- 「同步我的任务」（先列任务中心并展开，再在用户确认后才写 kanban）

## Detection

Scan each task’s **title** and **description** for Feishu / Lark URLs, e.g. hosts:

- `*.feishu.cn`, `*.larksuite.com` (and common short forms used by lark-cli)

Resource kinds to attempt: doc / wiki / sheets / base / task (and others discoverable via `lark_cli` `--help`). Prefer URL-as-whole-field; also expand when a URL is embedded in longer text.

## Behavior

1. Fetch Task Center list with `lark_cli` (discover subcommands via `--help`; never invent).
2. For each matching task (cap **10** expands per turn): call `lark_cli` again to read the linked resource.
3. Reply per task with: task name, original link, short detail summary (title + key points). Keep summaries concise.
4. Beyond 10: list remaining tasks without expand; offer to expand named ones next.
5. On read failure: report task + URL + error; continue with other tasks.
6. Expand depth: **one hop only**.
7. Kanban: only after user confirms the presented list (existing workflow).

## Implementation

Single change surface: `src/prompt.ts`

- Add a dedicated rule block under 飞书（lark-cli）使用规则 / 典型工作流
- Optionally one sentence in README under 飞书里可以说

No TypeScript API / tool schema changes.

## Success criteria

- Listing Task Center tasks with link-in-title/description causes a second `lark_cli` read and a user-visible summary
- Agent does not create kanban tasks solely because expand succeeded
- Nested links in fetched bodies are not followed unless the user asks

## Testing

Manual: start CLI or bot → ask to list Feishu tasks that include a doc URL in description → confirm summary appears and no unexpected kanban writes.
