# Helios Task Agent

[中文](./README.md) | **English**

Terminal / Feishu DM agent that turns Lark/Feishu tasks & docs into [helios-kanban](https://github.com/SolomonFang/vibe-kanban) cards.

**Whether (and with which executor) to start a coding agent is always your choice.**

## 60-second start (terminal, zero config)

```bash
npx helios-task-agent@latest
```

The wizard only asks for one LLM preset + API key (kanban defaults can be skipped with Enter). No need to preinstall the kanban board — it auto-spawns if unreachable, so you can create and run tasks right away. The Feishu bot is an optional upgrade, see below.

## Install

Requires: Node.js ≥ 18, macOS / Linux.

```bash
npm i -g helios-task-agent
```

Then run it directly (first launch opens an interactive wizard that writes config to `~/.helios-task-agent/.env`):

```bash
helios-task-agent        # interactive terminal agent
helios-task-agent bot    # Feishu DM bot
helios-task-agent --version   # show installed version
```

**Auto update check**: startup probes npm for a newer version (result cached 24h, silently skipped offline; follows your configured npm registry/mirror) and offers to update in place. Disable with `HTA_UPDATE_CHECK=0`; manual update: `npm i -g helios-task-agent@latest`.

**No need to preinstall helios-kanban**: when the local board is unreachable, the agent auto-spawns it via `npx -y helios-kanban` (pinned version — override with `HELIOS_KANBAN_PACKAGE`; listens on `127.0.0.1` by default). Point `HELIOS_KANBAN_URL` at an existing instance, or set `HELIOS_KANBAN_AUTO_START=0` to disable auto-start.

**Feishu reads need lark-cli** (without it, Feishu task/doc reads are unavailable; kanban features are unaffected):

```bash
npm i -g @larksuite/cli && lark-cli auth login
```

From source: `npm install && npm start`.

## Release (maintainers)

Pushing a tag triggers the GitHub Action that publishes to npm (`.github/workflows/publish.yml`):

```bash
npm version patch          # or minor / major — bumps version and creates the tag
git push --follow-tags     # pushes commit + tag, triggering the release
```

The tag must match `package.json` `version` (enforced in CI). Prerelease versions (e.g. `1.1.0-beta.0`) go to the npm `next` dist-tag; stable releases go to `latest`. CI runs typecheck + build before publishing (`prepublishOnly` / `prepack`). smoke / e2e need a local helios-kanban — run `npm run verify` locally before tagging.

Requires an `NPM_TOKEN` repository secret (npm → Access Tokens → Granular Token with publish permission).

## End-to-end flow

```text
Feishu Task Center / docs / group chats
  → List or read; expand Feishu URLs in title/description one hop (display only; ~10 expands per turn)
  → “Write to helios-kanban”: draft title + requirements summary
       → code write-gate confirm (terminal y/b/N or Feishu card) → create (no auto start)
  → Same Feishu source already synced → block and point to existing task
       (if that task was deleted, the mapping self-heals and sync can proceed)
  → Whether to start, and which executor: your call
```

| Stage | Who | Output |
|-------|-----|--------|
| Fetch / expand | Task Agent + `lark_cli` | In-chat summary |
| Write to board | Task Agent + MCP / `hk_cli` | Kanban task (source + requirements) |
| Run task | **You choose** | Workspace (optional) |

## Safety (code-enforced)

| Mechanism | Behavior |
|-----------|----------|
| Write gate | Creates/updates/deletes, start/stop/follow-up, approvals, Feishu sends require confirm. Terminal: `y` (once) / `b` (batch) / `N`; no timeout (Ctrl+C at the prompt rejects). Feishu: confirm card (the “allow-similar 10 min” button shows only for non-destructive ops) or strict phrases (确认 / 同类免问 / 取消 — casual “ok” ignored); timeouts 120s for batchable ops, 300s for destructive ops and Feishu writes; the card updates to a final state after decision/timeout. New confirm **supersedes** a pending one. Missing gate → all writes fail closed |
| Batch approval | “Allow similar” for 10 minutes on the same write class; plain confirm is **once**. Destructive ops (delete/cancel/stop/approve/start) always re-ask. **Feishu writes never batch.** `/confirm on` or 恢复确认 revokes |
| Session create cap | Max **10** kanban creates per session; `/clear` resets |
| Read allowlist | `lark_cli` reads (list/get/search…) free; writes/unknown → gate; `api` GET only exempt; `update` (self-upgrade) and `--help` with extra args count as writes |
| Untrusted wrap | External output (`lark_cli`, kanban MCP / `hk_cli`, `repo_fs`) plus kanban-event and AI-review context injections are wrapped UNTRUSTED; injected “instructions” ignored; rejected writes must not be retried via another tool |
| Owner claim | Empty `FEISHU_ALLOWED_OPEN_IDS` → first DM user becomes owner (written to `.env`); others rejected once |
| Source dedupe | URL → task map per user in `synced-sources.json`; self-heals after deletes; unreachable kanban conservatively blocks |
| Audit log | Approvals/denies/dup blocks (`blocked_dup`)/no-gate/results → `audit.log` (JSONL) |
| Workspace ready | Fills `base_branch` on start; detects silent setup failures |

## Kanban status push (bot)

Polls ~every 60s. Pushes on in-review (diff link), done (summary), cancel, failure, new approvals — and injects session context so you can reply in-thread.

- First poll is baseline only (`watch-state.json`)  
- Does **not** notify on brand-new tasks  
- Failed pushes don't advance the snapshot — retried next poll (duplicates preferred over loss)  
- With `HELIOS_KANBAN_PROJECT_ID`, watches that project only  
- `KANBAN_WATCH=0` off; `KANBAN_WATCH_INTERVAL_SEC` (min 15)

## MCP health supervisor (bot)

~60s probe. Degrades to `hk_cli` only after consecutive probe failures (no flapping on transient jitter); auto-reconnect with backoff (down to ~every 5 min), skipped while a task is running so in-flight calls aren't killed; on recover: switch back (all transitions notified). `hk_cli` is **always** registered (bundled `hk.sh`); MCP is preferred.

## Config home (Hermes-style)

```text
~/.helios-task-agent/.env
~/.helios-task-agent/memory.json
~/.helios-task-agent/synced-sources.json
~/.helios-task-agent/audit.log
~/.helios-task-agent/watch-state.json
```

### Terminal

```bash
helios-task-agent
```

First-run LLM wizard (presets: Kimi Coding / Moonshot CN·INTL / OpenAI / DeepSeek / custom; API key input is masked) plus optional kanban defaults — or edit `.env`.

### Feishu DM bot

```bash
helios-task-agent bot
# or
helios-task-agent-bot
```

1. Wizard when credentials are missing (online validation by default; you may force-save and fix later)  
2. Open Platform: long connection + `im.message.receive_v1`  
3. DM only (p2p); no public webhook; process must stay up (e.g. `pm2 start helios-task-agent -- bot`)  

**Reconfigure**: edit `~/.helios-task-agent/.env`. Bot has **no** `/config`; re-running bot with existing `FEISHU_*` does **not** reopen the wizard — clear those vars first. Terminal has `/config`.

## Commands

| Command | Purpose |
|---------|---------|
| `helios-task-agent` | Interactive terminal agent |
| `helios-task-agent bot` | Feishu DM bot (wizard if unconfigured) |
| `helios-task-agent-bot` | Same |
| `helios-task-agent help` / `-h` / `--help` | Help |
| `helios-task-agent --version` / `-v` | Show version |

Local: `npm start` / `npm run bot`.

**Kanban process**: auto-start only for **localhost** URLs. CLI exit **keeps** an auto-started board; bot exit **stops** that child. Remote URLs must already be up.

## Environment variables

| Variable | Meaning |
|----------|---------|
| `LLM_*` | Required (wizard can write) |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Required for bot |
| `FEISHU_ALLOWED_OPEN_IDS` | Allowlist; empty → first DM user is owner |
| `HELIOS_KANBAN_URL` | Default `http://localhost:7964` |
| `HELIOS_KANBAN_AUTO_START` | Auto-spawn local board; `0` off |
| `HELIOS_KANBAN_MCP_COMMAND` / `ARGS` | Default `npx` + `-y helios-kanban@0.1.36 --mcp` (pinned) |
| `HELIOS_KANBAN_PACKAGE` | Package spec for auto-start / default MCP (pinned against supply-chain drift); set `helios-kanban@latest` to float |
| `HELIOS_KANBAN_HOST` | Listen address for the auto-started board, default `127.0.0.1` (the board has no auth — think twice before `0.0.0.0`) |
| `OCR_PACKAGE` | Package spec npx pulls when `ocr` is missing, default pinned `@alibaba-group/open-code-review@1.8.0` |
| `HELIOS_KANBAN_PROJECT_ID` / `REPO_ID` / `ITERATION` | Optional defaults; `PROJECT_ID` scopes bot watch |
| `HELIOS_TASK_AGENT_HOME` / `ENV` | Data dir / forced `.env` path |
| `KANBAN_WATCH` / `KANBAN_WATCH_INTERVAL_SEC` | Status push |
| `HTA_UPDATE_CHECK` / `HTA_UPDATE_REGISTRY` | Startup npm update check (default on; registry follows `npm config`) |
| `HTA_DEBUG` | `1` = kanban/MCP debug logs |

Load order: project → cwd → home `.env` (later wins); `HELIOS_TASK_AGENT_ENV` highest. See [.env.example](.env.example).

### Open-platform checklist

1. Company app → enable Bot  
2. Events → **long connection** → `im.message.receive_v1`  
3. (Optional) Callbacks → **long connection** → `card.action.trigger`  
4. Permissions: read DMs, send as app → publish  
5. Copy App ID / Secret  

## What you can say

**Terminal**: `/help` `/config` `/status` `/tools` `/memory` `/clear` `/confirm` `/confirm on` `/exit` `/quit` (Ctrl+C interrupts a turn; during a confirm prompt it rejects that write)

**Feishu**: `/help` `/status` `/tools` `/memory` `/clear` `/confirm` `/confirm on` `/stop` (aborts the running task, cancels pending write confirms, and discards queued messages). Instant: `/stop` `/confirm` `/status` `/tools`. Queued: `/memory` `/clear` and normal chat.

**Examples**: sync/list Feishu tasks; write to helios-kanban; turn a group chat into tasks; start with a named executor; list projects; follow-up / status.

Bot accepts text + post; other types rejected. Replies split ~3000 chars; progress ~every 2s. Per-user serial queue; `message_id` dedupe 10 minutes.

Memory tools: `memory_set` / `get` / `delete` / `note`. Keys: `feishu_task_source`, `feishu_chat_id`, `preferred_*`, `last_sync_at`.

## Tools

| Tool | Role |
|------|------|
| `lark_cli` | Feishu/Lark I/O |
| kanban MCP | Preferred board API |
| `hk_cli` | Always on; bundled `hk.sh` REST fallback/supplement |
| `repo_fs` | Optional `list` / `read` / `grep` under a kanban repo path |
| `memory_*` | Persistent prefs & notes |

Bundled skill: `skills/helios-kanban-remote/`.

## Dependencies

- **helios-kanban** (local auto-start optional)  
- **lark-cli** (recommended for Feishu reads)  

## Development

```bash
npm install
npm run typecheck
npm test           # pure-logic unit tests, no external deps
npm run smoke
npm run test:e2e   # mock path, no real LLM
npm run build
```

Embeddable via `src/index.ts` exports.

## License

ISC
