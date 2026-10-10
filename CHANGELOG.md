# Changelog

## Unreleased

- Teams: agents have roles (`leftoff agents role`, or tell the PM), and every agent hears its team at session start.
- Handoffs: `leftoff report --handoff "<teammate>: <ask>"`; the owner approves each one in the project's thread, the
  PM passes it on, and the teammate's answer comes back (D-036).
- The office: a pixel-art view of each project's team in the panel, and `/office` in Telegram (D-037).
- The office reacts: the PM sits up (at its screen, or with a phone for Telegram) when the owner writes, and an agent walks over to it when spoken to (D-038).
- The office in the panel prints each agent's name and role under its desk (long roles end in an ellipsis, the whole text in a tooltip).
- The overview is a building: a room per project with its agents in it (lights off for a project with none), in four layers that shift with the pointer or the scroll (not with reduced motion) (D-044).
- Telegram: Yes/No buttons under drafts and handoffs; agents with a role get a face in messages.
- Model settings: the PM's model and effort, and each Paseo agent's thinking level (its model too, once Paseo's
  command line allows it), chosen from the control panel's API; Haiku 5.5 and Fable 5.1 priced, efforts up to `max` (D-039).
- New agents from the control panel's API: a worktree workspace in Paseo named after the agent, the agent started in
  it with its role and first task, registered in Leftoff at once; agents' names and roles editable, the Paseo
  workspace renamed with them (D-040).
- Control or autonomous, per project: in an autonomous project what the owner asks for, and teammates' handoffs, go
  out at once and are told; anything destructive or irreversible, and the PM's own ideas, still wait for a yes. Set
  from the panel's API or in chat (turning it on asks once). The PM no longer asks "shall I tell X?" before drafting
  (D-041).
- Leftoff no longer interrupts a working agent: a message for it waits until Paseo lists it as idle, then goes out,
  and the owner is told (D-042).
- What each agent is doing now, between reports, whoever asked — the request of its turn and its latest step, from its
  transcript — on its card and in the PM's project_status (D-043). docs/paseo.md documents what Leftoff and Paseo see
  of each other.

## 0.1.0 — first public release

- Hooks for Claude Code and Codex that make agents report after each turn into `<repo>/.leftoff/`.
- `leftoff init`, `brief`, `report`, `inbox`, `state`, `hosts`, `projects`, `ask`, `pm`, `connect`, `hub`, `web`.
- The hub: a polling loop over every repository and worktree, with templated alerts and a daily stand-up.
- The project manager: Anthropic (default) or any OpenAI-compatible model, a monthly spending cap, tools that read
  reports, decisions, backlog and git history, and a drafting tool for instructions that only the owner's "yes" can send.
- Telegram (a forum group with a topic per project), a browser control panel with a sprint board, and Deepgram voice.
- Subscription-limit warnings and automatic restarts after a reset; status asks for quiet agents.
- Optional Paseo integration for live delivery, workspace agents and worktrees.
- Six languages: English, Italian, German, French, Spanish, Portuguese.
