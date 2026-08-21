# Helios Task Agent

[中文](./README.md) | **English**

Terminal / Feishu DM agent that turns Lark/Feishu tasks & docs into [helios-kanban](https://github.com/SolomonFang/vibe-kanban) cards. (The npm package is `helios-kanban`; the GitHub repo is `SolomonFang/vibe-kanban` — same project, so search the repo by the latter name.)

**Whether (and with which executor) to start a coding agent is always your choice.**

Highlights:

- **Code-enforced write gate** (not prompt goodwill): create/update/delete tasks, start/stop, approvals, Feishu sends all require confirmation — `y/batch/N` in the terminal, a confirm card in Feishu; if the gate is missing, every write fails closed
- **Zero-install kanban**: the board auto-spawns when unreachable locally, so you can create tasks right away
- **Natural-language driven**: "sync my Feishu tasks" → "write to helios-kanban" → "run it with Claude" — when to start, and with whom, is your call

## 60-second start (just an LLM API key)

```bash
npx helios-task-agent@latest
```

The wizard only asks for one LLM preset + API key (kanban defaults can be skipped with Enter). No need to preinstall the kanban board — it auto-spawns if unreachable, so you can create and run tasks right away. The first auto-spawn downloads the helios-kanban package via npx (takes tens of seconds; on a slow network just run it again). Feishu is an optional upgrade: reading Feishu tasks/docs needs lark-cli (~2 minutes, see Install below); the Feishu DM bot is described further down.

## Two forms: CLI vs Feishu bot

- **Terminal CLI** (`helios-task-agent`): quick trial and debugging. Chat, write confirmation (`y/batch/N`), and all kanban operations included.
- **Feishu DM bot** (`helios-task-agent bot`): the full experience. Adds bot-only capabilities on top of the CLI — **kanban status push** (cards when tasks reach in-review/done), **confirm cards** (button-based approval), **AI review** (one-click open-code-review on the in-review diff, pushed as an HTML report link), **daily brief** (`HTA_DAILY_BRIEF=HH:MM`, pushes a current-iteration kanban overview to the allowlisted users (owner) every day), and **image messages** (`LLM_VISION=1`, requires a vision-capable model).

## Install

Requires: Node.js ≥ 20, macOS / Linux.

```bash
npm i -g helios-task-agent
```

Then run it directly (first launch opens an interactive wizard that writes config to `~/.helios-task-agent/.env`):

```bash
helios-task-agent        # interactive terminal agent
helios-task-agent bot    # Feishu DM bot
helios-task-agent --version   # show installed version
```

**Auto update check**: startup probes npm for a newer version (result cached 24h, silently skipped offline; follows your configured npm registry/mirror) and offers to update in place with a link to the changelog. Disable with `HTA_UPDATE_CHECK=0`; manual update: `npm i -g helios-task-agent@latest`.

**No need to preinstall helios-kanban**: when the local board is unreachable, the agent auto-spawns it via `npx -y helios-kanban@latest` (tracks the latest release by default — override with `HELIOS_KANBAN_PACKAGE` to pin a version; listens on `127.0.0.1` by default). Point `HELIOS_KANBAN_URL` at an existing instance, or set `HELIOS_KANBAN_AUTO_START=0` to disable auto-start.

**Feishu reads need lark-cli** (without it, Feishu task/doc reads are unavailable; kanban features are unaffected):

```bash
npm i -g @larksuite/cli && lark-cli auth login
```

From source: `npm install && npm start`.

## End-to-end flow

```text
Feishu Task Center / docs / group chats
  → List or read; expand Feishu URLs in title/description one hop (display only; ~10 expands per turn)
  → “Write to helios-kanban”: draft title + requirements summary
       → code write-gate confirm (terminal y/batch/N or Feishu card) → create (no auto start)
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
| Write gate | Creates/updates/deletes, start/stop/follow-up, approvals, Feishu sends require confirm. Terminal: `y` (once) / `batch` (allow similar this session) / `N` (same answer vocabulary as Feishu: 确认/批准/同意/执行, 同类免问/批量允许, etc.); timeouts 120s for normal writes, 300s for destructive ops; Ctrl+C at the prompt rejects. Feishu: confirm card (every write op shows the “allow-similar (this session)” button) or strict phrases (确认 / 同类免问 / 取消 — casual “ok” ignored); same timeout policy; the card updates to a final state after decision/timeout. New confirm **supersedes** a pending one. Missing gate → all writes fail closed |
| Batch approval | “Allow similar” for the rest of the session on the same write class (in-memory grant, lost on restart); plain confirm is **once**. **All write ops are eligible**, with per-class granularity: kanban/hk keys bind tool name + task id, lark writes group by command path + recipient (e.g. `im send` to `ou_x` vs `ou_y` are separate classes), skill scripts by script + arguments, memory writes by set/delete/note. Destructive ops (delete/cancel/stop/approve/start/archive/merge/push/execute) only get the longer 300s timeout — they are no longer excluded from allow-similar. `/confirm revoke` or 恢复确认 revokes (`/confirm on` kept as a legacy alias) |
| Session create cap | Max **10** kanban creates per session; `/clear` resets |
| Read allowlist | `lark_cli` reads (list/get/search…) free; writes/unknown → gate; `api` GET only exempt; `update` (self-upgrade) and `--help` with extra args count as writes |
| Untrusted wrap | External output (`lark_cli`, kanban MCP / `hk_cli`, `repo_fs`) plus kanban-event and AI-review context injections are wrapped UNTRUSTED; injected “instructions” ignored; rejected writes must not be retried via another tool |
| Owner claim | Empty `FEISHU_ALLOWED_OPEN_IDS` → first DM user becomes owner (written to `.env`); others rejected once |
| Source dedupe | URL → task map per user in `synced-sources.json`; self-heals after deletes; unreachable kanban conservatively blocks |
| Audit log | Approvals/denies/dup blocks (`blocked_dup`)/no-gate/results → `audit.log` (JSONL) |
| Workspace ready | Fills `base_branch` on start; detects silent setup failures |

## Kanban status push (bot)

Polls ~every 60s. Pushes on in-review (diff link), done (summary), cancel, failure, new approvals — and injects session context so you can reply in-thread.

In-review cards carry two buttons: "🔍 人工审查" (manual review) opens the kanban diff view; "🤖 AI 审查" (AI review) calls [open-code-review](https://github.com/alibaba/open-code-review) (`ocr`) on that attempt's diff (same scope as the kanban diff view: merge-base(target)..attempt branch), requires Simplified-Chinese output, renders the full result as an HTML report (written to the data dir `reviews/`, hosted by the bot's built-in static server), and pushes only the report link to Feishu (long results are no longer truncated) — the result is also injected into the session, so you can reply "按审查意见修一下" (fix per the review).

- First poll is baseline only (`watch-state.json`)  
- Does **not** notify on brand-new tasks  
- Failed pushes don't advance the snapshot — retried next poll (duplicates preferred over loss)  
- With `HELIOS_KANBAN_PROJECT_ID`, watches that project only  
- `KANBAN_WATCH=0` off; `KANBAN_WATCH_INTERVAL_SEC` (min 15)
- AI review: if `ocr` is not installed it is pulled via `npx` automatically (version pinned, override with `OCR_PACKAGE`; first run is slow); the LLM defaults to the bot's model config (derived `OCR_LLM_*` — note the ocr subprocess receives your LLM key as `OCR_LLM_TOKEN`; set a dedicated `OCR_LLM_TOKEN` env var to override and keep the main key isolated), and an explicit `OCR_LLM_URL` or an existing `~/.opencodereview/config.json` takes precedence; overall timeout 15 minutes; the report server listens on a random free port (bind address `HELIOS_REPORT_HOST`, default `127.0.0.1`); the report link hostname follows this rule: when `HELIOS_KANBAN_URL` is a loopback address (localhost/127.0.0.1/::1), the link reuses its hostname (same reachability as kanban links); when the kanban address is non-loopback (e.g. a LAN IP), the link hostname is the report server's **bind address** — `127.0.0.1` by default (report links then only open on that machine), and binding `0.0.0.0` makes the link hostname fall back to the machine hostname (`os.hostname()`), which LAN/phone clients may not resolve, so bind the machine's actual LAN IP instead; valid while the process lives; historical reports are cleaned up after 30 days

> **Phone reachability**: the kanban links and AI-review report links in pushed cards point at the machine running the bot. With the default `HELIOS_KANBAN_URL=http://localhost:7964`, these links **only work on that machine — they are dead links on your phone** (the bot logs a warning about this at startup). The correct setup for reviewing from your phone: set `HELIOS_KANBAN_URL` to the machine's LAN IP or Tailscale address **and** set `HELIOS_REPORT_HOST` explicitly to that same LAN IP (do **not** use `0.0.0.0` — the link hostname would fall back to the machine hostname (`os.hostname()`), which the phone may not resolve). Changing only `HELIOS_KANBAN_URL` leaves the report link hostname at the default bind address `127.0.0.1`, so the phone still can't open it. If the kanban stays on a loopback address, the report link hostname follows loopback too — **there is currently no way to reach reports from a phone in that setup**. Report URLs carry a random token.

## MCP health supervisor (bot)

~60s probe. Degrades to `hk_cli` only after consecutive probe failures (no flapping on transient jitter); auto-reconnect with backoff (down to ~every 5 min), skipped while a task is running so in-flight calls aren't killed; on recover: switch back (all transitions notified). `hk_cli` is **always** registered (bundled `hk.sh`); MCP is preferred.

## Config home

```text
~/.helios-task-agent/.env
~/.helios-task-agent/memory.json
~/.helios-task-agent/synced-sources.json   # Feishu source → kanban task (dedupe map)
~/.helios-task-agent/audit.log             # write-op audit (JSONL)
~/.helios-task-agent/watch-state.json      # kanban push snapshot
~/.helios-task-agent/daily-brief-state.json # daily-brief last-push date (no duplicate push same day)
~/.helios-task-agent/sessions/             # per-user conversation history (restored on restart; /clear wipes it)
~/.helios-task-agent/skills/               # user skills (target of /skills install)
~/.helios-task-agent/reviews/              # AI-review reports (HTML, cleaned up after 30 days)
~/.helios-task-agent/reports/              # work-summary reports
~/.helios-task-agent/update-check.json     # update-check cache (24h)
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
3. DM only (p2p; group messages are ignored — @-mentioning the bot in a group gets a one-line DM hint, at most once per group per 24h); no public webhook; process must stay up (e.g. `pm2 start helios-task-agent -- bot`)  

**Reconfigure**: to switch model / Base URL / API key, run `helios-task-agent bot --reconfig` to re-run the model/kanban config wizard (Feishu credentials are kept) — no hand-editing of `.env` needed; editing `~/.helios-task-agent/.env` directly also works. Bot has **no** `/config`; re-running bot with existing `FEISHU_*` does **not** reopen the wizard — to switch a wrongly bound bot use `helios-task-agent bot --rebind` (re-runs only the Feishu credential wizard; LLM/kanban config is kept; type `-` to clear the open_id allowlist). Terminal has `/config`.

## Commands

| Command | Purpose |
|---------|---------|
| `helios-task-agent` | Interactive terminal agent |
| `helios-task-agent bot` | Feishu DM bot (wizard if unconfigured) |
| `helios-task-agent bot --rebind` | Rebind / switch the Feishu bot (Feishu credential wizard only) |
| `helios-task-agent bot --reconfig` | Re-run the model/kanban config wizard (Feishu credentials kept; model / Base URL / API key) |
| `helios-task-agent-bot` | Same as `bot` (also supports `--rebind` / `--reconfig`) |
| `helios-task-agent help` / `-h` / `--help` | Help |
| `helios-task-agent --version` / `-v` | Show version |

Local: `npm start` / `npm run bot`.

## Adding skills

Doc-style skills: drop a `SKILL.md` with frontmatter into `<data-dir>/skills/<skill-name>/` — scanned at startup, no code change needed. The data dir is `HELIOS_TASK_AGENT_HOME` or `~/.helios-task-agent` (alongside `.env` and memory); custom skills live here so `npm i -g` upgrades never wipe them. Scan order: **user data dir first, bundled `skills/` as built-in fallback** — a same-named user skill wins.

Install and uninstall have official entry points (same in CLI and Feishu bot): `/skills install <skill-dir-path>` copies a local skill directory into the data dir (installing over an existing name updates it), and `/skills uninstall <name>` removes a skill (bundled built-in skills cannot be uninstalled). Do **not** put custom skills into the bundled `skills/` (the npm install directory — upgrades replace the whole directory); skills previously misplaced there are auto-migrated to the data dir at startup, with a printed notice. The frontmatter is the skill contract:

```markdown
---
name: my-skill
description: One line on when to use this skill (routing cue, always injected into the system prompt)
digest_sections:        # which `## ` sections get injected (case-insensitive substring match)
  - Quick workflow
  - Safety rules
---

# My Skill
Body… undeclared sections stay out of the prompt; the agent reads the full doc on demand
via the `skill_doc` tool (progressive disclosure).
```

- Missing `name`/`description` or `digest_sections` entries that match no section are reported by `validateSkills()` — surfaced as **startup warnings** (CLI and bot) and covered by unit tests, instead of silently degrading.
- Users can run `/skills` (same in CLI and Feishu bot) or just ask "what skills do you have".
- Skills can ship runnable scripts (node/shell/python, etc.): document the usage in SKILL.md and the agent runs them via the `skill_exec` tool. The script path is confined to the skill directory (`..`/absolute paths/symlink escapes are rejected), the interpreter is inferred from the extension (`.sh`→bash, `.js/.mjs/.cjs`→node, `.py`→python3; anything else needs an explicit `interpreter` from the bash/sh/node/python3/python whitelist), and the working directory is the skill directory. **Every execution asks the user for confirmation** (arbitrary code execution — treated as destructive with a 300-second timeout; "approve same kind" batching applies per specific script + arguments), and the child process inherits only a minimal environment.

**Kanban process**: auto-start only for **localhost** URLs. CLI exit **keeps** an auto-started board; bot exit **stops** that child. Remote URLs must already be up. Note: the kanban API has no authentication — when `HELIOS_KANBAN_URL` points off-box, traffic is plaintext and unauthenticated; use only on trusted networks (LAN / Tailscale).

## Environment variables

| Variable | Meaning |
|----------|---------|
| `LLM_*` | Required (wizard can write) |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Required for bot |
| `FEISHU_ALLOWED_OPEN_IDS` | Allowlist; empty → first DM user is owner (first-come-first-served — anyone who can find the bot could claim it, so configure it explicitly) |
| `HELIOS_KANBAN_URL` | Default `http://localhost:7964` |
| `HELIOS_KANBAN_AUTO_START` | Auto-spawn local board; `0` off |
| `HELIOS_KANBAN_MCP_COMMAND` / `ARGS` | Default `npx` + `-y helios-kanban@latest --mcp` |
| `HELIOS_KANBAN_PACKAGE` | Package spec for auto-start / default MCP, default `helios-kanban@latest` (tracks the latest release); set a pinned version to override |
| `HELIOS_KANBAN_HOST` | Listen address for the auto-started board, default `127.0.0.1` (the board has no auth — think twice before `0.0.0.0`) |
| `HELIOS_REPORT_HOST` | Listen address for the review-report static server, default `127.0.0.1` (does **not** follow `HELIOS_KANBAN_HOST`; reports contain code diffs — change only if you really need to expose them) |
| `OCR_PACKAGE` | Package spec npx pulls when `ocr` is missing, default pinned `@alibaba-group/open-code-review@1.8.0` |
| `OCR_LLM_TOKEN` | Dedicated LLM key for AI review; when set it wins over the derived bot key (keeps your main key away from the third-party ocr subprocess), URL/model still fall back to the bot config |
| `OCR_LLM_URL` / `OCR_LLM_MODEL` | Explicit LLM endpoint/model for AI review; when set they win over the config derived from the bot |
| `HELIOS_KANBAN_PROJECT_ID` / `HELIOS_KANBAN_REPO_ID` / `HELIOS_KANBAN_ITERATION` | Optional defaults; `HELIOS_KANBAN_PROJECT_ID` scopes bot watch |
| `HELIOS_TASK_AGENT_HOME` / `HELIOS_TASK_AGENT_ENV` | Data dir (default `~/.helios-task-agent`) / forced `.env` path |
| `KANBAN_WATCH` / `KANBAN_WATCH_INTERVAL_SEC` | Status push |
| `HTA_UPDATE_CHECK` / `HTA_UPDATE_REGISTRY` | Startup npm update check (default on; registry follows `npm config`) |
| `LLM_VISION` | `1` = bot accepts image messages: the image is downloaded and sent with that single request (**model must support image input**; images are never written to disk or conversation history; 10MB cap). Default off — image messages get the text-only rejection |
| `HTA_DAILY_BRIEF` | Daily brief (bot only): local `HH:MM` (e.g. `09:30`) — pushes the current-iteration kanban overview (in-progress / in-review / done / failed; all iterations when `HELIOS_KANBAN_ITERATION` is unset) to the allowlisted users (owner) every day. Unset or invalid = off |
| `HTA_TURN_TIMEOUT_MIN` | Wall-clock limit (minutes) for a single agent turn, default 30; on timeout the turn is aborted with a notice |
| `HTA_DEBUG` | `1` = kanban/MCP debug logs |

Load order: project → cwd → home `.env` (later wins); `HELIOS_TASK_AGENT_ENV` highest. See [.env.example](.env.example). Note: **credential/command-type high-risk keys in the cwd `.env` are ignored** (`LLM_API_KEY`, `FEISHU_*`, `HELIOS_KANBAN_MCP_COMMAND/ARGS`, `HELIOS_KANBAN_PACKAGE`, `HELIOS_KANBAN_URL`, proxy and npm registry keys, etc. — a supply-chain/command-injection guard; ignored keys only produce a one-line `console.warn`). Put such keys in `~/.helios-task-agent/.env` (or the shell environment / project `.env`).

### Open-platform checklist

1. Company app → enable Bot  
2. Events → **long connection** → `im.message.receive_v1`  
3. (Optional) Callbacks → **long connection** → `card.action.trigger`  
4. Permissions: read DMs, send as app, add message reactions (typing ack; falls back to a text placeholder without it) → publish  
5. Copy App ID / Secret  

## What you can say

**Terminal**: `/help` `/config` `/status` `/tools` `/skills` `/memory` `/clear` `/confirm` `/confirm revoke` (`/confirm on` legacy alias) `/exit` `/quit` (Ctrl+C interrupts a turn; during a confirm prompt it rejects that write)

**Feishu**: `/help` `/status` `/tools` `/skills` `/memory` `/clear` `/confirm` `/confirm revoke` `/stop` (aborts the running task, cancels pending write confirms, and discards queued messages). Instant: `/help` `/stop` `/confirm` `/status` `/tools` `/skills`. Queued: `/memory` `/clear` and normal chat.

**Examples**: sync/list Feishu tasks; write to helios-kanban; turn a group chat into tasks; start with a named executor; list projects; follow-up / status.

Bot accepts text and rich-text messages (links/@/images/files/code blocks are converted to plain text); with `LLM_VISION=1` you can also send image messages (analyzed by the model with that single request — never written to disk or history, 10MB cap); other types rejected. Replies split ~3000 chars; the progress placeholder updates on tool calls (throttled ~2s) and heartbeats every 10s during silent LLM thinking (with elapsed seconds). Per-user serial queue; `message_id` dedupe 10 minutes. New messages arriving while busy or while a confirm is pending get a queued/hint receipt. Conversation history is persisted per user (`sessions/`) and restored after restart; `/clear` wipes it from disk too.

Memory tools: `memory_set` / `get` / `delete` / `note` (notes keep roughly the latest 50 entries). Keys: `feishu_task_source`, `feishu_chat_id`, `preferred_*`, `last_sync_at`.

## Tools

| Tool | Role |
|------|------|
| `lark_cli` | Feishu/Lark I/O |
| kanban MCP | Preferred board API |
| `hk_cli` | Always on; bundled `hk.sh` REST fallback/supplement |
| `repo_fs` | Optional `list` / `read` / `grep` under a kanban repo path |
| `work_summary` | Generate work-summary reports (HTML/MD) |
| `skill_doc` | Read an installed skill's full doc (SKILL.md) on demand |
| `skill_exec` | Run scripts inside a skill directory (confirmation per run by default; "approve same kind" applies per specific script + arguments) |
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

## Release (maintainers)

Pushing a tag triggers the GitHub Action that publishes to npm (`.github/workflows/publish.yml`):

```bash
npm version patch          # or minor / major — bumps version and creates the tag
git push --follow-tags     # pushes commit + tag, triggering the release
```

The tag must match `package.json` `version` (enforced in CI). Prerelease versions (e.g. `1.1.0-beta.0`) go to the npm `next` dist-tag; stable releases go to `latest`. CI runs typecheck + build before publishing (`prepublishOnly` / `prepack`). smoke / e2e need a local helios-kanban — run `npm run verify` locally before tagging.

Requires an `NPM_TOKEN` repository secret (npm → Access Tokens → Granular Token with publish permission).

## License

ISC
