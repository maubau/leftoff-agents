# Claude Code and Claude Desktop

> stdio is available; HTTP is not built yet. Checked against **Claude Code 2.1.296** and Anthropic's MCP documentation
> (code.claude.com/docs/en/mcp, 2026-10-16).

## Claude Code

Same machine, stdio:

```bash
claude mcp add --transport stdio --scope user leftoff -- leftoff mcp
```

Another machine, HTTP with the token:

```bash
claude mcp add --transport http --scope user leftoff http://dev-server:4778/mcp \
  --header "Authorization: Bearer $LEFTOFF_MCP_TOKEN"
```

Or in a project's `.mcp.json` (shared with the team, so the token stays in each person's environment):

```json
{
  "mcpServers": {
    "leftoff": {
      "type": "http",
      "url": "${LEFTOFF_MCP_URL:-http://127.0.0.1:4778/mcp}",
      "headers": { "Authorization": "Bearer ${LEFTOFF_MCP_TOKEN}" }
    }
  }
}
```

Claude Code expands `${VAR}` in `url` and `headers`. Use your own variable name: it reads some credential names,
such as `ANTHROPIC_API_KEY`, as empty there on purpose.

A coding agent that is itself managed by Leftoff does not need this: it reports through hooks. This is for a Claude
Code session you use as an assistant across projects.

## Claude Desktop

Use **stdio**, on the machine where Leftoff runs. In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "leftoff": { "command": "/path/to/leftoff", "args": ["mcp"] }
  }
}
```

Remote «custom connectors» in Claude's apps connect from Anthropic's cloud, not from your computer. They cannot reach
a Leftoff hub inside a private network, and a server on the open internet is not recommended
([security model](../mcp.md#security-model)). From another computer, use stdio over your own tunnel, or Claude Code
over HTTP.
