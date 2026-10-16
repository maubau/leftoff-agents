# Audit: what Leftoff does today (2026-10-16)

An audit of the code on `main`, written before the MCP server is designed ([mcp-design.md](mcp-design.md)). Every
claim points at the file that implements it. «PRD» is the original product requirements document (working name
*standup*), kept privately; [decisions.md](decisions.md) records every departure from it.

## 1. Milestones M0–M3 and the hub

| PRD milestone | State | Where |
|---|---|---|
| **M0 Reports**: `init`, report schema, `report` / `inbox` / `brief`, STATE.md, Stop and session hooks for Claude Code and Codex | **Done** | `src/commands/init.ts`, `src/commands/report.ts`, `src/commands/inbox.ts`, `src/core/report.ts`, `src/core/render.ts`, `src/hosts/claude-code.ts`, `src/hosts/codex.ts`, `src/hooks/` |
| **M1 The PM on Telegram**: hub daemon, PM with read tools, proactive messages, daily stand-up, quiet hours, mute, costs | **Done** | `src/hub/hub.ts`, `src/hub/watcher.ts`, `src/pm/` (Anthropic or OpenAI-compatible model), `src/channels/telegram.ts`, `src/pm/ledger.ts` |
| **M2 Two-way**: replies become decisions, inbox plus Paseo push, backlog updated, answers to agent questions | **Done**, and extended: drafts approved by a fixed «yes» (D-022, D-041), handoffs between agents (D-036, D-059), macro plans (D-051), autonomous mode (D-041) | `src/hub/approval.ts`, `src/hub/autonomy.ts`, `src/agents/delivery.ts`, `src/core/backlog.ts`, `src/core/plan.ts` |
| **M3 WhatsApp** (OpenWA) | **Not started.** `channel` accepts `telegram` or `none` only | `src/core/config.ts` (`channel: z.enum(["telegram", "none"])`) |

Beyond the PRD: a web control panel (D-030 onwards, `src/web/`), voice in and out (`src/voice/`), subscription limit
alerts and restarts after a reset (`src/limits/`), new projects and agents created from Leftoff (D-040, D-056),
six languages (`src/i18n/`).

**The hub** is one long-running process, `leftoff hub` (`src/commands/hub.ts`). It polls every
`notify.pollSeconds` (default 60), runs the Telegram channel when configured, and serves the web panel on
`web.host:web.port` (default `127.0.0.1:4777`; any other address requires `LEFTOFF_WEB_TOKEN`). `leftoff hub
install-service` writes a **systemd user unit** (`leftoff-hub.service`); there is no launchd or Windows service, so
outside Linux the hub runs in the foreground or under the user's own supervisor.

## 2. Reports, STATE.md, decisions.md, inbox, Backlog.md

All exist and are used every day.

- **Reports**: `.leftoff/reports/YYYY-MM-DD/HHMM-<agent>.md`, YAML front matter and a free body
  (`src/core/report.ts`, schema in [protocol.md](protocol.md)). Written by `leftoff report`, which agents run at the
  end of a turn; the Stop hook reminds them when they forget (`src/hooks/`).
- **STATE.md**: `.leftoff/STATE.md`, regenerated from the snapshot (`src/core/render.ts`, `src/core/snapshot.ts`).
- **decisions.md**: `.leftoff/decisions.md`, appended by agents (`--decided`), by the hub when the owner approves
  something, and by mode changes (`src/core/decisions.ts`). Not to be confused with this repository's
  `docs/decisions.md` (design decisions of Leftoff itself).
- **Inbox**: `.leftoff/inbox/<agent>.jsonl`, git-ignored, delivered by the SessionStart and UserPromptSubmit hooks
  (`src/core/inbox.ts`).
- **Backlog.md**: tasks in the repository's `backlog/tasks/*.md` (Backlog.md format), read and written by
  `src/core/backlog.ts`; plans as tasks with phases and dependencies (D-051, `src/core/plan.ts`, `leftoff plan`).

## 3. Paseo

In place and used heavily, through the `paseo` command line (D-002), not the SDK the PRD named
(`src/agents/delivery.ts`, `src/agents/create.ts`, `src/core/agents.ts`, [paseo.md](paseo.md)).

- **Knows the agents and their state**: `paseo ls --json` (running, idle, closed), one call in flight at a time
  (D-055); each Paseo workspace is an agent (D-034).
- **Sends follow-ups**: `paseo send` to an idle agent. A message for a working agent waits for its turn to end
  (D-042); a closed session gets it in its inbox and on reopening (D-050).
