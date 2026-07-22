# Feishu Task Link Expand — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-07-21-feishu-task-link-expand-design.md`  
**Status:** done (prompt-only)

**Goal:** Teach the agent via system prompt to expand Feishu URLs found in Task Center title/description when listing tasks, display-only.

**Architecture:** Prompt rules in `buildSystemPrompt` (`src/prompt.ts`); uses existing `lark_cli`. No new tools.

---

### Task 1: Prompt rules + README

**Files:**
- Modify: `src/prompt.ts`
- Modify: `README.md`

- [x] **Step 1:** Add workflow + 「任务中心链接展开」rules
- [x] **Step 2:** README / end-to-end docs mention
- [x] **Step 3:** `npm run typecheck`
