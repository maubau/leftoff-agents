# Decisions

> Design record of Leftoff: where the implementation departs from the original plan, and why.
> "PRD §n" refers to the original product requirements document, which is not published; each entry stands on its own.
> "The owner" is whoever runs the installation; `claude-ui`, `web-dev-claude` and similar are names of AI agents that worked on the code.

Where this implementation departs from PRD v0.5, and why. Per the PRD's own
instruction: when the tools' actual behaviour and the PRD disagree, the tools win
and the disagreement is recorded here.

---

## D-001 — Name: Leftoff Agents

*2026-09-29 · owner · resolves PRD §11.5*

Working name `standup` → **Leftoff Agents**. CLI `leftoff`, npm `leftoff`,
Telegram bot `@YourLeftoffBot`, tagline "Pick up where your AI agents left off."
Per-repo directory is `.leftoff/`, global config `~/.config/leftoff/`.

---

## D-002 — Paseo control uses the CLI, not the SDK

*2026-09-29 · resolves PRD §11.2*

The PRD lists `@getpaseo/client` as the way to detect idle agents and push
follow-ups. The `paseo` CLI already exposes everything M0–M2 needs, with JSON
output: `paseo ls --json` (agents and their state), `inspect`, `logs`, `wait`
(block until idle), `send <id> <prompt>` (push a message), `stop`.

Decision: **use the CLI**. It removes a dependency, it is the surface Paseo
documents for automation, and it keeps the hub usable against a remote daemon via
`--host`. The SDK stays an option if the CLI proves too coarse for idle detection.

Related finding, which the PRD does not mention and which would have silently
broken hook installation: Paseo's `claude-work` provider runs Claude Code with
`CLAUDE_CONFIG_DIR=~/.claude-work`. There are therefore **two**
Claude Code config roots on this machine, and agents started from Paseo — most of
them — read the second one. `leftoff hosts install` enumerates `~/.claude`, any
`CLAUDE_CONFIG_DIR`, and every `env.CLAUDE_CONFIG_DIR` declared by a Paseo
provider, and installs into all of them.

Note: the Paseo daemon was not reachable on `127.0.0.1:6767` from the build
sandbox. Live Paseo integration is verified in M2, not now.

---

## D-003 — Codex has no Stop hook; end of turn goes through `notify`

*2026-09-29 · contradicts PRD §5.2*

PRD §5.2 says "The Claude Code **and Codex** Stop hooks check at end of turn".
That is true of Claude Code and false of Codex.

Verified against codex 0.153.4. Codex's hook events are `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`,
`SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Interrupt` —
configured in `$CODEX_HOME/hooks/hooks.json`, in the same
`{ matcher, hooks: [{ type: "command", command, timeout }] }` shape Claude Code
uses. There is **no per-turn `Stop` event**. Codex's end-of-turn signal is the
legacy `notify` program set in `config.toml`, invoked with a single JSON argument
of type `agent-turn-complete` carrying `thread-id`, `turn-id`, `cwd`, `client`,
`input-messages` and `last-assistant-message`.

The consequence is not cosmetic: `notify` is fire-and-forget. It cannot block the
turn, and it cannot inject context. So Codex cannot be *made* to report the way
Claude Code can. What Leftoff does instead:

1. `notify` detects that the turn changed the project without a report.
2. It queues a reminder in the agent's inbox.
3. The `UserPromptSubmit` hook injects that reminder at the start of the next turn.
4. `AGENTS.md` carries the standing instruction, so the agent usually reports
   unprompted and step 2 never fires.

Practical effect: on Claude Code a report is enforced within the turn; on Codex it
arrives one turn late at worst. The PRD's ≥90% reporting target (§8) is still
reachable, but it rests on the AGENTS.md instruction for Codex, not on a hook.

Also worth knowing: Codex requires the user to trust changed hooks on next start.
`leftoff hosts install` says so rather than pretending the install is complete.

---

## D-004 — `.leftoff/` is committed, except the inbox

*2026-09-29 · owner · resolves PRD §11.3*

Reports, `decisions.md`, `HISTORY.md` and `STATE.md` are versioned with the code:
they are the project's memory, and the PRD's principle 6 only holds if they travel
with the repo. `.leftoff/inbox/` is excluded — it is transient delivery state, it
would conflict on every merge, and it can contain a decision the owner has not yet
acted on.

---

## D-005 — Telegram: one supergroup, one topic per project

*2026-09-29 · owner · resolves PRD §11.4*

Routing is implicit in the thread, so neither the user nor the PM has to guess
which project a message is about. A "Generale" topic carries cross-project
questions. Single-chat-with-prefixes is not implemented.

---

## D-006 — PM brain: one OpenAI-compatible adapter

*2026-09-29 · owner · relates to PRD §11.1*

One adapter speaking the OpenAI chat-completions API covers OpenRouter, a local
Ollama and Anthropic-compatible endpoints, and gives reliable structured tool
calls plus honest per-call cost accounting. A headless coding-agent CLI was
rejected: it cannot report its own cost and it spends the owner's development rate
limits. Which *model* to default to (§11.1) is still open and is an M1 evaluation
against fixture projects.

---

## D-007 — Commits are attributed by sha, not by timestamp

*2026-09-29 · implementation*

