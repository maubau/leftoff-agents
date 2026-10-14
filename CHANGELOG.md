# Changelog

## Unreleased

- The Home has a «+ New project» button next to the «Projects» title, so it is found on a phone without scrolling past every room; it opens the same form under the title. The empty plot at the end stays. Escape closes the form.
- Fix: an agent added from Leftoff started in Paseo's «Always ask» mode, so every command waited for a permission nobody saw. It now starts in its provider's own default mode (`--mode`, from `paseo provider ls`), like an agent started in Paseo's app (D-040).
- New projects: `projects.git` (name and email) gives the new repository its own git identity before its first commit, for a machine with no global one; a creation stopped at `git_identity` finishes on Retry once it is set (D-056).
- New projects from the panel (D-056): an empty pixel-art plot at the end of the Home opens a form (name, what it is for), checked as it is typed; a progress card follows the five steps live, with Retry from a failed step and «Leave it as it is» (nothing deleted); creations started elsewhere show at the top of the Home; the new project opens on its dark room with the New agent form and four role ideas. The demo makes real projects in its temporary directory (`--paseo-down` to see Retry).
- The panel's chat shows a PM message's buttons (Yes/No, an agent's options) under the last one of each thread, until the owner writes there; a tap says it in that thread. A reply given in Telegram keeps its buttons there, where its «yes» waits. In «Needs you», an option's chip sends «<agent>: <option>» at once, as Telegram's button does.
- Agents from chat (D-056): «Add an agent» under a project made in chat, or `/newagent [project]` (`/nuovoagente`, `/neueragent`, `/nouvelagent`, `/nuevoagente`, `/novoagente`), asks the role (the panel's presets as buttons, or written), the name and the program, each with Cancel, then shows a summary; only the owner's yes adds it, made by the panel's own code. Model, thinking level and first task stay in the panel.
- The PM asks the team instead of guessing (D-058): with `ask_team` it puts one question to the agent whose role covers it. The question is read-only and needs no approval, and it counts towards the project's daily ceiling. The agent's answer reaches the owner by itself.
- An agent's question with options reaches chat with a button per option (its recommendation starred): a tap says «<agent>: <option>», so nothing is retyped and the PM knows whose question it answers. Long options work too (Telegram keeps the reply, the button carries a key), and the panel's conversation keeps the buttons a message came with.
- New projects from chat (D-056): `/newproject <name>` (`/nuovoprogetto`, `/neuesprojekt`, `/nouveauprojet`, `/nuevoproyecto`, `/novoprojeto`), or ask the PM. What will be made is shown with Yes/No, and only the owner's yes makes it, in every mode; never an idea of the PM's own, never two things waiting for one «sì» in a thread. The end is told in the thread, with Retry if a step stopped.
- New projects from the panel, backend (D-056): name it, and Leftoff makes the folder under `projects.root`, the git repository, the Leftoff project with its first commit, the registry entry and the Paseo project, one step at a time, followed live; a stopped creation resumes from its failed step, and nothing is deleted. Each room's theme is decided once and kept, so a new project never refurnishes the others.
- The ceiling on instructions (`commands.maxPerDay`) is per project: a team going round in circles in one autonomous project no longer silences the others. In an autonomous project, past `commands.autoHandoffsPerHour` (20) handoffs passed on by themselves in an hour, the next wait for the owner's yes and say why (D-057).
- `paseo ls` (about a second of CPU each) runs one at a time, shared by whoever asks meanwhile, and between passes only when a hook says a queued agent's turn ended: a minute with a full queue went from 5 runs to 1. Deliveries still go out only on a `paseo ls` started after they asked (D-055).
- The hub no longer spends most of every minute in git: each commit is classified once and remembered (a project with 29 worktrees went from about 3,900 git calls a pass to a few dozen); the watcher no longer runs `git status`; Leftoff's git reads never take a worktree's index lock (`GIT_OPTIONAL_LOCKS=0`), so an agent's commit cannot fail on it.
- Fix: the PM answered «there is a problem with the model» to everything — with the plan tools it had 21 strict tools, one more than Anthropic's API accepts. Read-only tools are no longer strict, and past 20 the rest go without it instead of failing.
- Teams: agents have roles (`leftoff agents role`, or tell the PM), and every agent hears its team at session start.
- Handoffs: `leftoff report --handoff "<teammate>: <ask>"`; the owner approves each one in the project's thread, the
  PM passes it on, and the teammate's answer comes back (D-036).
- The office: a pixel-art view of each project's team in the panel, and `/office` in Telegram (D-037).
- The office reacts: the PM sits up (at its screen, or with a phone for Telegram) when the owner writes, and an agent walks over to it when spoken to (D-038).
- The office in the panel prints each agent's name and role under its desk (long roles end in an ellipsis, the whole text in a tooltip).
- The Home is a row of rooms, one per project, each furnished differently (eight themes), with one name on its sign and one description on its board, all in pixels; a project's own page keeps the layered view (D-045, D-044).
- The office is redrawn at twice the detail in a new style of our own: big-headed people, desks with keyboard and monitor, bevelled tiles, a panelled wall, richer furniture (D-046).
- Rooms are furnished along the floor and around the desks (cabinets, water cooler, copier, vending machine, sofas, bookshelves…), a different set for each theme; no more red-and-white floor (D-047).
- Pictures stay put under the mouse (no pointer parallax, no hover that moves); every room has a light back wall; under a desk only the agent's role, short and small, with no grey label (D-048).
- The panel shows the PM's spend as a figure for the month ("$3.17 this month"), with no cap beside it: the cap is not a balance.
- A project's page shows its macro plan: phases side by side, each task with its owner and what it waits on, proposals dashed; the board's cards carry phase, proposed and "opened by Leftoff" (D-053).
- The panel has an Activity board per project, apart from the chat: every step between the PM and the agents, filterable by kind and agent, live; the chat's grouped-notices summary links to it (D-054).
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
- The panel accepts messages to the PM up to 40,000 characters (was 4,000), so a brief or a log can be pasted whole.
- The PM has a standing profile: in each conversation it gets every team's agents with their roles, reads each agent's profile to decide who takes a request, gives more weight on technical choices to the agent whose role makes it the architect, and asks one question at most when it cannot tell (D-049).
- An instruction for an agent whose Paseo session is closed now says it is waiting, not sent, and goes out by itself as soon as the session is active again (D-050).
- Plans before development: the PM asks each agent for its part, the agents write it as backlog tasks (`leftoff plan add`, phases and dependencies), the PM consolidates it and the owner approves it once; every instruction then shows on the board as a task, opened automatically when it had none (D-051).
- Two channels: chat — Telegram and the panel's conversation — has what needs the owner, their answers and the closures
  of work; every step between the PM and the agents (handoffs passed on, deliveries, progress, their answers to each
  other) goes to an activity register, `GET /api/activity` and the SSE event `activity`. Past six messages in ten
  minutes, a thread's messages go out as one summary (`notify.burst`) (D-052).

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
