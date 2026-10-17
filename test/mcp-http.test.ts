import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { configRoot } from "../src/core/paths.ts";
import { afterEach, beforeEach, test } from "node:test";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { registerProject } from "../src/core/registry.ts";
import { McpHttpServer } from "../src/mcp/http.ts";
import { isolateHost, tempProject } from "./helpers.ts";

/**
 * MCP over HTTP as a remote assistant meets it (D-061): a 2025-era client (as Hermes's Python SDK), a bearer token,
 * and the Host and Origin checks. Two invented projects, one of them private.
 */
const TOKEN = "t0ken-for-tests-only-0123456789abcdef";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
let servers: McpHttpServer[] = [];

beforeEach(async () => {
  await isolateHost("leftoff-mcp-http-");
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code" }] });
  await registerProject("harbor", harbor.root);
  await report(harbor, { ...base, agent: "ux", status: "needs_input", question: "Week or month view first?", option: ["Week", "Month"] } as never);
  const vault = await tempProject({ id: "vault", name: "Vault", visibility: "private" });
  await registerProject("vault", vault.root);
});
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
});

async function serve(http: Record<string, unknown> = {}, token: string | undefined = TOKEN) {
  // Port 0: any free one (the schema itself wants a real port).
  const config = { ...ConfigSchema.parse({ mcp: { http: { enabled: true, ...http } } }).mcp.http, port: 0 };
  const server = new McpHttpServer({ config, token, log: () => undefined });
  await server.start();
  servers.push(server);
  return server;
}

/** One raw HTTP POST, so the Host header can be set as a browser or a rebinding page would. */
function post(port: number, body: unknown, headers: Record<string, string> = {}, path = "/mcp"): Promise<{ status: number; body: any; text: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${port}`, "content-length": Buffer.byteLength(data), ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        // An answer comes as JSON, or as one event of an event stream.
        const json = text.trim().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(json);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, text });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });
const init = rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "remote-assistant", version: "1" } });

test("a remote assistant with the token reads Leftoff over HTTP: the same read tools, no private project (D-061)", async () => {
  const { port } = await serve();
  const hello = await post(port, init);
  strictEqual(hello.status, 200);
  strictEqual(hello.body.result.serverInfo.name, "leftoff");
  const tools = await post(port, rpc(2, "tools/list"));
  deepStrictEqual(tools.body.result.tools.map((t: any) => t.name).sort(), ["get_brief", "get_costs", "get_decisions", "get_events", "get_reports", "list_projects", "list_tasks"]);
  const projects = await post(port, rpc(3, "tools/call", { name: "list_projects", arguments: {} }));
  deepStrictEqual(projects.body.result.structuredContent.projects.map((p: any) => p.id), ["harbor"]);
  const brief = await post(port, rpc(4, "tools/call", { name: "get_brief", arguments: { project: "harbor" } }));
  strictEqual(brief.body.result.structuredContent.questions[0].text, "Week or month view first?");
  const hidden = await post(port, rpc(5, "tools/call", { name: "get_brief", arguments: { project: "vault" } }));
  strictEqual(hidden.body.result.isError, true);
});

test("no token, a wrong token: 401 with a Bearer challenge, and nothing answered", async () => {
  const { port } = await serve();
  for (const auth of [{ authorization: "" }, { authorization: "Bearer wrong-token" }, { authorization: `Basic ${TOKEN}` }]) {
    const res = await post(port, init, auth);
    strictEqual(res.status, 401);
    ok(!res.text.includes("leftoff\""), "no server info");
    match(res.body.error, /bearer token is required/);
  }
});

test("Host and Origin are checked: a foreign Host or Origin is 403 (DNS rebinding); a configured name is accepted", async () => {
  const { port } = await serve({ allowedHosts: ["dev-server"] });
  strictEqual((await post(port, init, { host: `evil.example:${port}` })).status, 403);
  strictEqual((await post(port, init, { host: `dev-server:${port}` })).status, 200, "the name a VPN or proxy uses");
  strictEqual((await post(port, init, { origin: "http://evil.example" })).status, 403);
  strictEqual((await post(port, init, { host: `localhost:${port}` })).status, 200);
});

test("only its path answers; it never starts without a token", async () => {
  const { port } = await serve();
  strictEqual((await post(port, init, {}, "/other")).status, 404);
  const config = { ...ConfigSchema.parse({ mcp: { http: { enabled: true } } }).mcp.http, port: 0 };
  for (const token of [undefined, ""]) await rejects(new McpHttpServer({ config, token, log: () => undefined }).start(), /no LEFTOFF_MCP_TOKEN/);
});

test("leftoff mcp token creates the token once, prints the same one after, and --rotate replaces it, privately", async () => {
  const run = async (...args: string[]) => (await promisify(execFile)(process.execPath, ["src/cli.ts", "mcp", "token", ...args], { env: process.env })).stdout.trim();
  const first = await run();
  ok(/^[0-9a-f]{64}$/.test(first), "256 random bits");
  strictEqual(await run(), first, "not regenerated");
  const rotated = await run("--rotate");
  ok(rotated !== first);
  const secrets = join(configRoot(), "secrets.env");
  match(await readFile(secrets, "utf8"), new RegExp(`^LEFTOFF_MCP_TOKEN=${rotated}$`, "m"));
  strictEqual((await stat(secrets)).mode & 0o777, 0o600);
});

test("at boot, before the VPN brings its address up, it keeps trying instead of staying off", async () => {
  const lines: string[] = [];
  // 192.0.2.1 (TEST-NET-1) is on no machine: binding it fails with EADDRNOTAVAIL, like a Tailscale address before tailscaled.
  const config = { ...ConfigSchema.parse({ mcp: { http: { enabled: true, host: "192.0.2.1" } } }).mcp.http, port: 0 };
  const server = new McpHttpServer({ config, token: TOKEN, log: (l) => void lines.push(l) });
  server.serve(20);
  await new Promise((r) => setTimeout(r, 120));
  await server.stop();
  strictEqual(lines.filter((l) => /is not on this machine yet; trying again/.test(l)).length, 1, "said once, retried quietly");
  ok(!lines.some((l) => /not started/.test(l)));
});
