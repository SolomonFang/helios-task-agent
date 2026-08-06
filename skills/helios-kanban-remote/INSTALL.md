# Agent Self-Install Guide — Helios Kanban Remote Skill

> **Audience**: AI agents (Cursor, Claude Code, Codex, etc.)
>
> **Trigger**: User says "安装 helios-kanban-remote 技能", "install helios kanban skill", or gives you this repo / INSTALL.md URL.
>
> **Goal**: Install the skill from the helios-task-agent npm package (built-in copy), configure, and verify — **without human manual steps**. Execute every shell command yourself. Ask the user only when information is missing.

---

## Source (single source of truth)

| Item | Value |
|------|-------|
| **唯一安装源** | npm 包 `helios-task-agent` 内置副本：`node_modules/helios-task-agent/skills/helios-kanban-remote/` |
| **备选来源** | 本仓库默认分支：https://github.com/SolomonFang/helios-task-agent |
| **Skill path** | `skills/helios-kanban-remote/` |
| **This document** | https://github.com/SolomonFang/helios-task-agent/blob/main/skills/helios-kanban-remote/INSTALL.md |

The skill ships **inside the `helios-task-agent` npm package** (`files` includes `skills/`). Do not clone any branch — copy the bundled files, or fetch them from this repo's default branch as a fallback.

> **命名说明**：看板的 npm 包名是 `helios-kanban`，源码仓库叫 `SolomonFang/vibe-kanban`（同一项目，历史命名）；而本 skill 属于 agent 侧，随 `helios-task-agent`（仓库 `SolomonFang/helios-task-agent`）一起发布。安装一律以 `helios-task-agent` npm 包内的副本为准，不依赖任何 git 分支。

---

## Agent instructions — follow in order

```
Install progress:
- [ ] Step 1: Detect environment
- [ ] Step 2: Get skill files from this repo
- [ ] Step 3: Install to agent skills directory
- [ ] Step 4: Check dependencies (curl, jq)
- [ ] Step 5: Configure HELIOS_KANBAN_URL
- [ ] Step 6: Verify connectivity
- [ ] Step 7: Report result to user
```

---

### Step 1: Detect environment

```bash
uname -s
echo "HOME=$HOME"
pwd
```

Determine agent type and `SKILLS_ROOT`:

| Agent | `SKILLS_ROOT` |
|-------|---------------|
| Cursor (global) | `$HOME/.cursor/skills` |
| Claude Code | `$HOME/.claude/skills` |
| Cursor (project) | `<workspace>/.cursor/skills` |
| Other agents | user-provided, or `$HOME/.cursor/skills` |

```bash
SKILLS_ROOT="$HOME/.cursor/skills"   # adjust per table
SKILL_DIR="$SKILLS_ROOT/helios-kanban-remote"
SRC_DIR=""   # set in Step 2
```

**Do not** install into `~/.cursor/skills-cursor/` (reserved by Cursor).

---

### Step 2: Get skill files (npm package copy is the install source)

**Option A — copy from the installed npm package** (default):

```bash
PKG_DIR="$(npm root -g)/helios-task-agent"
test -f "$PKG_DIR/skills/helios-kanban-remote/SKILL.md" || {
  echo "helios-task-agent 未全局安装，先执行: npm i -g helios-task-agent"; exit 1
}
SRC_DIR="$PKG_DIR/skills/helios-kanban-remote"
echo "Using bundled skill: $SRC_DIR"
```

**Option B — fallback: fetch from this repo's default branch** (no npm access):

```bash
RAW="https://raw.githubusercontent.com/SolomonFang/helios-task-agent/main/skills/helios-kanban-remote"
SRC_DIR="${TMPDIR:-/tmp}/helios-kanban-remote"
rm -rf "$SRC_DIR" && mkdir -p "$SRC_DIR/scripts"
for f in SKILL.md INSTALL.md reference.md examples.md scripts/hk.sh; do
  curl -fsSL "$RAW/$f" -o "$SRC_DIR/$f" || { echo "error: fetch failed: $f"; exit 1; }
done
echo "Fetched skill to: $SRC_DIR"
```

---

### Step 3: Install to agent skills directory

