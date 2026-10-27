# Munder Difflin: what to take, what not to, and where Leftoff stays different

*2026-10-27 · asked by the owner through the operational PM · written by `luca`*

[HarnessMD/munder-difflin](https://github.com/HarnessMD/munder-difflin) (MIT, about 9,100 stars and 1,270 forks,
version 0.5.6, pushed to daily) is a desktop app — Electron, React, Pixi.js, xterm.js, node-pty — that runs an office
of terminal coding agents as avatars on a 2D floor, coordinated by an orchestrator agent («Michael», the GOD agent),
with memory, mailboxes, a task board and budgets. It is the closest product to Leftoff we know of.

This assessment comes from reading its README and a few source files through GitHub's API. Nothing was cloned, installed
or run; the repository's text was treated as untrusted input. What the README says about features is taken as their
claim, not as verified behaviour. It is open core: a paid «Pro» tier ($150 a year after a free launch period) adds
Capabilities, agent files, the Stapler (dictation, meetings) and a new sidebar; which of those are in the MIT source
was not checked.

## What they do better, and is worth taking

| Their feature | What Leftoff has today | Worth it? |
|---|---|---|
| **Circuit breaker**: a steer → constrain → stop ladder for an agent that loops (the same tool call 8 times), storms API errors (5), burns tokens too fast, or makes no progress (no file changed). One level per beat, back down a level per healthy beat, the hard stop off by default. The policy is a pure module (`src/main/breaker.ts`) with no side effects. | D-065 says when an agent *stopped* waiting, or ended on an error. Nothing sees an agent that *keeps going* in a loop, spending the subscription or the CI. | **Yes**, adapted to our rules (below): it is the case D-065 does not cover, and the one that costs money. |
| **Per-agent budgets from real cost**: usage read from each transcript, token limits per agent and for the whole office, per 5 hours, day, week or month. They count an agent's *work* tokens without cache reads, which grow with the request count rather than with the work (their issue #189). | Each report carries the turn's cost and tokens from the transcript (`src/core/transcript.ts`); the panel sums cost per project; limits are per account (D-060). No budget per agent, no warning before a period's share runs out. | **Yes**: the data is already there; a budget and an 80 % warning are small. Their lesson on cache reads applies to us as it is. |
| **Tickets with keys** (`V53-299`): a key per card, a Tasks tab per agent. | Backlog.md tasks already have ids (`TASK-120`), but the same id exists in every project, so «TASK-120» in chat is ambiguous across projects. | **Small**: a project prefix where tasks are named in chat and in the panel. Not a priority. |
| **Prerequisites page**: one Settings page listing the tools (git, Node, each CLI…) with what each is for and a button to install what is missing. | `leftoff hosts doctor` and `leftoff pm doctor` on the command line; nothing in the panel. | **Yes**, without the install button: a page that says what works (Paseo, hooks per host, `gh`, Telegram, the PM's key, MCP, the VPN address) and how to fix what does not. It matters for people other than the owner who install Leftoff. |
| **Hire links** (`munderdifflin://hire`): a role shared as a manifest; importing only pre-fills the form, a human still starts the agent; the fetch is guarded against SSRF. | The «New agent» form with role ideas (D-040, D-056). | **Later**: useful when other people share roles; not for one owner. Their «pre-fill, never start» rule is the right one if we do it. |
| **More than one office in separate windows.** | A web panel showing every project's room in one building; one URL per project. | **No**: a desktop-window feature. Our equivalent exists. |
| **Slack and webhooks in**: a message in a channel or a POST spawns a short-lived worker that answers in the thread. | Telegram and the panel; signed webhooks *out* (D-061); MCP for other assistants. | **Not now**: only if the owner uses Slack. Inbound webhooks from GitHub (a red CI, a merged PR) could feed the PM later. |
| **A CI watcher** in their Command Center. | The PM watches push cadence from git_log and reports (D-066). | **Yes, with budgets**: GitHub's own numbers (runs and minutes per repository) are better evidence for D-066 than commit counts. |

Two smaller things they learned the hard way, which we checked against our code:

- Claude Code changed how it names a project's transcript folder (every non-alphanumeric character to a dash), and their
  reader silently found nothing for months. Leftoff takes the transcript path from the hook's payload
  (`transcript_path`) and never builds that name, so it is not exposed to this.
- Edits to a hand-written task file must keep the fields the writer does not know (`src/shared/taskLedger.ts`). Our
  Backlog.md edits already rewrite only the keys they change (`updateTask`), and a test covers it.

## What runs opposite to our rules, and is not to be taken

- **The orchestrator decides what needs the human.** Their GOD agent «resolves routine requests itself (keeping the
  system fully autonomous), and only escalates critical items». In Leftoff a project is in control mode unless the
  owner made it autonomous (D-041), the owner's «sì» is matched by code against a fixed list or is a tap on an agent's
  own option (D-063), and what looks irreversible, or is the PM's own idea, always waits. A model's judgment of what is
  «critical» is not a gate.
- **Driving the CLIs in pseudo-terminals on the owner's subscription.** They wrap each CLI in node-pty, with «your
  existing subscription and its hourly limits», install it and sign in from inside the app, in a product with a paid
  tier. That is what D-064 rejected for Leftoff: Anthropic's terms do not allow a third-party product to offer
  claude.ai login or a subscription's rate limits without approval. Leftoff does not run agents; Paseo does, and
  Leftoff only sends them messages. None of the PTY, CLI-install or in-app sign-in code is for us.
- **Typing into any agent's terminal, and an IDE, from the UI.** A large surface, against our panel's role: approvals,
  reading and settings, never a remote shell.
- **A marketplace that installs MCP servers, skills and plugins** (their «Capabilities», 2,347 entries, 622 reviewed).
  A supply-chain risk on the machine that holds every project's agents.
- **Usage telemetry**, even anonymous and opt-out. Leftoff sends nothing about its user anywhere, and should keep not to.
- **A shared semantic memory fed by agents' output.** Text an agent wrote is untrusted (our rule); a store that agents
  read back as knowledge turns one bad output into everyone's instruction. Our memory is the reports and decisions in
  each repository, read as data.

## Code: what the licence allows, and what is worth studying

The source code is MIT; MIT code can be included in Apache-2.0 Leftoff as long as its copyright notice and licence
text go with it (a `NOTICE`/third-party section and a header on any file that keeps their code). **The pixel art is
not MIT**: the tilesets and maps are LimeZu's *Modern Interiors*, under a paid licence that requires credit
(`LICENSE-ASSETS`). None of it may be copied; our office is drawn from code and must stay so.

Most of the code is tied to Electron and their hive; what is worth reading, to reimplement in our style rather than
copy:

- `src/main/breaker.ts` — the breaker's policy: velocity as the difference of cumulative samples, a grace window
  around compaction so its burst is not read as a runaway, «a distinct tool call in the last five minutes is
  progress», two tripping beats before the no-progress arm fires, one level per beat and recovery.
- `src/main/transcript.ts`, `src/main/costLifetime.ts`, `src/main/pricing.ts` — per-agent usage over time from
  transcripts, and what counts toward a budget.
- `src/main/hire.ts` with `src/shared/hire.ts` — a manifest fetched safely (address checks after DNS resolution), if
  shareable roles ever come.

## Where Leftoff stays different

- **The record lives in the repositories.** Reports, decisions and the backlog are files in each project, committed
  with the work; any agent on any host writes them through hooks; nothing depends on our app being open.
- **The PM is on the phone.** Telegram with voice, buttons and pictures of the office; the panel is a browser page.
  They are a desktop app you watch.
- **No app to install, no agent to wrap.** Leftoff runs headless on a home server; Paseo runs the agents; Leftoff
  never touches a login and never types into a session.
- **The owner's yes is code, and autonomy is the owner's choice per project** (D-041, D-063).
- **Fully open, Apache-2.0, no paid tier, no telemetry.**
- **Other assistants can use it**: MCP over stdio and HTTP, events with a cursor, signed webhooks (D-061).

## The three ideas with the best value for the effort

Each is written as a decision the owner can take.

1. **A loop and runaway guard (a circuit breaker, our way).** From what the hooks and the transcript tail already
   give (D-043, D-065): the same step repeated many times, a storm of API errors, tokens spent much faster than usual,
   or no change in the workspace for a long while during a running turn. It warns the owner in the project's thread
   and offers a draft for the agent («stop, report where you are»), sent on the «sì» or by itself in an autonomous
   project; it never kills a session. One warning per episode, back to quiet when the agent recovers.
   *Effort: about a day and a half. Value: it catches the case that spends money unseen.*
2. **Budgets: tokens per agent per period, CI minutes per repository.** A budget per agent (per day or week, work
   tokens without cache reads) and per project, warned at 80 % and at 100 % in the thread; and the PM's push-cadence
   duty (D-066) fed by GitHub's own run and minute counts per repository, shown in the panel next to the project's cost.
   *Effort: about a day. Value: it turns this month's surprise (D-066) into a warning before it happens.*
3. **A prerequisites page in the panel** (and `leftoff doctor` on the command line): Paseo and its daemon, the hooks of
   each host and account, `gh` signed in, the Telegram bot, the PM's key, MCP and the webhook, the VPN address — each
   green or red, with the one command or setting that fixes it. No install button.
   *Effort: half a day to a day. Value: the first hour of anyone else who installs Leftoff, and fewer «why is nothing
   arriving» moments for the owner.*
