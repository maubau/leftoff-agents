# New project: the flow, for the panel and for chat

What the owner sees and does when they create a project from Leftoff (TASK-20 of plan `20261012-k0we`), and what the
panel needs from the API. The backend's own decision (architecture, jobs, Paseo) is main-dev's and the architect's; this is the
user's side. It is a specification, not code: nothing here is built until it is approved.

## The owner's journey, in one line

*I give a name → Leftoff makes the folder, the repository and the project, on Paseo too → I see it as a dark room → I add
the agents it needs.*

## 1. In the panel

### Starting

- The Home ends with an **empty plot**, a pixel-art tile in the style of the rooms, with a "+" and **New project**. With no
  project at all the Home is that tile alone, with one sentence: *"Nothing here yet. Name your first project."*
- A click opens the form **in place of the tile** (no dialog: on a phone a dialog covers the thing you are doing). Focus goes
  to the name field; Escape or *Cancel* puts the tile back.

### The form

| Field | Rule |
|---|---|
| **Name** (required) | Anything a person would write ("Orchard Club"). The server decides what is valid (`GET /api/projects/options` → `nameMax`) and derives the **folder and id** from it; the panel never reimplements the rules. |
| **What it is for** (optional) | One short line (up to 200 characters). It becomes the project's purpose: the description on the room's notice board on the Home. |

- Under the name, a **live line** (checked as the owner types, after a pause of 300 ms, with `POST /api/projects/check`):
  *"It will be created in `<folder>`"* when valid, or the reason when not (below). The *Create* button is enabled only when
  the check says ok.
- No theme picker in the first version: Leftoff gives the room the first free theme (the server's choice, saved), and the
  owner sees it as soon as the room exists.
- **Paseo is not answering** (`options.paseo = "unavailable"`): a notice above the button, *"Paseo does not answer now. The
  folder and the project will be created; the Paseo step waits for **Retry**."* Creating is still allowed.
- No `private` option here: private projects never reach the panel (see docs/security.md), so a project made private
  would vanish from the screen it was made on. It stays a command-line option.

### While it is being made

The form becomes a **progress card**, in the same place, with one line per step. The steps are the job's: *Folder · Git
repository · Leftoff project · Registry · Paseo*.

| Mark | State |
|---|---|
| ○ | waiting |
| ◐ (turning, or still with reduced motion) | running |
| ✔ | done |
| ✖ | failed, with the message under it |

- **Done:** *"Project created"* and the card opens the project page by itself after a moment (the owner is looking at it);
  the *Open the project* button is there for who would rather click, and takes focus.
- **A step failed:** the message in the owner's language (table below), a **Retry** button (it resumes from the failed step,
  it never redoes what worked) and **Leave it as it is** (the card closes; what was made stays: the project shows on the
  Home, dark and marked *incomplete*). Nothing is deleted from the panel.
- **Reload, another browser, another origin** (a project started from chat): active and recent jobs come from
  `GET /api/projects/jobs`, and the same progress card is shown at the top of the Home until the job is done (then the new
  room appears by the usual refresh). A job that failed stays there until *Retry* or *Leave it as it is*.
- The job's last 20 and 7 days are the server's; the panel only lists what it is given.

### The new project's page (empty state)

- The page shows the **dark room** (the lights are off until someone works there) and a card: *"Add the first agent"*, with
  the **New agent** form already open (the one that exists: name, role, program, model, first task).
- **Presets** above the form, one click fills name and role: *Backend and architecture · Frontend and UX · Tests and review ·
  Documentation*. They are suggestions, editable; the server does not know them.
- After an agent is created, the room lights up with its desk, and the card says *"Agent added"* with **Add another** and
  **I'm done** (scrolls to the office). It can be done again and again without going back to the Home.
- Until the first agent exists nothing on the page promises what is not there (no empty board with "work in progress").

### Errors in the owner's language

The server sends `{ error: "<english>", type, detail?, step?, reason?, existing? }`; the panel translates by `type`, and the
raw text and Paseo's `detail` are only a tooltip.

| `type` | HTTP | The owner reads |
|---|---|---|
| `invalid_name` / `reason: empty` | 400 | *"Give the project a name."* |
| `invalid_name` / `too_long` | 400 | *"The name is too long (at most N characters)."* |
| `invalid_name` / `bad_chars` | 400 | *"The name has characters a folder cannot have."* |
| `invalid_name` / `reserved` | 400 | *"That name is reserved. Choose another."* |
| `exists` / `kind: project` | 409 | *"A project with that name already exists."* + a link to it |
| `exists` / `kind: folder` | 409 | *"A folder with that name already exists."* |
| `exists` / `kind: paseo` | 409 | *"Paseo already has a project with that name."* |
| `paseo_unavailable` | 503 | *"Paseo does not answer. Retry in a moment."* |
| `paseo_refused` | 502 | *"Paseo refused it."* + the reason as a tooltip |
| anything else | any | *"The project could not be created. Is the hub running?"* |

### Accessibility and phones

Labels on every field; the check line and the steps are `aria-live`; Enter submits; the progress card is not covered by
the keyboard on a phone (it grows downwards, the buttons are full width). With `prefers-reduced-motion` nothing turns.

## 2. In chat (Telegram)

