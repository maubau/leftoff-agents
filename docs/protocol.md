# The report protocol

A Leftoff report is a Markdown file with YAML frontmatter, written by a coding
agent at the end of a turn that changed something. It is the only thing the
project manager treats as fact about what an agent did.

Path: `.leftoff/reports/<YYYY-MM-DD>/<HHMM>-<agent>.md`, with a `-2`, `-3` suffix
when an agent reports twice inside a minute. Nothing is ever overwritten.

```markdown
---
schema: 1
agent: claude              # short id, also used for the inbox file
host: claude-code          # claude-code | codex | other
at: 2026-09-28T14:32:00+02:00
status: blocked            # progress | done | blocked | needs_input | idle
done:
  - Booking form with date validation
doing:
  - Airbnb iCal sync, about half
blocked:
  - Need the iCal URL of the listing
next:
  - Finish sync, then tests
decisions:                 # choices that shape the project; also go to decisions.md
  - iCal feed over Airbnb API — the API needs a partner account
findings:                  # learned this turn, worth keeping
  - Airbnb iCal feeds refresh roughly every 3 hours
question:
  text: iCal feed or Airbnb API?
  options: [iCal feed, Airbnb API]
  recommend: iCal feed
handoffs:                  # work a teammate must do (--handoff "main-dev: …"); see below
  - to: main-dev
    ask: Expose GET /api/availability for the calendar
# filled in by leftoff, never by the agent:
commits: [a1b2c3d, e4f5a6b]
filesChanged: 3
usage: { costUsd: 1.84, model: claude-opus-5 }
sessionId: 0a754eab
paseoAgent: 0d8b831c-…     # when run inside Paseo: the PM's address for this agent
branch: init-dev           # where the work happened
worktree: /home/…/.paseo/worktrees/1bv5yawf/hapless-vulture
---

Optional Markdown notes. Rarely needed; the frontmatter is what gets read.
```

## What the statuses mean

| Status | Meaning | Pushed to chat |
|---|---|---|
| `progress` | The turn moved things along; nothing is wanted from the human. | no |
| `done` | The assigned task is finished — not merely that the turn ended. | yes |
| `blocked` | Cannot continue without something only the human can supply. | yes, at once |
| `needs_input` | Cannot continue without a decision. Pair with `question`. | yes, at once |
| `idle` | Finished and holding, with nothing claimed. | yes |

`done`, `blocked` and `needs_input` are what make the PM speak unprompted, so
they are the ones agents must not inflate. An honest `progress` beats an
optimistic `done`.

## When to report

At the end of every turn that changed files, **or** made a decision, **or** learned
something the owner will want later (D-011). A turn of pure conversation needs no
report. Claude Code enforces both cases once per turn through the Stop hook; Codex
is reminded through its inbox at the next turn (D-003).

## Fields agents must not set

`commits`, `filesChanged`, `usage`, `sessionId`, `paseoAgent`, `branch` and
`worktree` are derived by Leftoff. Commits are
attributed by sha and excluded once claimed, so each commit belongs to exactly
one report (see decisions D-007).

## The inbox

`.leftoff/inbox/<agent>.jsonl`, append-only, one JSON object per line:

```json
{"id":"…","at":"2026-09-28T19:02:11.000Z","from":"user","text":"usa Leaflet","deliveredAt":null}
```

Delivery sets `deliveredAt`, which is why the file is rewritten rather than only
appended to. A crash mid-write can at worst re-deliver a message. A corrupted
line is skipped, never fatal.

## Guarantees for host integrators

- Every hook exits 0, always. Hook failure degrades project management, never the
  agent's turn.
- A repository without `.leftoff/project.yaml` produces no output whatsoever.
- `Stop` never blocks twice in a turn (`stop_hook_active` is honoured).
- Sub-agents are never asked to report; the main agent reports for the turn.
- Commits touching only `.leftoff/` or the protocol block are never attributed to an agent.

## Handoffs between agents

When a project has several agents, each is told its team at session start: ids, workspace names and
roles (`leftoff agents role <agent> "…"`). Work that belongs to a teammate is handed off rather than done:

```bash
leftoff report --status progress --doing "Booking page" \
  --handoff "main-dev: expose GET /api/availability; the calendar needs dates and status"
```

The text before the first colon names the teammate (id, workspace name or a word of its role); the rest is
the ask. The hub shows it to the owner as a draft for that teammate, and sends it only when they approve
(D-036). The teammate's next report comes back as the answer; if the asker must act on it, the teammate
hands off back.
