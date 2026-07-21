# Feishu Task Link Expand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the agent via system prompt to expand Feishu URLs found in Task Center title/description when listing tasks, display-only.

**Architecture:** Prompt-only. No new tools. Rules live in `buildSystemPrompt` in `src/prompt.ts`; optional one-line README note.

**Tech Stack:** TypeScript, existing `lark_cli` tool.

## Global Constraints

- Display-only: never auto-create/update kanban from expand
- One-hop expand only; max 10 expands per turn
- Discover `lark_cli` subcommands via `--help`; never invent
- Spec: `docs/superpowers/specs/2026-07-21-feishu-task-link-expand-design.md`

---

### Task 1: Prompt rules + README note

**Files:**
- Modify: `src/prompt.ts` (sections 典型工作流 + 飞书使用规则)
- Modify: `README.md` (飞书里可以说)

**Interfaces:**
- Consumes: existing `buildSystemPrompt` string template
- Produces: updated system prompt text only

- [x] **Step 1: Add workflow + rules to `src/prompt.ts`**

In `典型工作流`, after step 1 (or as a new bullet), add Task Center expand behavior. Under `飞书（lark-cli）使用规则`, add a dedicated bullet list covering: trigger on list/fetch Task Center; scan title+description for feishu/larksuite URLs; `lark_cli` read one hop; show name/link/summary; fail soft; cap 10; no kanban write from expand alone.

- [x] **Step 2: README one-liner**

Under `## 飞书里可以说`, add: listing Task Center expands linked doc/wiki details for confirmation before kanban.

- [x] **Step 3: Verify**

Run: `npm run typecheck`  
Expected: exit 0

- [ ] **Step 4: Commit** (only if user asks)

```bash
git add src/prompt.ts README.md docs/superpowers/specs/2026-07-21-feishu-task-link-expand-design.md docs/superpowers/plans/2026-07-21-feishu-task-link-expand.md
git commit -m "feat: expand Feishu links when listing Task Center tasks"
```