Git author dates have second precision; report timestamps have milliseconds and
often a different UTC offset. Deciding "did this commit happen after the last
report?" by comparing ISO strings is wrong twice over — it mis-orders across
offsets, and it drops a commit made in the same second as the report.

Every ordering comparison goes through `src/core/time.ts`, and commit attribution
additionally excludes shas already claimed by an earlier report. A commit
therefore appears in exactly one report, with no boundary guesswork.

---

## D-008 — A broken Leftoff must never break a turn

*2026-09-29 · implementation*

Hooks run inside someone else's turn. Every hook handler catches everything and
exits 0; a repository that has not been `leftoff init`-ed produces no output at
all. The worst failure mode Leftoff allows itself is "no project management",
never "the agent cannot work".

---

## D-009 — Memory lives in the main checkout, work is measured in the worktree

*2026-10-01 · implementation · found on the real machine*

Paseo runs every agent in its own linked worktree under
`~/.paseo/worktrees/<id>/<name>`, on its own branch. On this machine that is the
norm, not the exception: harbor, storefront, clipforge and atlas all had
active worktrees. M0 as first shipped resolved the project from the agent's
working directory, so inside a worktree it found no `.leftoff/` (uncommitted on
main, or absent on the branch) and every hook silently did nothing. Had
`.leftoff/` been committed, reports would have landed on feature branches, out of
sight of `leftoff brief` on main.

Now a `Project` has two roots. `root` is the main checkout, found through
`git rev-parse --git-common-dir`; reports, inbox, decisions and STATE.md always
live there, whichever worktree the agent speaks from. `workRoot` is the agent's
own checkout, where commits and edits are measured. Reports record the `branch`
and, when relevant, the `worktree` they came from, and `brief` shows the branch.

Open consequence: reports written by worktree agents are files in the main
checkout's working tree, so per D-004 someone has to commit them. In M0 that is
the owner; in M1 the hub should do it.

---

## D-010 — Nothing before `leftoff init` is an agent's work

*2026-10-01 · implementation*

`init` edits AGENTS.md and CLAUDE.md. Until committed, those edits looked like
work from the very first agent turn, which was then blocked to report changes
the agent never made. `init` now stamps `initializedAt` (after writing its files)
and `initializedHead` into project.yaml. Dirty files older than the stamp are
ignored; commits already reachable from that HEAD are excluded by ancestry, which
— unlike a timestamp — has no second-precision boundary to get wrong.

---

## D-011 — Read-only turns report too, when they decide or learn something

*2026-10-02 · owner · extends PRD §5.2*

The PRD asks for a report only from turns that change something. Watching a
real clipforge session showed why that is not enough: the first turns were pure
research — competitors, models, ASR pricing — and the discussion that set the
project's new direction. None of it touched a file, so none of it would have
reached Leftoff. The owner's aim is to work with the agents as with a team that
tells him where things stand, what it did and found, and what it needs from
him; findings and decisions are the core of that.

Reports gain `findings` (`--found`) and `decisions` (`--decided`). Agent
decisions are also appended to `decisions.md`, attributed (`— agent`) and linked
to their report, so "come era andata la scelta di…?" has an answer.

On Claude Code, the Stop hook now also asks — once, with an explicit "if there
is nothing worth keeping, just finish" — when a turn changed nothing but was
substantial: it used a research tool (WebSearch, WebFetch, Agent) or made ten or
more tool calls, read from the transcript and excluding sub-agents' own calls.
On Codex there is no transcript to read at turn end, so this rests on the
instructions alone.

---

## D-012 — The protocol is injected at session start, not only written in AGENTS.md

*2026-10-02 · implementation · found on clipforge*

clipforge's first real report showed the agent had never read the AGENTS.md block:
Paseo agents work on their own branch, in their own worktree, where the block
exists only once it is committed and merged. The agent learned the protocol
from the Stop hook's message alone. That is enough on Claude Code; it is not on
Codex, whose end-of-turn reporting relies on the instructions (D-003).

`SessionStart` now injects a short briefing into every session of a managed
project, on any branch. AGENTS.md stays, as the fallback for hosts without hooks.

---

## D-013 — Only the main agent reports, and Leftoff's own commits are nobody's work

*2026-10-02 · implementation*

- `SubagentStop` ran the same check as `Stop`, so a sub-agent launched for
  research would have been told to report the parent's unreported work in the
  parent's name, from a partial view. It is now a no-op and is no longer
  installed (`hosts install` removes it).
- A commit confined to `.leftoff/` or to the protocol block in AGENTS.md /
  CLAUDE.md is the owner — or, from M1, the hub — saving project memory. It is
  excluded from agent activity; otherwise committing reports (D-004) would make
  every agent report on them. Uncommitted protocol-block edits are recognised
  by content too, so refreshing the block with `leftoff init` never nags and no
  longer moves the init baseline.
- `leftoff report` detects the host (`CLAUDECODE`, `CODEX_SANDBOX*`) and records
  `PASEO_AGENT_ID` as `paseoAgent`, in the report and in project.yaml. That is
  the address the PM will need in M2 to ask a specific agent where it stands.

---

## D-014 — The PM follows every activity and asks agents for status on its own

*2026-10-02 · owner · amends PRD §5.3*

"Il PM va a chiederlo da solo perché è proprio il suo lavoro. Deve stare sempre
dietro a tutte le attività, se no non sarebbe un project manager."