The rule of the PM does not change (D-022 and D-041): **nothing is created without the owner's yes**, in an autonomous
project or not (there is no project yet), and "yes" is matched by code against the fixed list.

### Asking

- A command, `/newproject <name>` (aliases in the six languages like the others: `nuovoprogetto`, `neuesprojekt`,
  `nouveauprojet`, `nuevoproyecto`, `novoprojeto`), or a sentence to the PM ("create a project called Orchard Club"); the
  PM drafts it with its tool, it does not create it.
- The **draft** is a template, not model text (D-016), with **Yes, create / No** buttons:

  > 🆕 New project «Orchard Club»
  > I will create the folder `<path>`, a git repository, the Leftoff project, and register it in Paseo.
  > Reply «yes» to create it, «no» to drop it.

  An invalid or taken name is answered at once with the reason in the same words as the panel (and, for *exists*, the
  project that is there), and nothing is drafted.

### After the yes

- One message *"⏳ Creating «Orchard Club»…"*, edited as the steps go (or, where editing is not possible, one message at
  the end: chat is not a log; the steps are in the panel's board).
- **Done:** *"✅ Project «Orchard Club» created."* with **Add an agent**. (No link to the panel: the hub does not know the
  address the owner's phone reaches it by.)
- **A step failed:** *"⚠️ «Orchard Club» was made up to <step>: <message>"* with **Retry** and **Leave it as it is**.
- The same job is in the panel's list while it runs, and its end is **not** also told in chat if it started in the panel.

### Adding agents (the second step, kept short)

*Add an agent* (or `/newagent [project]`, in a project's topic or naming it; aliases `nuovoagente`, `neueragent`,
`nouvelagent`, `nuevoagente`, `novoagente`) asks at most three things, each with **Cancel**:

1. **Role** — buttons for the presets (backend, frontend, tests, docs) and *Other…* (the owner types it).
2. **Name** — a proposal from the role as a button (*Use «Backend»*), or the owner types one.
3. **Program** — a button per Paseo provider on offer.

Then a **summary with Yes / No** (what, in which project, on which program) and the agent is created by the panel's own
code, on the owner's fixed «yes» only. While the questions are open, what the owner writes is the answer; at the summary,
anything but yes or no goes to the PM as usual. What is clumsy in chat (a model or thinking level to choose, a first task
to write) is not asked: the last message says those are set in the panel.

## 3. The API (the contract, TASK-29; implemented in `src/hub/project-jobs.ts` and `src/web/server.ts`)

Every endpoint is the panel's, behind its password; writes take JSON from the panel's own page only.

| Call | Answer |
|---|---|
| `GET /api/projects/options` | `{ nameMax: 60, root, paseo: "available" \| "unavailable", themes: 8 }` |
| `POST /api/projects/check { name }` | `{ ok: true, id, folder }`, or a refusal (below). Nothing is made. |
| `POST /api/projects { name, purpose? }` | `202 { job }`. Anything else in the body is ignored: **never `private`**, no `theme`. |
| `GET /api/projects/jobs` | `{ jobs }`: the last 20 creations, at most 7 days old, newest first. |
| `GET /api/projects/jobs/:id` | `{ job }`, or 404. |
| `POST /api/projects/jobs/:id/retry` | `{ job }`: resumes from the failed step and never redoes one that worked. |

- **A job:** `{ id, name, projectId, folder, purpose?, origin: "web" | "chat", status: "running" | "done" | "failed", steps, theme?, startedAt, endedAt? }`.
- **Steps:** five, always in this order: `folder`, `repository`, `leftoff`, `registry`, `paseo`. Each is `{ id, status: "pending" | "running" | "done" | "failed", error?: { type, message, detail? }, retryable }`. A step refused with `exists` is not retryable.
- **Refusals:** `{ error, type, reason?, existing?, detail? }`, with these statuses:
  - `invalid_name` (400), with `reason` one of `empty`, `too_long`, `bad_chars`, `reserved` or `no_id`;
  - `exists` (409), with `existing: { kind: "project" | "folder" | "paseo", id? }`;
  - `paseo_unavailable` (503);
  - `paseo_refused` (502), with Paseo's words in `detail`;
  - `git_identity`: the machine's git has no name and email for the first commit;
  - `failed` (500).
- **Live:** the SSE event `project` carries the whole job at every change, whatever started it. A finished job also sends `refresh`. Creations of projects that have since been made private are never listed or sent.
- **On every project** of `overview` and `project`:
  - `theme` (0–7), decided once by the hub and kept in its state. The rooms there today keep the theme they have, and a new project takes one nobody has.
  - `creation: { jobId, status, step }`, only while its creation has not finished.
- **Where the work is done:** the `leftoff` step makes the **first commit**, after `AGENTS.md` and `.leftoff/` exist (D-056). The `paseo` step looks at `paseo workspace ls` before it runs `paseo workspace create --isolation local`.

## 4. Open questions for the owner

1. **Where are folders made?** The proposal is a configurable root (default next to the other projects), shown read-only in
   the form. Should the owner be able to pick a different place per project?
2. **Creating while Paseo is down** is allowed, with the Paseo step waiting for *Retry*. Prefer to refuse instead?
3. **A theme picker** (eight small rooms to choose from) is left out of the first version. Wanted?