- **Asks a quiet agent for a report**, rationed (D-043, `statusChecks`).
- **Restarts an agent stopped by a subscription limit** a minute after the reset (`src/limits/`).
- **Creates agents and projects**: `paseo workspace create` and `paseo run` (D-040, D-056).
- **Reads usage**: Claude's 5-hour and weekly share from the daemon's internal client API, read-only (D-060,
  `src/limits/paseo-usage.ts`). Not a documented interface.

## 4. Where state lives, and what to back up

| Where | What | Versioned |
|---|---|---|
| `<repo>/.leftoff/` | `project.yaml`, reports, `decisions.md`, `STATE.md` | **Yes**, by the project's own git (D-004); `inbox/` is ignored |
| `<repo>/backlog/` | tasks (Backlog.md) | Yes |
| `$XDG_CONFIG_HOME/leftoff/` (default `~/.config/leftoff/`) | `config.yaml`; `secrets.env` (API keys, bot token, panel token); `projects.json` (registry); `hub-state.json` (drafts, handoffs, modes, queue, counters, room themes, creations); `feed.jsonl` and `activity-log.jsonl` (conversation and register); `spend.jsonl` (PM costs); `chat/` (PM conversation memory); `limits/` (subscription readings); `activity/` (current turns) | **No** |

There is **no SQLite**: `globalPaths.cache` (`src/core/paths.ts`) names a `cache.sqlite` that nothing opens. The
PRD's «SQLite as cache/index» became plain JSON and JSONL files.

**Users must back up** `~/.config/leftoff/`, above all `secrets.env` (credentials), `config.yaml`, `projects.json`
and `hub-state.json` (the owner's modes and pending approvals). Everything in it but `secrets.env` and `config.yaml`
can be rebuilt or lost without damage to the projects' memory, which is in the repositories.

## 5. Chat channel

**Telegram only** (`src/channels/telegram.ts`, grammY): one bot, one private forum group with a topic per project
plus General, an allowlist of user ids (`telegram.allowedUserIds`). Set up with `leftoff connect telegram`; the bot
token is `TELEGRAM_BOT_TOKEN` in `secrets.env`. `channel: none` exists and runs the hub with no chat (the panel and
the console still work). WhatsApp (M3) is not implemented.

## 6. Setup-specific code, and conflicts with the MCP design

Nothing names a person, host, address or project; defaults are generic. What is still tied to a setup:

- **Linux-only service**: `leftoff hub install-service` writes a systemd user unit (`src/commands/hub.ts`).
- **Paseo's home**: `src/core/agents.ts` honours `PASEO_HOME`, but `src/hosts/claude-code.ts` and
  `src/limits/claude.ts` read `~/.paseo/config.json` from the home directory directly. A user with another Paseo home
  gets no hooks in Paseo's extra Claude config directories and no account names. Small bug, to fix first.
- **Paseo usage reader** (D-060) loads the installed `paseo` command's internal modules: works only with Paseo and
  only with its current client layout. It degrades to the status line, by design.
- **Default `channel` is `telegram`**, so a fresh install expects a bot. The MCP «external front end» mode wants
  `none` to be an equal choice; the default can stay for compatibility, with the setup guide offering both.
- **Defaults that are generic but opinionated**: `projects.root: ~/projects` (D-056), web panel port 4777.

Conflicts with the MCP design, to resolve in it:

- **Who approves a write.** Today an instruction goes out on the owner's fixed-list «yes» in chat or panel (D-022,
  D-041). An MCP write with a `confirm` argument moves that judgement to the client's model: it needs its own rules
  (writes off by default, a per-client allowlist, never for what looks irreversible, logged in decisions.md).
- **Events are not persisted as events.** The hub computes report and unreported-commit events in memory each pass
  (`src/hub/watcher.ts`); what survives is text in `feed.jsonl` and `activity-log.jsonl`. `get_events(since_cursor)`
  needs a structured, append-only log with a cursor.
- **`stage` and `url`** do not exist in `project.yaml` (`src/core/project.ts`).
- **Tools exist, as the PM's.** `src/pm/tools.ts` already has read tools (`list_projects`, `project_status`,
  `read_reports`, `read_decisions`, `search`, `git_log`, `usage_limits`, `spending`) and write actions behind
  approval. The MCP server should reuse that layer, not grow a second one.
- **Private projects** are filtered in two places (`src/web/data.ts`, `#chatProjects` in `src/hub/hub.ts`); MCP must
  use the same filter, not a third copy.
