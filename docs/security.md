# Security and privacy

Leftoff reads your project's reports and talks to services outside your machine, so it is worth knowing what it
does. This page is meant to be read critically; if something here is wrong, please say so (see
[SECURITY.md](../SECURITY.md)).

## What leaves your machine

| To | What | When |
|---|---|---|
| Your model provider (Anthropic by default, or the endpoint you configure) | The text the PM reads to answer: reports, decisions, backlog items, commit subjects, your message. **Not your source code.** | Only when you ask something or a request needs interpreting. Stand-ups and alerts are templates, with no model call. |
| Telegram | What the bot sends and receives: alerts, stand-ups, answers, your messages and voice notes. Telegram bots are **not end-to-end encrypted**. | When you use Telegram. `channel: none` turns it off. |
| Deepgram | Your voice notes (to transcribe) and the text of spoken replies (to synthesize). | Only if you set `DEEPGRAM_API_KEY`. |
| Anywhere else | Nothing. No telemetry, no update check, no analytics. | |

Reports are written by agents and can contain anything an agent decided to write. Everything that leaves the machine
passes through a **redaction** step first (API keys, tokens, private-key blocks, `password=…`-style assignments).
That is a safety net for accidents, not a guarantee: don't rely on it to clean deliberately sensitive text.

A project marked `visibility: private` (`leftoff init --private`) is invisible to chat and to the panel. Use it for
anything you do not want a chat service or its participants to see.

## What the PM can and cannot do

The PM is a model, and models can be manipulated: a report, a commit message or a web page an agent summarised could
contain text written to steer it (prompt injection). The design assumes the model **may be fooled**, and limits what
being fooled can cost:

- **It cannot send an instruction to an agent.** It can only *draft* one. The draft is shown to you; only your own
  message matching a fixed list of "yes" words, checked by code, sends it, and what is sent is byte-for-byte what you
  saw. A draft can be approved only after it was shown, in its own conversation, within two hours (default). A hijacked
  PM can produce a draft you refuse; it cannot approve it.
- **It can, without asking:** add or remove backlog tasks, mute a project, and ask a working agent for a status update
  — rationed (default 8 a day, 09:00–21:00, not the same agent twice within 3 hours). These are visible in the chat.
- **It has no shell and no file access.** Its tools read Leftoff's own data and git history.
- **Paths found in repository files are untrusted.** Anything read from `project.yaml`, reports or STATE is checked to
  stay inside the project before it is used.
- **A ceiling on instructions** (30 per 24 hours) and **a hard monthly spend cap** (default $5) bound a loop or a
  stolen key's use through Leftoff.

## Who can talk to it

- **Telegram:** only the user ids in `telegram.allowedUserIds`, set by whoever completed `/connect` in the group.
  Messages from anyone else are ignored. Keep the group private; anybody *in* it can read what the bot posts.
- **The control panel:** loopback only by default, **always behind a password** (256-bit, generated on first start,
  stored in `secrets.env`). Requests with a non-loopback `Host` are refused (DNS rebinding), cross-origin writes are
  refused, there is a strict content security policy, and the page never turns report text into markup. To use it
  from other devices, go through a private network such as Tailscale and not the open internet: see
  [remote-access.md](remote-access.md).
- **The hooks** run with your user's rights, as the agents do. They only run `leftoff`.

## What Leftoff does not protect against

- A **compromised machine or user account**: Leftoff's files, keys and hooks are as safe as that account.
- **Secrets an agent wrote into a report** in a form the redaction doesn't recognise, and then sends to your model
  provider or Telegram.
- **A malicious agent** (or a poisoned repository) writing misleading reports. The PM reports what the agents say;
  verify what matters.
- **Telegram or model-provider breaches**: treat chat and API content as visible to those services.

## Files and permissions

`~/.config/leftoff/` is created with mode 700; `secrets.env` and `config.yaml` are written with mode 600. Hook
installation backs up every host file before editing it, and `leftoff hosts uninstall` removes only what Leftoff
added. `.leftoff/` in a repository is meant to be committed: do not put secrets in reports, decisions or project
notes, and review it as you would any file you commit to a public repository if the repository is public.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on the repository (Security → Report a vulnerability), not a
public issue. See [SECURITY.md](../SECURITY.md).
