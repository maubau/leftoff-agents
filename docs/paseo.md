# Leftoff and Paseo

## What Paseo is

[Paseo](https://paseo.sh) ([source](https://github.com/getpaseo/paseo), Apache-2.0) is an open source control
plane for coding agents. It runs agents such as Claude Code and Codex as managed sessions on a machine, gives each
one its own git worktree and branch, and lets you watch and steer them from a desktop, mobile or web app, or from
its `paseo` command line.

Leftoff and Paseo solve neighbouring problems:

| | Paseo | Leftoff |
|---|---|---|
| Runs the agents | yes | no |
| Isolates each agent in a worktree | yes | no |
| Remembers, per project, what each agent did and what is open | no | yes |
| Tells you when an agent is blocked, and answers "where are we?" | no | yes |

Leftoff is an independent project. It is not made by, endorsed by or affiliated with Paseo.

## You do not need Paseo

Leftoff works with agents started anywhere — a terminal, an IDE, a CI box. The reports come from hooks, which run
inside the agent whatever started it. Without Paseo:

- reports, the board, the stand-up, the questions that reach your phone: **all work**;
- an instruction you approve cannot reach the agent while it is running; it waits in the agent's **inbox**
  (`.leftoff/inbox/<agent>.jsonl`) and the hooks hand it over at the agent's next turn;
- a limit-reset restart (see below) also goes through the inbox.

## What changes with Paseo

When Leftoff can run `paseo` (it looks on your `PATH`), it:

1. **Knows which agents exist and whether they are working** (`paseo ls --json`), so "is anyone still working on
   Harbor?" is answered from fact, not from the age of the last report.
2. **Delivers instructions live** (`paseo send <agent> --prompt-file … --no-wait`). To a running agent the message
   lands inside its current turn, without interrupting it; to an idle agent it starts a new turn. If Paseo cannot
   reach the agent, the instruction goes to the inbox and you are told. It is never sent both ways.
3. **Gives each workspace its own agent.** Paseo's workspace title becomes the agent's name, so three Claude
   sessions in three workspaces of one project are three agents, each with its own reports and its own link.
4. **Understands worktrees.** Paseo puts each agent in `~/.paseo/worktrees/<id>/<name>`; Leftoff reads reports from
   every worktree of a project and attributes them to the right branch.
5. **Wakes an agent after a subscription limit resets.** The agent that was stopped is restarted in its own session,
   a minute after the reset time — not every agent of that provider.
6. **Asks a quiet agent for an update.** A working agent whose last report is stale (default: two hours, between
   09:00 and 21:00) is asked, at most a few times a day.

## Setting it up

There is nothing to configure in Leftoff. Install Paseo, start its daemon, and run your agents from it. Check:

```bash
paseo ls --json          # your agents, as Paseo sees them
leftoff hosts doctor     # hooks in place, also for Paseo's Claude Code providers
```

Paseo can run Claude Code with a different config directory per provider (for instance one for a work account and
one for a personal account). `leftoff init` reads `~/.paseo/config.json`, finds every `CLAUDE_CONFIG_DIR` it declares
and installs the hooks in each of them, so agents started from any provider report.

An agent started by Paseo gets `PASEO_AGENT_ID` in its environment; the hooks record it in the report
(`paseoAgent:`), and that is how Leftoff knows where to send your instructions.

## Caveats

- Developed and verified against **Paseo 0.10.3**. Leftoff only calls `paseo ls --json` and `paseo send`, and reads
  `~/.paseo/config.json` and `~/.paseo/projects/workspaces.json`. A future Paseo may change those; if it does,
  Leftoff falls back to the inbox rather than failing, and an issue or pull request is welcome.
- Leftoff uses the CLI, not Paseo's SDK, to stay free of an extra dependency (see D-002 in
  [decisions.md](decisions.md)).
- Subscription-limit detection for Claude Code agents only learns about a limit when it is hit; Paseo does not expose
  the percentage used by headless agents.
