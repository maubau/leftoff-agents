import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildMcpServer } from "./server.ts";

/**
 * `leftoff mcp`: the MCP server over stdio, for an assistant on this machine that starts it as a child process
 * (D-061). stdout is the protocol's channel, so anything said aside goes to stderr. It reads the files only; events
 * appear while the hub runs.
 */
export async function runMcpStdio(): Promise<void> {
  const server = buildMcpServer({ transport: "stdio" });
  await server.connect(new StdioServerTransport());
  process.stderr.write("leftoff mcp: ready on stdio\n");
}