```bash
mkdir -p "$SKILLS_ROOT"
rm -rf "$SKILL_DIR"
cp -r "$SRC_DIR" "$SKILL_DIR"
chmod +x "$SKILL_DIR/scripts/hk.sh"
HK="$SKILL_DIR/scripts/hk.sh"

# Verify
test -f "$SKILL_DIR/SKILL.md" && test -f "$HK" && echo "OK: installed to $SKILL_DIR"
```

---

### Step 4: Check dependencies

```bash
command -v curl >/dev/null || { echo "MISSING: curl"; exit 1; }
command -v jq   >/dev/null || { echo "MISSING: jq"; exit 1; }
```

If `jq` is missing, install when possible:

```bash
# macOS
brew install jq

# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y jq
```

---

### Step 5: Configure environment variables

**Required**: `HELIOS_KANBAN_URL` — URL of the running Helios Kanban instance.

1. Use existing env var if already set.
2. Otherwise **ask the user once**: "请提供 Helios Kanban 地址，例如 `http://100.x.x.x:7964`"
3. Optional defaults (ask if user wants shortcuts):
   - `HELIOS_KANBAN_PROJECT_ID` — default project UUID
   - `HELIOS_KANBAN_REPO_ID` — default repo UUID
   - `HELIOS_KANBAN_ITERATION` — default iteration code (e.g. `260717`)

```bash
export HELIOS_KANBAN_URL="<user-provided-url>"
# export HELIOS_KANBAN_PROJECT_ID="<uuid>"
# export HELIOS_KANBAN_REPO_ID="<uuid>"
# export HELIOS_KANBAN_ITERATION="260717"
```

Persist (skip if already in profile):

```bash
PROFILE="$HOME/.zshrc"
[ -f "$HOME/.bashrc" ] && PROFILE="$HOME/.bashrc"
grep -q 'HELIOS_KANBAN_URL' "$PROFILE" 2>/dev/null || \
  echo "export HELIOS_KANBAN_URL=\"$HELIOS_KANBAN_URL\"" >> "$PROFILE"
```

Kanban server (separate host) must be running:

```bash
HOST=0.0.0.0 PORT=7964 npx helios-kanban
```

---

### Step 6: Verify connectivity

```bash
bash "$HK" health
bash "$HK" projects
```

Success: `health` returns `"success": true`; `projects` returns a JSON array.

If failed → check URL, kanban process, network (Tailscale). Do not claim install succeeded.

---

### Step 7: Report result to user

```markdown
## Helios Kanban Remote 技能已安装

- **来源**: npm 包 `helios-task-agent` 内置副本
- **安装路径**: `{SKILL_DIR}`
- **CLI**: `{SKILL_DIR}/scripts/hk.sh`
- **Kanban 地址**: `{HELIOS_KANBAN_URL}`
- **连通性**: 正常

你现在可以对我说：
- 「有哪些项目」
- 「看看进行中的任务」
- 「创建一个任务：……」
- 「用 Claude 跑这个任务」
```

---

## User gives agent only a URL

Tell any agent:

```
请阅读并执行安装文档，完成 helios-kanban-remote 技能安装：
https://github.com/SolomonFang/helios-task-agent/blob/main/skills/helios-kanban-remote/INSTALL.md
```

Agent should fetch INSTALL.md from the repo's default branch, then run Steps 1–7.

Raw URL for fetching:

```
https://raw.githubusercontent.com/SolomonFang/helios-task-agent/main/skills/helios-kanban-remote/INSTALL.md
```

---

## Update

```bash
npm i -g helios-task-agent@latest   # 升级 npm 包后重跑 Step 2 Option A + Step 3
# 或重新拉取默认分支文件（Step 2 Option B）并重新拷贝（Step 3）
```

---

## Uninstall

```bash
rm -rf "$SKILL_DIR"
```

---

## Troubleshooting

| Symptom | Action |
|---------|--------|
| npm 包内找不到 skill | 确认 `npm i -g helios-task-agent` 成功；或改用 Step 2 Option B |
| `health` connection refused | Kanban not running or wrong `HELIOS_KANBAN_URL` |
| API 403 | Set `VK_ALLOWED_ORIGINS` on kanban server (reverse proxy) |
| Skill not loading | Confirm `$SKILL_DIR/SKILL.md` exists; restart agent session |

---

## After install

Read `$SKILL_DIR/SKILL.md` for usage. API details in `reference.md`, examples in `examples.md`.
