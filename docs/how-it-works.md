# How it works

Four parts: **reports** that agents write, a **hub** that watches them, a **project manager** (a model) that reads
them, and **channels** — Telegram and the browser — through which you talk to it.

## 1. Reports: agents write, the repository keeps

Hooks are small commands that Claude Code and Codex run at fixed moments:

| Host | Event | What Leftoff does |
|---|---|---|
| Claude Code | `SessionStart` | Injects the reporting protocol and any message from you (the inbox) into the session. |
| Claude Code | `UserPromptSubmit` | Delivers inbox messages that arrived during the session. |
| Claude Code | `Stop` | At the end of a turn that changed something, asks the agent to write its report first. |
| Claude Code | `StopFailure` | Notes a subscription limit or an error, with its reset time. |
| Codex | `SessionStart`, `UserPromptSubmit`, `SessionEnd` | The same duties. |
| Codex | `notify` | Codex has no per-turn stop hook; its `notify` program marks the end of a turn. |

The agent then runs `leftoff report --status … --done … --next …`, which writes
`.leftoff/reports/<date>/<time>-<agent>.md` ([format](protocol.md)), adds the commits made since its last report,
and regenerates `.leftoff/STATE.md`, the project's current picture. A hook **always exits successfully**, whatever
goes wrong; a broken Leftoff must never stop an agent (D-008).

Everything lives in your repository, so it is versioned with the code, shows up in review, and is readable
without Leftoff:

```
.leftoff/
  project.yaml     name, purpose, agents, visibility (public | private)
  reports/…        one Markdown file per agent turn
  decisions.md     choices that shape the project, with the reason
  STATE.md         generated: where the project stands
  inbox/           messages waiting for an agent (not committed)
backlog/           optional Backlog.md tasks
```

## 2. The hub: one small process, always on

`leftoff hub` loops once a minute over every registered repository and every git worktree of it. It reads reports,
commits and (with Paseo) the live agents, compares with what it saw last time, and decides what is worth telling you.
The first pass is a silent baseline: starting the hub does not flood you with old news.

Most of what it says is **templates, not model calls** — a finished task, a blocked agent, the morning stand-up. The
model runs only when you ask something or when a request needs interpreting, which is why a month usually costs a
few cents to a couple of dollars.

What it pushes depends on `/alerts`: `critical` (default) is only what needs you — a blocked agent, a question, a
limit reached; `normal` adds finished work; `all` adds unreported commits. Quiet hours (`/quiet on`) hold the rest.
The panel always shows everything.

## 3. The project manager

A model with a fixed set of **tools**, each of which only reads or does something small and safe:

| Reads | Does |
|---|---|
| projects, reports, decisions, git log, search, usage limits, its own spend | create or remove backlog tasks; mute a project; ask a working agent for a status update (rationed); **draft** an instruction for an agent |

It has no shell, no file access beyond Leftoff's own data, and no way to send anything to an agent itself. See
[security.md](security.md). Its system prompt makes it answer from the facts, with dates, and say "I don't know"
when the reports don't say.

**Instructions to agents** work like this: you say what you want in your own words → the PM writes a precise
prompt and shows it to you → you answer *yes* (or *no*, or describe a change) → Leftoff delivers the exact text that
was shown. The "yes" is matched by code against a fixed list of words in six languages, never by the model, and a
draft can only be approved after you have seen it, in the same conversation, within two hours.

## 4. Channels

- **Telegram**: one forum group, a topic per project plus *General*; a user allow-list (your id only).
- **The control panel**: served by the hub; a mirror of the same conversation, a sprint board per project derived
  from reports and Backlog.md, and the agent list. A message typed in the panel goes to the hub like a Telegram one;
  its answers stay in the panel. See [web.md](web.md).

Voice (optional) is Deepgram Nova-3 for speech to text and Aura-2 for replies; the transcript is always shown
back to you before it is acted on.

## Subscription limits

Claude Code and Codex stop when a usage window is exhausted. For Codex, Leftoff reads the window percentages Codex
logs; for Claude Code it reacts to the failure hook. You get a warning (default 80 %), a notice when the limit is
reached, and — if the agent is reachable — an automatic restart a minute after the reset, in the very session that
stopped.

## Where things are

| | |
|---|---|
| `~/.config/leftoff/config.yaml` | your settings ([reference](configuration.md)) |
| `~/.config/leftoff/secrets.env` | keys and tokens, mode 600 |
| `~/.config/leftoff/projects.json` | the repositories being watched |
| `~/.config/leftoff/` (rest) | hub state, chat feed, spend ledger, logs, cache — all disposable |
| `<repo>/.leftoff/` | the project's memory |

The design decisions and the reasons for them are in [decisions.md](decisions.md).
