# Any MCP client

> Designed, not yet available. Written against the MCP specification revision 2026-07-28 and the 2025-era revisions
> that clients still speak (both are served).

## Same machine: stdio

Most clients take a server as a command with arguments. Give the full path if the client does not share your
shell's `PATH`:

```json
{
  "mcpServers": {
    "leftoff": { "command": "/path/to/leftoff", "args": ["mcp"] }
  }
}
```

`leftoff mcp` reads `~/.config/leftoff/` of the user who runs it. Set `LEFTOFF_CONFIG_DIR` in the client's `env`
block if Leftoff's configuration lives elsewhere.

## Another machine: Streamable HTTP

On the machine running the Leftoff hub, in `config.yaml`:

```yaml
mcp:
  http:
    enabled: true
    host: 127.0.0.1          # or the private-network address you choose
    allowedHosts: [dev-server]   # the name the client uses, if not loopback
```

Then `leftoff mcp token`, and restart the hub. In the client:

```json
{
  "mcpServers": {
    "leftoff": {
      "type": "http",
      "url": "http://dev-server:4778/mcp",
      "headers": { "Authorization": "Bearer ${LEFTOFF_MCP_TOKEN}" }
    }
  }
}
```

Keep the token in the client's own secret store or environment, not in a file you share. Reach `dev-server` over a
private network or a reverse proxy with TLS ([mcp.md, security model](../mcp.md#security-model)).

## Check it

Ask the assistant «list my Leftoff projects». It should call `list_projects`. If it does not see the tool, see
[troubleshooting](../mcp.md#troubleshooting).
