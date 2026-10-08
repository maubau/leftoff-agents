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

## API (read-only except chat)

`GET /api/overview` · `GET /api/projects/:id` · `GET /api/feed?project=<id|general>&limit&before`
· `GET /api/events` (SSE: `feed`, `typing`, `refresh`) · `POST /api/chat {project, text}`.

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