The PM is proactive by design: it keeps track of every project and every agent
continuously, and when an agent's status is stale, unclear or overdue it asks
that agent directly (`paseo send` to the `paseoAgent` recorded in its reports,
inbox otherwise), without asking the owner first.

Assumption, to confirm in M2: the autonomy covers *asking* — status, progress,
clarifications. *Directing* — assigning a task, changing scope, answering an
agent's question on the owner's behalf — still comes from the owner, as PRD
§5.3 says. The PM relays decisions; it does not make them.

Cost note: following everything must not mean an LLM call per event. Watching
is deterministic — hooks write reports, the hub watches files and polls
`paseo ls` for idle agents, all free. The PM model runs only when something
needs words: an answer, a push message, a status question, the stand-up.

---

## D-015 — PM model: Claude Sonnet 5.5 by default, any model by choice

*2026-10-02 · owner · revises D-006*

Default: **Claude Sonnet 5.5** (`claude-sonnet-5-5`, $2 / $10 per MTok) at
effort `low`, called through the **official Anthropic SDK** (`@anthropic-ai/sdk`)
with the owner's own API key, billed separately from coding subscriptions. The
SDK, not an OpenAI-compatible shim, so prompt caching, strict tool schemas and
refusal handling work as designed.

Because Leftoff is meant to be published as open source, the model is the
user's choice, including other APIs and local models. The PM core never talks to
a vendor directly; it talks to a small `ModelProvider` interface with two
implementations:

- `anthropic` — the default, official SDK.
- `openai-compatible` — the Chat Completions protocol with tool calls, which
  covers OpenRouter (hundreds of models behind one key), Ollama, LM Studio,
  llama.cpp's server, vLLM, and most hosted APIs. One adapter, many backends,
  selected by `baseUrl`.

Configuration lives in `~/.config/leftoff/config.yaml`, keys in `secrets.env`.
Cost is computed from a price table for Anthropic, taken from the response when
the backend reports it (OpenRouter does), and zero for local models.

Haiku 4.5 vs Sonnet 5.5 is still to be measured on real reports (PRD §11.1).
The same eval ships as `leftoff pm eval`, so anyone choosing another model can
check it does not invent status before trusting it.

Local models on a small always-on server: a mini PC with an integrated GPU has no supported accelerator for
inference (Vega iGPU) and ~9 GB free RAM, so a local PM means a 7–8B model on
CPU — workable for short push messages, slow and weaker for "what was decided
in September". Supported, not recommended as the default.

---

## D-016 — Push notifications and the stand-up are templates, not model calls

*2026-10-02 · implementation*

The reports are already short, structured and in the owner's language, so
turning a `blocked` report into "⛔ Claude è bloccato: …" needs no model. Push
messages and the daily stand-up are rendered from templates: free, instant, and
unable to invent anything. The model runs only to answer the owner's questions.
This is what keeps "the PM follows everything" (D-014) inside a $5/month budget.

## D-017 — The model's cost is capped and visible

*2026-10-02 · implementation*

Every PM call is appended to `~/.config/leftoff/spend.jsonl`. Before each call
the month's total is checked against `pm.budget.monthlyUsd` (default $5); at the
cap the PM answers with a fixed message instead of calling the model, and it warns
once a month at `warnAt` (80%). `leftoff pm spend` shows the ledger; `leftoff pm
doctor` verifies key, workspace and model with the free models endpoint.

First real answer (clipforge, 2026-10-02): 18 s, $0.0115 on Sonnet 5.5 at effort
`low`, every fact traceable to the report it came from.

---

## D-018 — The hub: one polling loop, every worktree, silent baseline

*2026-10-02 · implementation*

`leftoff hub` is one long-running process (systemd user service, lingering on)
that every `notify.pollSeconds` (60) reads each registered project — about 0.3 s
for four projects with their worktrees on a small mini PC. Polling instead of file
watchers: worktrees come and go under `~/.paseo/worktrees`, and a missed inotify
event would mean a missed blocker; a minute's latency costs nothing.

- **Events:** new reports with status `done`, `blocked`, `needs_input` or `idle`
  (never `progress`), and commits on *any* worktree that no report claimed for
  `unreportedAfterMinutes` (30), merges excluded. The snapshot alone would miss
  these: agents commit on their own branches, not on main.
- **Baseline:** a project seen for the first time is marked as read, history
  and recent commits included. The owner hears what happens next, not a replay.
- **Quiet hours** (22:00–08:00): blockers and unreported commits are queued and
  sent at the end; `done`/`idle` wait for the stand-up.
- **Stand-up** at 09:00 local in the General topic, once a day, from templates.
  Projects with no report yet are listed, so silence is visible. Development
  cost reads "non rilevata" rather than a false 0 when hosts report none —
  subscriptions do not.
- **Mute** with `/mute <project> [hours]` or in plain words; the PM has a
  `mute_project` tool, its only write, confined to the hub's own state.
- **Outbound redaction** of keys and tokens on every message, as a last line.
- **Telegram:** long polling (no public address), one forum supergroup, the bot
  an admin with "Manage topics" — which also means it sees every message
  without turning privacy mode off. Only the owner's user id is heard.
  `leftoff connect telegram` binds the group with a `/collega` handshake.
- Chat memory keeps the last 10 turns per topic for 24 h; beyond that the repo
  is the memory, not the chat.

