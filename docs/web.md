# The control panel

A browser view of the same facts the PM reads, plus a chat with the PM. Served by the hub
(`leftoff hub`), not a separate process: it needs the hub's state (drafts, mutes, awaited
answers) and the hub's way of talking to the PM.

## How it is wired

```
Telegram ⇄ MirrorChannel ⇄ Hub          (src/channels/mirror.ts)
              │  records every line
              ▼
        feed.jsonl  ← Feed (src/web/feed.ts)  → SSE → browser
Browser → POST /api/chat → MirrorChannel.fromWeb() → Hub.handle()  (thread key `web-<project>`)
Browser ← GET /api/overview, /api/projects/:id   (src/web/data.ts, board.ts)
```

`MirrorChannel` decorates the real channel, so `hub.ts` is unchanged. It records what the hub
sends on its own (`push`), what the owner writes in Telegram, and the PM's answers. A message
typed in the browser reaches the hub through `Hub.handle()` exactly like a Telegram one; its
answers go to the browser only, never to Telegram. The «sì» rule for instructions to agents is
the hub's (D-022), so the panel cannot weaken it: the *Sì, invia* button just sends «sì» in
that thread.

## The office

`office.js` draws each project's office (D-037): the PM's desk, one desk per agent with the colour of its
role, a lit screen while Paseo says it is running, a bubble for blocked / needs you / awaiting / finished /
idle, the sprint on the whiteboard, and every handoff as a sheet going from the asker via the PM to the
teammate. The project page shows it large with a legend and the handoffs waiting; each project card shows a
small one. It is animated at about eight frames a second and still for `prefers-reduced-motion`. The same file
renders the PNG the hub sends for `/office`.

## New projects

The Home ends with an empty plot (D-056), and the «Projects» title has a «+ New project» button (on a phone the plot is screens away): either opens the same form, in the plot's place or under the title; Escape closes it, the name is checked as it is typed
(`POST /api/projects/check`), and *Create* turns the form into a progress card with the five steps, moved by the SSE
event `project`. Done, the project's page opens: its dark room and the *New agent* form with four role ideas, one agent
after the other. A creation that stopped shows its step, the reason in the owner's words, **Retry** (only the failed
step) and **Leave it as it is** (remembered in this browser; nothing is deleted). Creations started elsewhere — another
browser, chat — show as the same card at the top of the Home until they finish. The rules of these cards are in
`jobs.js`, tested in node. The flow and the API are in [new-project-flow.md](new-project-flow.md); the demo makes real
folders and git repositories in its temporary directory (`npm run demo -- --paseo-down` stops the first one at Paseo).

## Buttons from chat

