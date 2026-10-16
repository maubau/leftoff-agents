# Leftoff from any AI assistant (MCP)

> **Status: designed, not yet available.** This page describes the MCP server as designed in
> [mcp-design.md](mcp-design.md) (D-061). The commands and settings below do not exist yet. This note goes when they
> ship.

Leftoff can speak the [Model Context Protocol](https://modelcontextprotocol.io), so any MCP-capable assistant can
ask it where your projects stand and, if you allow it, pass your decisions back to your coding agents. Leftoff stays
the source of truth: its files in each repository and its hub. The assistant is one more way to talk to it, next to
Telegram and the web panel.

## What it gives an assistant

- **Status**: every project with its stage, URL, last activity and what is done, in progress, blocked or waiting for
  you; one project's brief; its reports, decisions, tasks and costs.
- **Events**: what happened since the assistant last looked (done, blocked, needs you, idle, commits nobody
  reported), by cursor. Optionally pushed to the assistant by a signed webhook.
- **Writes, if you turn them on**: a message to an agent, a task created or updated, a decision recorded. Each needs
  an explicit confirmation from you through the assistant, and is logged.

It never gives code, diffs or file contents, and never anything about a project marked `visibility: private`.

## Two ways to connect

| | stdio | Streamable HTTP |
|---|---|---|
| For | an assistant on the same machine (Claude Desktop, Claude Code, Cursor) | an assistant on another machine (an always-on assistant server) |
| Runs | the assistant starts `leftoff mcp` | the Leftoff hub serves `http://<host>:<port>/mcp` |
| Auth | none: it is your own process | a bearer token, always |
| Needs the hub | no for reads; yes for events and Paseo delivery | yes |

## Configuration reference

In `~/.config/leftoff/config.yaml` (defaults shown):

```yaml
mcp:
  http:
    enabled: false
    host: 127.0.0.1      # loopback only; another address is your explicit choice
    port: 4778
    path: /mcp
    allowedHosts: []     # names a proxy or VPN reaches it by
  write:
    enabled: false
    tools: []            # send_to_agent, create_task, update_task, record_decision
  audit: true
  webhook:
    enabled: false
    url: ""
    events: [done, blocked, needs_input, idle, unreported_commits]
channel: telegram        # or none, to use an assistant as your only chat
```

In `~/.config/leftoff/secrets.env` (never in a repository):

```
LEFTOFF_MCP_TOKEN=…        # created by `leftoff mcp token`
LEFTOFF_WEBHOOK_SECRET=…   # only for the webhook
```

`leftoff mcp token` creates or rotates the token. Restart the hub after changing either file.

## Tool reference

Read tools change nothing. Write tools say «Changes state:» in their description, are listed only when enabled, and
do nothing without `confirm: true` and `confirmation`.

| Tool | Input | Returns |
|---|---|---|
| `list_projects` | none | id, name, purpose, stage, url, last activity, headline, task counts, agents |
| `get_brief` | `project` | where it stands: each agent's status and question, blockers, unreported commits, next steps |
| `get_reports` | `project`, `since`, `until`, `agent`, `limit` | report summaries (no bodies) |
| `get_decisions` | `project`, `limit` | decisions with date and author |
| `list_tasks` | `project`, `status` | tasks with status, assignee, dependencies |
| `get_costs` | `project`, `period` | development and PM spend, where known |
| `get_events` | `since_cursor`, `project`, `kinds`, `limit` | events after the cursor, and `next_cursor` |
| `send_to_agent` ✎ | `project`, `agent`, `message`, `confirm`, `confirmation` | delivered, queued, or in the inbox |
| `create_task` ✎ | `project`, `title`, `description`, `criteria`, `assignee`, `confirm`, `confirmation` | the new task's id |
| `update_task` ✎ | `project`, `id`, `status`, `assignee`, `confirm`, `confirmation` | the task |
| `record_decision` ✎ | `project`, `text`, `why`, `confirm`, `confirmation` | the entry |

Example call and answer:

```json
{ "name": "get_events", "arguments": { "since_cursor": "1840" } }
```

```json
{
  "events": [
    { "cursor": "1842", "at": "2026-10-16T08:40:12Z", "project": "harbor", "kind": "needs_input", "agent": "ux",
      "text": "Week or month view first?", "question": { "options": ["Week", "Month"], "recommend": "Week" } }
  ],
  "next_cursor": "1842"
}
```

A write without confirmation describes itself and stops:

```json
{ "name": "send_to_agent", "arguments": { "project": "harbor", "agent": "ux", "message": "Week view first." } }
```

```json
{ "done": false, "wouldDo": "Send to ux (harbor): «Week view first.» — call again with confirm: true and the user's confirmation." }
```

## Webhook

When `mcp.webhook.enabled` is on, every event is POSTed as JSON to `mcp.webhook.url`, signed with the
[Standard Webhooks](https://www.standardwebhooks.com) scheme: headers `webhook-id`, `webhook-timestamp` and
`webhook-signature` (`v1,` and the base64 HMAC-SHA256 of `id.timestamp.body` with `LEFTOFF_WEBHOOK_SECRET`).
Receivers that support Standard Webhooks verify it as is. Failed deliveries are retried three times. Every event
stays readable through `get_events`, so a missed webhook loses nothing.

## Security model

- HTTP listens on loopback unless you choose otherwise, and always needs the token. It refuses to start on another
  address without one. Host and Origin headers are checked, which stops DNS rebinding.
- **To reach it from another machine**, keep it off the public internet. Use a private network (a VPN such as
  WireGuard or Tailscale, or your LAN) or a reverse proxy that adds TLS and forwards to loopback. List the name the
  proxy or VPN uses in `mcp.http.allowedHosts`.
- Assistants hosted by a vendor connect from the vendor's cloud and cannot reach a private network: use stdio with
  those, from the machine Leftoff runs on.
- What tools return is summaries, redacted of secrets. Private projects do not exist for any tool. Every call is one
  line in `~/.config/leftoff/mcp-audit.jsonl`, and every write is also in the project's `.leftoff/decisions.md`.
- Text returned by tools was written by agents: it is data for the assistant, not instructions to it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The client lists no tools over stdio | `leftoff` not on the client's `PATH`: give the full path to `leftoff` in its config |
| `401` over HTTP | missing or old `Authorization: Bearer …`; after `leftoff mcp token`, update the client |
| `403` over HTTP | the `Host` the client used is not loopback and not in `mcp.http.allowedHosts` |
| The hub will not start with `mcp.http` on | non-loopback `host` or `allowedHosts` with no `LEFTOFF_MCP_TOKEN` |
| `get_events` says `hubRunning: false` | events are recorded by the hub; start it (`leftoff hub`) |
| Write tools are missing | `mcp.write.enabled` is off, or the tool is not in `mcp.write.tools` |
| A project is missing | it is `visibility: private`, or not registered (`leftoff projects`) |

Client guides: [integrations/](integrations/). A full deployment on two machines:
[examples/two-node-home-lab.md](examples/two-node-home-lab.md).