---

## D-019 — Voice notes: Deepgram Nova-3, shown back before they are answered

*2026-10-02 · owner · extends PRD §5.5*

The owner can send a voice note in any topic. Telegram voice notes are Ogg/Opus
and go to Deepgram's pre-recorded API as raw bytes (`POST /v1/listen`, header
`Authorization: Token …`, `model=nova-3`, `smart_format=true`); the transcript and
the audio duration come back in the response. The owner chose Deepgram; the
transcriber sits behind a `Transcriber` interface like the PM's model, so other
services can follow.

- **Language `multi`** by default: Nova-3 transcribes Italian mixed with English
  technical words, which is how the owner actually speaks about code. It costs
  $0.0052/min instead of $0.0043 for Italian alone; `voice.language: it` switches.
- **Keyterms:** every project name and id, plus Leftoff, Claude, Codex and Paseo,
  are sent as `keyterm` parameters (Deepgram caps them at 500 tokens; we send at
  most 40 terms / 350 characters). Proper nouns are where speech to text fails.
- **Shown back, and never answered when in doubt:** the transcript is posted as
  «🎙️ …» before the answer. Below `voice.minConfidence` (0.6) the PM only shows
  what it heard and asks to repeat — a confident answer to a misheard question is
  worse than none. The PM is also told the text was dictated, so it matches odd
  names against the known projects.
- **Limits and cost:** notes over `voice.maxSeconds` (180) are refused before
  download; cost goes to the ledger as `purpose: voice` but does not count against
  the PM's monthly cap, because it draws on a different credit. Without a key the
  hub says plainly that voice is off.
- **Privacy:** the audio of a voice note is sent to Deepgram. Notes sent in a
  project topic are never about a private project, since those do not exist in chat.

---

## D-020 — The PM can speak: Aura-2 voice notes, text always first

*2026-10-02 · owner · extends D-019*

Replies can come back as voice notes, synthesized by Deepgram Aura-2 (Italian
voices exist: `aura-2-livia-it` by default; melia, maia, cinzia, demetra
feminine; dionisio, elio, flavio, cesare masculine). `POST /v1/speak` with
`encoding=opus&container=ogg` returns Ogg/Opus, the only format Telegram renders
as a voice bubble; checked live on 2026-10-02 (valid Ogg, mono Opus).

- **Modes** (`voice.speak.mode`, switchable in chat with `/voce on|off|auto`):
  `mirror` (default) answers a voice note with a voice note; `always` speaks every
  reply and the 09:00 stand-up; `never` is text only. Pushes ("Claude è bloccato")
  stay text: a blocker at night should not play audio.
- **The text always goes out first and whole.** The voice is the gist on top: the
  written answer carries the details (dates, files, options) a listener loses. If
  synthesis fails the answer has already arrived.
- **The spoken script is not the text:** status emoji, markdown, URLs and commit
  hashes are removed or reduced ("un commit"), snake_case reads as words, and
  anything over `voice.speak.maxChars` (600) is cut at a sentence with "Il resto lo
  trovi nel testo."
- **Latency is the cost of REST:** about 4 s per 100 characters (Ogg/Opus is not
  available on the streaming endpoint), hence the 600-character default.
- **Cost:** $0.03 per 1,000 characters (Aura-2) — a typical reply is $0.005–0.02 —
  ledgered as `purpose: voice`, outside the PM's monthly cap.

---

## D-021 — Subscription limits: warn, reached, available again

*2026-10-02 · owner*

The owner wants to hear when a subscription is about to run out, when it does, and
when it unlocks again. What each product exposes decides what is possible:

**Codex — full.** Every session file logs `payload.rate_limits` on each
`token_count` event: `primary` (300 min) and `secondary` (10080 min), each with
`used_percent` and `resets_at` (epoch seconds). Read passively from the tail of the
newest `~/.codex/sessions/**/rollout-*.jsonl` — nothing is called, nothing is spent.
Verified against codex 0.153.4 data on this machine. The warning (default 80%)
arrives within a poll of the reading being logged; "available again" is exact,
because it is time-based on `resets_at`.

**Claude Code — partial, and honestly so.** The percentages exist only in the
status line (`rate_limits.five_hour` / `seven_day`), and Paseo's agents are headless
(`CLAUDE_CODE_ENTRYPOINT=sdk-cli`) so there is no status line to read. There is no
early warning for Claude. What exists: the `StopFailure` hook (matcher `rate_limit`,
payload `error`, `error_details`, `last_assistant_message`, read from the 2.1.287
binary because the docs do not list the fields) when a turn ends on the limit, and
the next successful `Stop` as proof it lifted. The reset time is parsed best-effort
from the message text ("resets 3pm (Europe/Rome)", "in 2h 15m", epoch, ISO); when
it cannot be read the alert says so, and "available again" waits for a good turn.
**Not yet seen against a real limit event** — the raw text is kept in
`~/.config/leftoff/limits/claude.json` so the parser can be corrected on first use.
Rejected: Anthropic's undocumented OAuth usage endpoint — it would use the
subscription's token outside Claude Code.

**Behaviour.** Each message is sent once per cycle, to General. At night everything
waits for the morning — unless the limit was hit and lifted while the owner slept,
in which case neither is mentioned. The 09:00 stand-up gains a "Limiti abbonamenti"
line when a window is at 50% or more. The PM has a `usage_limits` tool for "quanto
mi resta?".

