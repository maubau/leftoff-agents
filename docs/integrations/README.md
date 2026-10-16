# Connecting an assistant to Leftoff

> **Status:** stdio (`leftoff mcp`, read tools) is available; HTTP and the webhook are not built yet
> ([mcp.md](../mcp.md)). Each guide names the client version its configuration was checked against.

| Client | Guide | Transport |
|---|---|---|
| Any MCP client | [generic.md](generic.md) | stdio or HTTP |
| Claude Code, Claude Desktop | [claude.md](claude.md) | stdio (Desktop), stdio or HTTP (Code) |
| Hermes Agent | [hermes.md](hermes.md) | HTTP, plus the webhook |

A client not listed: if it speaks MCP over stdio or Streamable HTTP with a bearer header, [generic.md](generic.md)
applies.
