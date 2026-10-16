# Example: a two-node home lab

> Designed, not yet available ([mcp.md](../mcp.md)). One way to deploy Leftoff with an external assistant, with
> placeholder names. Nothing here is a default.

```
 phone ── messaging app ──► assistant-server  (always on: an MCP-capable assistant with a messaging gateway)
                                 │   ▲
              MCP over HTTP      │   │  webhook (signed)
              (private VPN)      ▼   │
                             dev-server  (coding agents, Paseo, Leftoff hub, repositories)
```

## dev-server

Runs the coding agents (for example under Paseo) and the Leftoff hub, as `<user>`. The repositories are in
`/home/<user>/projects/`.

`~/.config/leftoff/config.yaml`, the parts that matter here:

```yaml
channel: none                 # the assistant is the chat
mcp:
  http:
    enabled: true
    host: 10.0.0.2            # dev-server's address on the VPN, not on the LAN or the internet
    port: 4778
    allowedHosts: [dev-server]
  webhook:
    enabled: true
    url: http://assistant-server:8644/webhooks/leftoff
    events: [done, blocked, needs_input]
```

`~/.config/leftoff/secrets.env` holds `LEFTOFF_MCP_TOKEN` (from `leftoff mcp token`) and `LEFTOFF_WEBHOOK_SECRET`.
The hub runs as a user service (`leftoff hub install-service` on Linux).

## assistant-server

Runs the assistant and its messaging gateway. Its MCP config points at `http://dev-server:4778/mcp` with
`Authorization: Bearer <LEFTOFF_MCP_TOKEN>`. Its webhook route verifies with the same `LEFTOFF_WEBHOOK_SECRET`. See
[integrations/hermes.md](../integrations/hermes.md) for one such assistant.

## The private network

Both machines join one VPN (WireGuard, Tailscale, or another). `dev-server` binds Leftoff's MCP listener to its VPN
address only. Allow only `assistant-server` to reach port 4778, with the VPN's access rules or the host firewall.
Nothing is published to the internet. The bearer token still guards the endpoint; the VPN provides encryption.
Instead of a VPN, a reverse proxy with TLS on `dev-server` can forward to `127.0.0.1:4778`. Then `host` stays
`127.0.0.1` and `allowedHosts` lists the proxy's name.

## A day with it

- You write «where are we on harbor?» to the assistant. It calls `list_projects` and `get_brief(harbor)`, then
  answers from them.
- An agent asks a question. Leftoff records a `needs_input` event and the webhook reaches the assistant, which tells
  you.
- You answer. If `send_to_agent` is enabled, the assistant asks you to confirm, then calls it with `confirm: true`.
  Leftoff delivers it at the end of the agent's turn and records the decision.
- After three days away, the assistant calls `get_events` with its last cursor and summarises what happened.

## Back up

On `dev-server`, `~/.config/leftoff/` (above all `secrets.env`, `config.yaml`, `projects.json`, `hub-state.json`).
The projects' memory is in their repositories.