Open: Paseo receives the Agent SDK's `rate_limit_event` messages (which carry
utilization and reset time) but does not store them. If it exposed them, Claude
would get early warnings too.

---

## D-022 — Instructions to agents: the PM drafts, the owner's own words send

*2026-10-02 · owner · fulfils PRD §5.3 / §9 M2 "Two-way"*

The scenario that shaped it: the owner is travelling or driving, has no time to
dictate a precise prompt, says a loose sentence — often by voice — and expects the PM
to turn it into what the agent actually needs, show it, and send it once approved.

**Flow.** The PM gathers context (reports, decisions, backlog), then calls
`propose_agent_command(project, agent, prompt, summary)`. The hub stores a draft per
chat thread and shows it word for word after the PM's short spoken-style summary,
with whether the agent is working (🟢), idle (💤) or unreachable (📥). Only the
owner's reply moves it: «sì» sends, «no» drops, anything else (including «ok ma
aggiungi i test») goes back to the PM as a request for changes and a new draft
replaces the old one. By voice it works the same, and a transcript below the
confidence threshold approves nothing.

**The safety rule, and why it is built this way.** The model cannot send: it has a
drafting tool and no sending tool. Approval is matched by a fixed list of phrases in
the hub (`src/hub/approval.ts`), not by the model's reading of the message. The PM
reads text that agents wrote — reports, commit messages — so a sentence in one of
them can at worst produce a draft the owner sees and refuses. What is stored is what
is shown is what is sent, byte for byte (redacted once, at drafting). Drafts live
2 h and only in their own thread: a late or stray «ok» elsewhere does nothing.

**Delivery** (`src/agents/delivery.ts`). Through Paseo, `paseo send <id>
--prompt-file … --no-wait`. Verified on 2026-10-02 against a throwaway agent: to a
running agent the message lands inside the current turn as a user message, without
interrupting it (the agent acted on it); to an idle agent it starts a new turn. A
closed or unreachable agent gets the message in its inbox, delivered by the hooks at
its next turn, and the owner is told. Never both.

**Follow-through.** Each approved instruction is recorded in `decisions.md` with its
exact text. The agent's next report is pushed as «↩️ Risposta di Claude alla tua
istruzione» whatever its status — unlike ordinary `progress` reports — and also
during quiet hours. A ceiling of 30 instructions per 24 h stops a loop.

**Not done yet:** the PM asking agents for status on its own (D-014) will reuse this
delivery layer; an agent is known to the PM only after its first report.

**Found while testing.** `leftoff report` takes the agent's Paseo id from the
caller's `PASEO_AGENT_ID`, so a report written from an unrelated session registers
that session as the project's agent; and an agent started with `paseo run` runs in the
caller's workspace, where Leftoff's hooks apply to it too.

---

## D-023 — Executive overview first; quiet hours become opt-in

*2026-10-02 · owner*

The PM speaks to the person overseeing several projects, not to the developer
implementing one task. Status answers now lead with the overall state and keep
only changes, blockers, decisions and the next action; portfolio answers use at
most one line per relevant project. The 09:00 overview continues in Telegram's
General topic. When WhatsApp is added, it must also retain a general portfolio
conversation alongside project-specific updates.

Quiet hours are disabled by default. `/quiet on|off` (Italian alias `/silenzio`)
changes the persisted hub setting; `/overview` shows the cross-project stand-up.
Per-project mute is unchanged.

Voice remains text plus audio for now. The text carries exact details; the audio
is shorter and collapses code blocks, paths, hashes, pull-request references and
long identifiers instead of spelling them out.

---

## D-024 — Agents stopped by subscription limits restart automatically

*2026-10-02 · owner*

When a limit is reached, Leftoff records the exact project and agent from Claude's
failure hook or Codex's session metadata. At the known reset time it sends that
agent a deterministic instruction to verify current state and continue from where
it stopped. It waits a one-minute safety margin after the advertised reset — never
the exact boundary — because providers can take a moment to reopen the window. The
restart itself ignores quiet hours; only its owner-facing notice may wait. The
action and the next report are tracked like any other instruction.

`/riparti <project> [agent]` is the manual equivalent. If Paseo can reach the
agent it starts immediately; otherwise the instruction waits in its inbox. Leftoff
never restarts every agent of a provider when it cannot identify the stopped one.

---

## D-025 — Review fixes: shown before approvable, visibility at send time, one session per restart

*2026-10-03 · implementation, from an internal code review*

A second agent reviewed the code while the main developer was blocked, and found five
defects with reproductions. All were real; one (R1) was a flaw in D-022's design.

- **A draft is approvable only once it has been shown** (D-022, amended). The earlier
  design stored the draft the moment the PM's tool ran, so a model error or a failed reply
  left text in the thread that a later «sì» would send unseen. The draft is now committed
  after the reply that shows it has gone out; before that it exists only in memory.
- **Private means private at every moment** (extends the `private` rule): visibility is
  checked when a message is composed *and* when it leaves the queue, and a queue entry
  records the projects it reveals. D-024's automatic restart still runs for a private
  project — only the chat says nothing about it.
- **A restart belongs to the session that stopped** (D-024, amended): the Paseo session is
  recorded when the limit is seen and the instruction goes to it alone. If it is gone, the
  owner is told and nothing else is woken — the inbox is shared by every future session of
  the logical agent, so it is not a fallback for a restart.