A PM message that came with buttons in chat (Yes/No, an agent's options) shows them in the panel too, under the last
such message of each thread until the owner writes there; a tap sends the reply in that thread. A reply given in
Telegram keeps its buttons only there: what waits for its «sì» is kept under Telegram's thread key, which a «yes» from
the panel's `web-…` thread would not reach. In *Needs you*, an option's chip sends «<agent>: <option>» at once, as
Telegram's button does. The rules are in `choices.js`.

## A newer panel (#134)

The hub says the panel's version (a hash of its files) on every SSE connection (`version`) and on every API answer
(`x-leftoff-panel`). The page keeps the first it sees; a different one later puts a band at the top, «There is a new
version of the panel», with **Reload**. Before reloading, what is typed and not sent — the PM's box and the open task's —
goes to this tab's `sessionStorage` (`leftoff_reload_drafts`, ten minutes, same page only) and is put back after; the
band says so when there is any. Rules in `panelversion.js`.

## Your tasks (D-070)

A page of its own, `#/tasks` (`#/tasks/OWN-7`, `?project=<id>` to show one project's), reached from the header's
**📌 Your tasks** with its count (red with an urgent task) and, on a phone, from a third tab. The Home and each project's
page show only the count and the first three, each opening its chat, with a link to all.

- **Two columns.** On the left a compact list, urgent first, then oldest, with a project filter, «+ Task» and who helps
  with the chosen project's tasks. On the right the chosen task: its head (where it came from, details with Copy,
  **Done**, **Drop it** asked twice, who helps) and its chat at full height, with a box that grows with the text. The
  PM's chat steps aside on this page. On a phone: the list, then the chat on a page of its own, with a way back.
- **Nothing moves under the owner.** The page is built once and changed in place: the list keeps its scroll, the box
  its text and focus, and the chat goes to the bottom for a new line only if the owner was already there.
- **Images** (D-071): pasted, dropped on the chat, or picked with 📎; PNG, JPEG, WebP or GIF up to 20 MB. Each is sent
  at once and shown as a chip with a preview; the line carries their ids. A 409 on sending (the key check) offers
  «Send anyway».
- **Long text** (D-071): the box takes up to 80,000 characters; past 3,500 it says, with the count, that the text will
  become a Markdown attachment with a preview (the hub does it); at 80,000, that it takes no more.
- **Whoever helps** is shown at work («Andrea is working…») or awaited («Waiting for an answer from …»).
- **Closed and duplicates.** «Open | Closed» above the list: a closed task (last 90 days) shows its chat to read and
  **Reopen**. An open task's likely duplicates (`similar`) are marked beside its title, «≈ OWN-38», leading to them;
  **Merge into…** offers them first, then the project's other open tasks, and goes on to the task it became. A merge the
  hub refuses (409) says why.

- **Blocks the team** (`task.blocking`): «⛔ Blocks the team», solid red with its words, first in every order above
  the urgent ones (a group of its own by project), counted in the header's red number; a switch in the task's head
  (`POST /api/owner-tasks/:id/blocking {on}`).
- **Order**, kept in this browser (`leftoff_tasks_order`): *Newest* (the default), *Oldest* or *By project*; urgent
  tasks always first. By project, the urgent ones come first together, each with its project's label, then one group
  per project under its label. The list asks the hub for it (`?sort=`) and sorts the same way itself, so live changes
  land in place.
- **A colour per project** (`projectcolor.js`): a label with the project's name on its tint, in the list, the project
  menu (the labels themselves), the task's head and the Home's summary. It follows the room's theme (D-056), so two
  projects do not share one while there are tints enough; without a theme it comes from the id. Ten tints, none red
  (red is «Urgent»), all at 5:1 or more in light and dark (checked by `test/project-color.test.ts`).

The rules are in `ownertasks.js`, tested in node. A hub without the endpoints (404) shows none of it.

The panel expects (phase 2, server by Luca):

- `GET /api/owner-tasks?status=open` → `{tasks}`, ordered as `ordered()` does (urgent first, then oldest), each an
  `OwnerTask` (`id, project, title, detail, sources, urgent, helper?, status, createdAt`).
- `POST /api/owner-tasks/:id/done` and `/drop` with `{}` → `{task}` (closed).
- `GET /api/owner-tasks/:id/chat` → `{entries: [{id, at, role: "owner" | "helper", agent?, text}]}`; `POST` the same
  path with `{text}` → `202 {entry}`.
- SSE `owner-task` `{task}` at every change (new, moved up, closed by an agent's check or from chat) and
  `owner-task-chat` `{taskId, entry}` for each line of a task's chat; `typing` on the thread `task:<id>` while the
  helper answers.
- Who helps: each task carries `helperNow {id, name, why}`; `POST /api/owner-tasks/:id/helper {helper | null}` chooses
  for one task, `GET`/`POST /api/settings/projects/:id/task-helper` for the project (`{current, candidates}`).
- «+ Task» on the tasks page: `POST /api/owner-tasks {project, title, detail?, urgent?}` → `{task, created}`; the
  same words as an open task (`created: false`) move that one up, and the panel says so.
- Images: `PUT /api/owner-tasks/:id/files?name=<name>` with the raw bytes and `x-leftoff-upload: 1` → `{file}`; then
  `POST …/chat {text, files: [id], anyway?}`; lines carry `files: [{id, name, type, size}]`, shown from
  `GET /api/files/<project>/<id>`.
- `task.helperState {state: "working" | "waiting" | "idle", since}`.
- `POST /api/owner-tasks/:id/reopen` → `{task}`; `POST /api/owner-tasks/:id/merge {into}` → `{task}` (the one it
  became) or 409 with why; open tasks carry `similar: [id]`; closed ones come from `GET /api/owner-tasks?status=all`.

## The board

`buildBoard()` derives four columns per project:

| Column | From |
|---|---|
| To do | Backlog.md "To Do", and each agent's latest report `next` |
| Doing | Backlog.md "In Progress", and each agent's latest report `doing` |
| Blocked | each agent's latest report `blocked` and `question` |
| Done | Backlog.md "Done", and `done` items of reports in the last 7 days |

An item finished in a later report leaves the open columns; Backlog.md wins over an agent's
own wording of the same task. A "doing" card whose report is over 6 hours old and whose agent
is not running is dimmed.

## API (read-only except chat and settings)

`GET /api/overview` · `GET /api/projects/:id` · `GET /api/feed?project=<id|general>&limit&before`
· `GET /api/activity?project=<id>&agent=<id>&limit&before` · `GET /api/events` (SSE: `feed`, `activity`, `typing`,
`refresh`, `contact`, `project`, `owner-task`, `owner-task-chat`) · `POST /api/chat {project, text}` (`text` up to 40,000 characters; a request body up to 256 KB).

The feed is the conversation; the activity register (D-052) is apart: every step between the PM and the agents, the
newest 200 by default (up to 500), oldest first as in the feed; each entry a feed entry with `activity: {type, agent?, to?}`. `type` is
`instruction` (an instruction or a plan request sent), `handoff` (passed on or approved; `agent` asked, `to` received),
`delivered` (a message that waited went out), `status` (a status ask), `reply` (an agent's answer to an instruction, a
teammate or the PM), `report` (any other report, progress included), `task` (a task moved), `expired` (a handoff nobody
approved), `commits` (commits nobody reported). `agent=` keeps the steps where the agent is `agent` or `to`. The SSE
event `activity` carries new entries; they are never sent as `feed`.

Each project carries `plan` (D-051): `{id, goal, status: "collecting" | "shown" | "approved", askedAt, asked, missing,
phases: [{name, tasks: [{id, title, agent, status, dependsOn, proposed}]}]}`, or null. Board cards from the backlog
carry `phase`, `dependsOn`, `proposed` (a plan task not yet approved) and `auto` (opened by Leftoff for an instruction or
a handoff that had no task) — what the plan view of TASK-6 shows.

Each agent in `/api/overview` and `/api/projects/:id` carries `now` — `{request, since, step, stepAt, ended}`, what it is
on between reports (D-043), or null — and `queued`, the number of messages waiting for its turn to end (D-042). While
it works, its `summary` is `step · «request»`.

`contact` is `{project, agent, kind}`, sent when the PM has just written to an agent: `status` (a status ask),
`command` (an approved instruction or a restart) or `handoff` (a teammate's request, as approved). Never for a
private project.

Settings (D-039), writes with the same rules as chat (the panel's own page, JSON, the password):

- `GET /api/settings/pm` → `{provider, model, effort, models: [{id, label}], efforts}`; `POST` the same path with
  `{model?, effort?}`. `models` is empty for an OpenAI-compatible PM, whose model stays in `config.yaml` (409).
- `GET /api/settings/projects/:id/agents` → `{agents: [{id, label, reachable, reason?, provider, model, thinking,
  models: [{id, label, thinking: [ids], defaultThinking}], canSetModel, canSetThinking}]}`; `POST
  /api/settings/projects/:id/agents/:agent` with `{model?, thinking?}` → `{agent, notices}`. `canSetModel` is false
  until Paseo's command line can switch a running agent's model (409 meanwhile); thinking ids are Paseo's own.
- `GET /api/settings/projects/:id/new-agent` → `{providers: [{id, label, host, models}]}` (enabled, available
  Claude Code and Codex providers); `POST` the same path with `{name, role?, provider, model?, thinking?, task?}` →
  201 `{agent}` (D-040). Paseo makes a worktree workspace titled `name` and starts the agent in it; a failure to
  start archives that workspace (502, with Paseo's reason).
- `POST /api/settings/projects/:id/mode` with `{mode: "control" | "autonomous"}` → `{mode}` (D-041): applies at once
  and is said in the project's thread. Each project in `/api/overview` and `/api/projects/:id` carries its `mode`.
- `POST /api/settings/projects/:id/agents/:agent/profile` with `{name?, role?}` → `{id, label, role}`. A workspace
  agent's Paseo workspace is renamed too; an empty role removes it.

«Your tasks» (D-070, phase 2), with the same rules for writes. Never a private project's task:

- `GET /api/owner-tasks?project=<id>&status=open|done|dropped|all&sort=newest|oldest|project` (open and oldest by
  default; the panel's order selector asks for the order it shows) → `{tasks}`, urgent first always, then the newest, the oldest, or by project (newest first within each). Each task is `{id, project, projectName, title, detail, sources, urgent, helper?, status, createdAt,
  updatedAt, closedAt?, closedBy?, questionOf?, helperNow: {id, name, why: "task" | "project" | "default"}, chatCount}`.
- `POST /api/owner-tasks` with `{project, title, detail?, urgent?}` → 201 `{task, created: true}`, or 200 with the
  open task it already is.
- `GET /api/owner-tasks/:id` → `{task}`. `GET /api/owner-tasks/:id/chat` → `{entries: [{id, at, role: "owner" |
  "helper", agent?, text}]}`, oldest first. A helper's `agent` is `pm`, an agent's id (`<project>/<agent>` from
  another project), or `leftoff` for a note such as «the helper cannot be reached».
- `POST /api/owner-tasks/:id/done` and `/drop` → `{task}`; 404 when it is not open.
- `POST /api/owner-tasks/:id/reopen` with `{}` → `{task}`, open again; 404 when it is not closed.
- `POST /api/owner-tasks/:id/blocking` with `{on: true | false}` → `{task}`: «Blocks the team». Tasks carry
  `blocking: true` when the team waits for them — born from a blocked or waiting agent, a question, or flagged by the
  operational PM — and come first in every order, above urgent ones; count them in the header's red.
- `POST /api/owner-tasks/:id/merge` with `{into: "OWN-n"}` → `{task}`, the one it went into; 409 when it cannot (not
  open, another project). Each open task in the list and in `GET …/:id` carries `similar: [ids]`, the open tasks of its
  project that look like it, most alike first: offer «Merge into…» for those.
- `POST /api/owner-tasks/:id/chat` with `{text}` (up to 80,000 characters; beyond 3,500 the text becomes a Markdown file of the task, checked for keys like any other, and the line shows its first lines and says so — never cut) → 202 `{entry}`, the owner's line. The words go to the task's
  helper: an agent gets them in a fixed frame and answers with `leftoff pm say --task OWN-n "…"`; the PM answers at
  once, with its read tools only. A closed Paseo session is reopened by the words (D-074); a helper Paseo does not list is said in the chat, and the PM answers.
  `typing` is sent with `project: "task:OWN-n"` while the words travel.
- `POST /api/owner-tasks/:id/helper` with `{helper}` → `{task}`: one of the project's candidates, or null for the
  project's.
- `GET /api/settings/projects/:id/task-helper` → `{current: {id, name, why}, default: {id, name}, candidates: [{id, name}]}` (`default` is who helps when nothing is chosen); `POST` with
  `{helper}` (a candidate id, or null for the default) writes `pm.tasks.helpers` in `config.yaml`. Candidates are
  `pm`, the project's agents, and the operational PM when it is in another project. The default is the operational PM,
  else the PM.

- `PUT /api/owner-tasks/:id/files?name=<file name>` with the file's bytes as the body and the header
  `x-leftoff-upload: 1` (a form or another site cannot send it) → 201 `{file}`: its facts (`id, name, type, size, at,
  keyFound, …`), never its path. Refused with 413 (over 20 MB, or the project's 200 MB this month) or 415 (a type phase
  1 does not take, or first bytes that are not what the name says) (D-071).
- `POST /api/owner-tasks/:id/chat` also takes `files: [id]` (up to 10, only files added to that task) and `anyway`;
  `text` may be empty when there are files. A text file that looks like it holds a key answers 409 `{keyIn: [names]}`:
  ask «send it anyway?» and send again with `anyway: true`. An agent helper gets each file by its path; the PM is told
  their names and that it cannot open them. Chat lines carry `files: [{id, name, type, size}]`.
- `GET /api/files/:project/:id` → the file: an image `inline`, anything else as a download, with `nosniff` and a
  `sandbox` CSP so nothing in it runs. `GET /api/files?project=<id>` → `{files}`, newest first, facts only.
- Each task in the list and in `GET /api/owner-tasks/:id` carries `helperState: {state: "working" | "waiting" | "idle",
  since?}`: waiting while the owner's last words have no answer, working while the helper's Paseo session runs. It is
  not in the SSE events: read the task again while waiting (every 15 s is plenty).

SSE: `owner-task` `{task}` at every change of a task, wherever it came from (born from a report, moved up, closed
from chat, from the panel or by an agent's check, its helper changed), and `owner-task-chat` `{taskId, entry}` for
each line of its chat. Never a private project's.

## Security

- Loopback only by default. Any other `web.host` requires `LEFTOFF_WEB_TOKEN`; the hub logs why
  and keeps running without the panel otherwise. The token is checked in constant time, from a
  `HttpOnly; SameSite=Strict` cookie or a Bearer header.
- A `Host` header that is not loopback is refused (DNS rebinding); a cross-origin POST is
  refused; JSON only; bodies over 64 KB are refused.
- Private projects are filtered on every read, including old feed lines.
- Everything in the feed is redacted again before it is stored.
- The page builds its DOM with `textContent`: report text can never become markup.

## Config

```yaml
web: { enabled: true, host: 127.0.0.1, port: 4777 }
```

## Not done (on purpose)

No login screen (a token link is enough for one owner), no editing of tasks (the PM and the
agents own the plan), no WhatsApp mirror yet (it is another `Channel`; wrap it the same way).
