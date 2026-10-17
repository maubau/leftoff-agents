# Hermes Agent

> MCP over HTTP and the webhook are available. Checked against **Hermes Agent v0.22.2** and its documentation
> (hermes-agent.nousresearch.com/docs: features/mcp, messaging/webhooks; 2026-10-16).

Hermes is an always-on assistant with messaging gateways, so it fits the «external front end» mode. You talk to Hermes
on your phone, and Hermes asks Leftoff. Leftoff can then run with `channel: none`.

## MCP: Hermes asks Leftoff

In `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  leftoff:
    url: http://dev-server:4778/mcp
    headers:
      Authorization: Bearer <LEFTOFF_MCP_TOKEN>
    timeout: 60
    connect_timeout: 15
    tools:
      # reads only, until you decide otherwise
      include: [list_projects, get_brief, get_reports, get_decisions, list_tasks, get_costs, get_events]
```

Hermes passes only its configured environment to servers, so put the token in the header as shown (or in Hermes's
own secret handling). Hermes speaks a 2025-era MCP revision through the MCP Python SDK; Leftoff serves it
statelessly. If Hermes cannot connect, check `connect_timeout` and the `Host` in `mcp.http.allowedHosts`. Leftoff
does not use the legacy SSE transport.

When you enable Leftoff's write tools, add them to `include` one by one. Hermes then has to ask you before it
calls one with `confirm: true`.

## Webhook: Leftoff tells Hermes

Hermes's webhook adapter accepts **Standard Webhooks** signatures, the scheme Leftoff signs with. In Hermes's
`config.yaml`, a route (the names are yours):

```yaml
platforms:
  webhook:
    extra:
      routes:
        leftoff:
          secret: <the value of LEFTOFF_WEBHOOK_SECRET in Leftoff's secrets.env, whsec_…>
          prompt: "Leftoff: {project} — {kind} — {text}. Tell me only if it needs me."
          deliver: telegram
```

In Leftoff's `config.yaml`:

```yaml
mcp:
  webhook:
    enabled: true
    url: http://assistant-server:8644/webhooks/leftoff
    events: [blocked, needs_input, done]
```

`leftoff mcp webhook-secret` creates it on the Leftoff side (in `secrets.env`); copy the same `whsec_…` value into the
Hermes route. Hermes verifies it as a Standard Webhooks (Svix-style) signature and refuses timestamps older than five
minutes; Leftoff signs each try afresh. The template can use `{project}`, `{kind}`, `{agent}`, `{text}` and `{cursor}`. Hermes's docs say a webhook's content is
untrusted input to the agent. Leftoff sends summaries only, and nothing about private projects.

Without the webhook, a Hermes scheduled job can poll `get_events` with the last cursor instead.