- **Restarts are reconciled, not alert-driven**, and logged per episode. One agent blocked
  by two windows restarts once, after the last. A window that has already reset arms nothing.

Test hygiene: hub tests no longer read the real Codex sessions of the machine they run on.

---

## D-026 — The PM asks working agents for a status update, rationed

*2026-10-03 · owner · fulfils D-014*

"The PM follows everything" without a model call per event, and without wearing out the
owner's subscriptions, which every ask spends. Two paths, one mechanism (`#askStatus`):

- **Automatic**, once per tick, for an agent that is *working* in Paseo (`running`) and
  whose last report is older than `statusChecks.staleAfterMinutes` (120). Only between 09:00
  and 21:00 local — the owner's recommendation — never for a muted or private project, never
  for an agent already expected to answer something, never again within
  `minIntervalMinutes` (180), at most `maxPerDay` (8) in 24 h, and not for a product whose
  subscription window is at the warning level or reached.
- **On request**: the PM has an `ask_agent_status` tool, used when the owner asks where an
  agent is and its last report is old. No approval — it only asks — but it is told to say
  that it asked, and to answer from what it already knows first.

The question is a fixed template, not model text, and ends «Non cambiare il tuo piano per
questo»: it asks for a report, never for work. It goes to the agent only if it is reachable
live (`askLive`): a status question has no value hours later in an inbox, so there is no
inbox fallback. An idle agent is asked only when it has commits nobody reported — otherwise
its last report *is* the status and asking would only wake it.

The agent's next report is pushed as «↩️ Aggiornamento da Claude (chiesto dal PM)» whatever
its status, distinct from the answer to an instruction. A failure in this loop is contained:
it can never cost the owner the queue, the stand-up or the saved state of the pass.

Found while reviewing this code against the 2026-10-03 findings: queued notices bound to a
project topic were not re-checked for visibility at send time (the R5 class); they are now.

---

## D-027 — A control panel in the browser, as a mirror of the chat

*2026-10-03 · owner, implemented by a second Claude agent (`claude-ui`)*

The owner wants one place to see where every project stands, and to talk to the PM from it,
alongside Telegram and (later) WhatsApp. See docs/web.md.

- **Served by the hub, wired as a `Channel` decorator.** The panel needs the hub's state and
  its `handle()`; a decorator (`MirrorChannel`) adds both without touching `hub.ts`, and the
  same wrapper will work for the WhatsApp channel.
- **One log, two screens.** Every PM message and every owner message is appended to
  `feed.jsonl`; Telegram and the browser show the same thing. Web conversations are their own
  threads (`web-<project>`), so a draft made in the browser is approved in the browser.
- **The board is derived, not edited.** From Backlog.md when it exists, otherwise from the
  agents' reports. It cannot disagree with the PM, and nothing needs maintaining by hand.
- **Private means private here too**; loopback by default; a token for anything else. The
  panel is a place where an unauthenticated write could instruct agents, so it fails closed.
- **Agent id `claude-ui`** for the agent that built it: a report under `claude` would have
  re-pointed that agent's Paseo link to the wrong session (`ensureAgent`).

Found on the way: Paseo delivers the PM's status asks (D-026) by interrupting the agent's
running tool call; an agent doing a long command sees it rejected, then the ask. Not a bug in
the hub, but worth knowing when a command is "refused" with no one having refused it.

---

## D-028 — The PM turns a loose request into tasks, and adds them without a draft

*2026-10-03 · owner, implemented by `claude-ui`*

The owner wants to say «aggiungi a questo progetto questo» in a few words and have the PM
formulate the to-dos properly.

- **`create_tasks` writes Backlog.md files** (`backlog/tasks/<prefix>-<n> - Title.md`, frontmatter,
  Description and Acceptance Criteria), numbering on from the project's own tasks and honouring
  `task_prefix` in `backlog/config.yml`. The panel's board and the Backlog.md CLI see them with no
  conversion; a project without a backlog gets the folder.
- **No draft and no «sì».** Unlike an instruction to an agent (D-022), adding a task changes only
  the project's own plan, is visible and reversible, and the request *is* the approval. Nothing is
  sent to an agent; starting one on a task is still a separate, approved instruction.
- **Undo is limited to what the PM created**: `.leftoff/pm-tasks.jsonl` is the ledger, so a
  misheard «annulla» can never delete a task the owner or an agent wrote.
- **Bounded and logged**: at most 12 tasks per request, text redacted, the whole batch validated
  before any file is written, and every batch recorded in decisions.md with the request behind it.

---

## D-029 — Six languages, one typed catalog

*2026-10-03 · owner, implemented by `claude-ui`*

Leftoff must be usable in the languages such a tool normally ships in: Italian, English,
German, French, Spanish, Portuguese.

- **A typed catalog, not scattered `it ? … : …`.** The compiler requires every language to have
  every sentence, so a language cannot be half there; a test also fails if one is a forgotten copy
  of English. The existing Italian and English texts were moved verbatim.
- **The language is the owner's, and changes live.** `/lingua <code>` (and its equivalents in every
  language) changes it from the chat and is remembered across restarts; `language` in config is
  only the default. The control panel chooses per device.
- **«Yes» and «no» are understood in every language at once**, from fixed lists (D-022 intact).
  The owner may answer in the language they think in, whatever the PM is speaking.
- **The PM's free-form answers follow the owner's own language**; each question carries the
  interface language as the tiebreaker for words that say nothing («ok», a number).
- **The mute confirmation is now localized** (it printed English to Italian owners).
- **Not done**: voices. Deepgram's Aura-2 voice is Italian by default; for another language the
  owner picks a voice in `voice.speak.model`.

---

## D-030 — One agent per Paseo workspace, named as the owner named it

*2026-10-03 · owner, implemented by `claude-ui`*

Found on Clipforge: three Claude sessions in three workspaces all reported as the one agent `claude`,
so the panel showed one «Claude» and its Paseo link jumped to whichever session reported last
(instructions meant for one could reach another). Codex sessions did not appear until their
first report.

- **Identity is the workspace.** An agent's id comes from Paseo's own workspace title
  (`~/.paseo/projects/workspaces.json`, matched by directory): «Clipforge-UX-UI-Claude» in project
  `clipforge` is `ux-ui-claude`, shown as «Clipforge-UX-UI-Claude». The project's own name is dropped from
  the id (longest prefix first). `LEFTOFF_AGENT` and `--agent` still win; outside Paseo nothing changes.
- **Stable.** `project.yaml` records the workspace path on the agent (`workspace`, `label`), so a new
  session in the same workspace is the same agent (and takes over the link), and renaming the
  workspace only changes its label. Two workspaces with one name are told apart, not merged.
- **One session, one agent.** When a session is bound to its workspace agent, an older host-level
  agent that held the same session is unlinked (inbox only): the old `claude` keeps its history and
  stops receiving what is meant for someone else.
- **The owner's words work in chat.** The PM sees each agent's `workspaceName`, and
  `propose_agent_command`, status asks and `/resume` accept it («dì a UX-UI-Claude…»).
- **Not migrated.** Existing `claude` / `codex` agents and their reports stay as they were; they
  fade as the workspace agents take over, and can be deleted from `project.yaml`.

---

## D-031 — Agents are listed from Paseo, found by session, and a running agent is not "waiting"

*2026-10-03 · owner, implemented by `web-dev-claude`*

After D-030, Clipforge still showed one agent and a stale «Serve te» for an agent that was working.

- **The workspace is found from the session, not from the directory.** An agent assigned to a
  workspace often works in a sibling git worktree (Clipforge's main dev is in `hapless-vulture` but edits
  `main-dev`), which Paseo has no workspace for. Paseo records each session's `workspaceId`
  (`~/.paseo/agents/*/<id>.json`); `PASEO_AGENT_ID` → session → workspace → title. Only a workspace of
  *this* project counts: a session wandering into another repo is not its agent.
- **The hub registers the agents Paseo already runs.** Each pass, for every project, each Paseo
  workspace of the repo with a live Claude Code or Codex session becomes an agent in `project.yaml`
  (the running session, else the most recently active) — no first report needed, so the owner sees
  it, can ask it for an update and instruct it from the start. Only *missing* agents are added: an
  existing one keeps the link its reports set. Closed, archived and foreign sessions are ignored.
- **A question stops being «Serve te» once the agent is running again.** A report is written at the
  end of a turn, so a session that is running has started another: someone answered, usually the
  owner in Paseo itself, which Leftoff does not hear. The panel shows it as in progress, drops the
  ask, the headline and the blocked card, until the agent reports again. An agent that is still
  stopped keeps asking.
- Tests no longer meet the Paseo workspaces of the machine they run on (`PASEO_HOME` is isolated).

---

## D-032 — Old host-level agents are retired when workspace agents replace them

*2026-10-03 · owner, implemented by `web-dev-claude`*

After D-031 every project listed its workspace agents, but the old `claude` / `codex` agents stayed,
unlinked, each holding its last report — so Clipforge and Leftoff kept a «Serve te» from a question the
owner had already answered in Paseo, and the owner's own workspace appeared twice.

- **`retired`** (in `project.yaml`): an agent with no workspace and no live session, in a project whose
  program already has workspace agents, is history. Its reports stay; it is not listed as an agent, its
  last question is not an ask, it does not set the project's headline, and what it left open (doing,
  next, blocked) is not on the board — what it *finished* still is. A session taken over by a workspace
  agent retires the older agent that held it. An agent that reports again is alive again.
- **Adoption, not duplication.** An agent that already has the workspace's own id and never had a
  workspace (it reported under that name) becomes that workspace's agent.
- **Not deleted.** Nothing is removed from `project.yaml` or the repo: retiring is a flag the owner
  can clear, and the history is still there for the PM and the timeline.

*Amendment to D-032 (same day):* retiring an old agent hid its open work, which was often the *same
session* under an older name — Harbor lost two real blockers (the `VPS_PATH` secret, the Airbnb
logo). The agent that took over a retired agent's Paseo session now **inherits its last report**
(reports name their session) until it writes one of its own: its blockers, question, doing and next
are that agent's current state, shown under the new agent's name. A retired agent with no heir stays hidden.

---

## D-033 — The PM speaks on chat only when it matters; the dashboard keeps everything

*2026-10-03 · owner, implemented by `web-dev-claude`*

Too many messages on Telegram: the owner wants to hear only the most critical things and ask for the
rest. The control panel is the detailed surface.

- **`notify.level`**, default `critical`, changeable from the chat (`/avvisi`, `/alerts`, in every
  language) and remembered. *critical*: an agent blocked or needing the owner, a subscription limit
  reached (and a session that could not be restarted), the answer to what the owner asked — including
  the status they asked the PM to request. *normal* adds finished/idle reports, limit warnings and
  «available again», restarts. *all* adds commits nobody reported and the answers to the PM's own
  automatic status questions (which now record who asked). **Never filtered:** the daily stand-up and
  every reply to the owner's own messages.
- **Held back is not lost.** `Channel.note()` (optional) records what the hub chose not to send; the
  panel's log shows it dashed and marked «not sent». The project page already has every report.
- Existing hub tests that assert the old «everything is pushed» now run at `level: all`.

## D-034 — The panel stays on the machine that holds the repositories; reach it through Tailscale

*2026-10-03 · owner, implemented by `web-dev-claude`*

The owner asked to reach the dashboard away from home, and whether it could run on a public web host.

- **Not on a web host**: the hub reads the projects' files, git and Paseo on the machine that runs the hub; a hosting server has
  none of it. Reaching the one on your own machine is the answer (docs/remote-access.md).
- **`web.allowedHosts`**: the panel answers to loopback only, plus the names listed there, for forwarders
  (`tailscale serve`, a reverse proxy) that present their own host name. **Listing a name requires
  `LEFTOFF_WEB_TOKEN`** — behind a forwarder every request looks local, so the password is what protects the
  panel — and the hub refuses to start otherwise. Behind HTTPS the login cookie is `Secure`.

---

## D-035 — The panel always has a password, even on loopback

*2026-10-03 · owner, from a security review (finding W6)*

On loopback the panel used to run without a password, which left it open to any process on the
machine — including the agents it supervises — able to write to the PM's chat and approve. The
risk was bounded (agents already have the `paseo` CLI) but cheap to remove.

When the panel is enabled and `LEFTOFF_WEB_TOKEN` is not set, the hub generates 256 random bits once
and appends them to `secrets.env` (0600, in a 0700 directory, written by rename). A password the owner
chose, in the environment or in secrets.env, is never touched. It is never written to a log: the hub
only says that one was generated. `leftoff web link` prints the address to open once — the panel turns
it into an `HttpOnly; SameSite=Strict` cookie and drops the token from the address bar — and
`leftoff web rotate` replaces it (restart the hub to use it).

On this machine a password already existed (set for D-034), so nothing changed here; the default is for
the next installation. What it does not protect against: a process running as the owner that reads
secrets.env, which can do anything the owner can.

---

## D-036 — A team per project: roles, and handoffs the PM passes on after the owner's yes

*2026-10-08 · owner*

The scenario: one project, three agents in three Paseo workspaces — a main developer (architect and
backend, the only one who merges), a UX/UI agent, a tests-and-review agent. They do not talk to each
other. When the UX agent needs an endpoint it tells the owner, and the owner carries the message to the
main developer, and the answer back. The owner wants the PM to do that carrying — the job a project
manager does in a real team — so the project moves without them as the go-between.

- **Roles.** Each agent in `project.yaml` can have a `role`, one line in the owner's words. The owner sets
  it with `leftoff agents role <agent> "…"` or by telling the PM (`set_agent_role`). At every session
  start each agent is told its team: ids, workspace names, roles, and which one it is.
- **Handoffs.** An agent that needs a teammate says so in its report: `--handoff "<teammate>: <ask>"`
  (`handoffs: [{to, ask}]`). The teammate is found by id, workspace name or role ("backend"); a name
  nobody matches, or a role two agents share, finds no one, and the owner is told who is on the team.
- **Level A: the owner approves every handoff.** The hub turns each into a draft for the teammate — a
  fixed template with the ask, who sent it, the report, branch and commits, and how to answer back —
  and shows it in the project's thread. The D-022 rules hold unchanged: only the owner's «sì», matched
  by the fixed list, sends it; what is sent is exactly what was shown; it is approvable only after it
  was shown, for the draft lifetime (2 h); «no» drops it; anything else goes to the PM as a request for
  changes, and a revised draft for the same teammate replaces the handoff.
- **One at a time per project.** A project shows its next handoff only when nothing else is approvable
  in its thread (another handoff, or a draft the PM made there), so a «sì» can only ever mean the last
  thing shown. Not shown in quiet hours or while the project is muted; they wait, and expire unseen
  after a week.
- **The answer goes back.** The teammate's next report is pushed as its answer to the asker's request;
  if the asker must act, the teammate hands off back, and that is a new draft. The daily ceiling of
  instructions (30) counts handoffs too.
- **Merges stay with the agent whose role says so**, through the same mechanism («QA approved: merge
  branch X» is a handoff to the main developer). Leftoff never merges.

**Level B, next:** routes the owner authorises once (UX → main dev, main dev → QA, QA → main dev) go
out without asking, under a daily ceiling and a limit on chain length against ping-pong, with the owner
told afterwards; merging, pushing and deploying keep needing their yes. The decision to send would be the
hub's code checking the route, never the model. Not built until A has been used for a while.

Considered and rejected: agents messaging each other directly (no one sees the conversation, and a report
could steer another agent with nobody approving); full autonomy (C) for the same reason.
