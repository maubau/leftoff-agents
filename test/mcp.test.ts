import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { report } from "../src/commands/report.ts";
import { createTask } from "../src/core/backlog.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { configRoot } from "../src/core/paths.ts";
import { loadProject, saveProject } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { appendEvent } from "../src/hub/events.ts";
import { isolateHost, tempProject } from "./helpers.ts";

/**
 * `leftoff mcp` as an assistant sees it: a child process spoken to over stdio, here with a 2025-era `initialize`
 * (as the MCP Python SDK sends, which Hermes uses). Three invented projects: one at work, one in production, and one
 * private that must never show.
 */
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
let children: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
  await isolateHost("leftoff-mcp-");
});
afterEach(() => {
  for (const c of children) c.kill();
  children = [];
});

async function fixtures() {
  const harbor = await tempProject({ id: "harbor", name: "Harbor", purpose: "Bookings for a marina", agents: [{ id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX" }, { id: "main-dev", control: "inbox", host: "claude-code" }, { id: "docs", control: "inbox", host: "claude-code" }] });
  await registerProject("harbor", harbor.root);
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  await report(harbor, { ...base, agent: "main-dev", status: "done", done: ["Booking API, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"], at: daysAgo(3), costUsd: 1.25 } as never);
  await report(await loadProject(harbor.root), { ...base, agent: "docs", status: "idle", done: ["Setup guide"], at: daysAgo(2) } as never);
  await report(await loadProject(harbor.root), { ...base, agent: "ux", status: "needs_input", question: "Week or month view first?", option: ["Week", "Month"], recommend: "Week", at: daysAgo(1) } as never);
  await recordDecision(await loadProject(harbor.root), { at: daysAgo(2), by: "user", text: "Postgres, not SQLite" });
  await createTask(await loadProject(harbor.root), { title: "Calendar screen", description: "", acceptanceCriteria: [], labels: [], priority: "high", status: "In Progress", assignee: ["ux"] });
  await createTask(await loadProject(harbor.root), { title: "Payments", description: "", acceptanceCriteria: [], labels: [], priority: "medium" });

  const orchard = await tempProject({ id: "orchard", name: "Orchard" });
  await saveProject(orchard.root, { ...orchard.config, stage: "production", url: "https://orchard.example.com" });
  await registerProject("orchard", orchard.root);

  const vault = await tempProject({ id: "vault", name: "Vault", visibility: "private", agents: [{ id: "main-dev", control: "inbox", host: "claude-code" }] });
  await registerProject("vault", vault.root);
  await report(vault, { ...base, agent: "main-dev", status: "needs_input", question: "Secret question?", option: ["A"] } as never);

  await appendEvent(await loadProject(harbor.root), { kind: "done", agent: "main-dev", text: "Booking API" }, new Date(daysAgo(3)));
  await appendEvent(await loadProject(harbor.root), { kind: "idle", agent: "docs", text: "Setup guide" }, new Date(daysAgo(2)));
  await appendEvent(await loadProject(harbor.root), { kind: "needs_input", agent: "ux", text: "Week or month view first?", question: { options: ["Week", "Month"], recommend: "Week" } }, new Date(daysAgo(1)));
  return { harbor, orchard, vault };
}

/** A client over stdio: one JSON-RPC message per line each way. */
async function connect() {
  const child = spawn(process.execPath, ["src/cli.ts", "mcp"], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let buffer = "";
  const waiting = new Map<number, (v: any) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 20_000);
      waiting.set(n, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-assistant", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await request("tools/call", { name, arguments: args })).result;
  return { init, request, call };
}

test("an assistant away for three days asks where things stand, and gets it from the read tools (D-061)", { timeout: 60_000 }, async () => {
  await fixtures();
  const { init, request, call } = await connect();
  strictEqual(init.result.serverInfo.name, "leftoff");
  const tools = (await request("tools/list")).result.tools;
  deepStrictEqual(tools.map((t: any) => t.name).sort(), ["get_brief", "get_costs", "get_decisions", "get_events", "get_reports", "list_projects", "list_tasks"]);
  ok(tools.every((t: any) => t.annotations?.readOnlyHint === true), "every tool says it changes nothing");

  const projects = (await call("list_projects")).structuredContent.projects;
  deepStrictEqual(projects.map((p: any) => p.id).sort(), ["harbor", "orchard"]);
  const orchard = projects.find((p: any) => p.id === "orchard");
  deepStrictEqual([orchard.stage, orchard.url], ["production", "https://orchard.example.com"]);
  strictEqual(projects.find((p: any) => p.id === "harbor").stage, undefined);

  const brief = (await call("get_brief", { project: "harbor" })).structuredContent;
  deepStrictEqual(brief.questions, [{ agent: "ux", text: "Week or month view first?", options: ["Week", "Month"], recommend: "Week" }]);
  deepStrictEqual(Object.fromEntries(brief.agents.map((a: any) => [a.id, a.status])), { ux: "needs_input", "main-dev": "done", docs: "idle" });
  deepStrictEqual(brief.inProgress.map((t: any) => t.title), ["Calendar screen"]);

  const events = (await call("get_events", { since_cursor: "0" })).structuredContent;
  deepStrictEqual(events.events.map((e: any) => [e.cursor, e.kind]), [["1", "done"], ["2", "idle"], ["3", "needs_input"]], "oldest first");
  strictEqual(events.next_cursor, "3");
  deepStrictEqual((await call("get_events", { since_cursor: "3" })).structuredContent.events, [], "nothing new after the cursor");
  deepStrictEqual((await call("get_events")).structuredContent.events.map((e: any) => e.kind), [], "without a cursor: the last 24 hours");

  const reports = (await call("get_reports", { project: "harbor", limit: 2 })).structuredContent.reports;
  deepStrictEqual(reports.map((r: any) => r.agent), ["ux", "docs"], "newest first");
  ok(!("body" in reports[0]), "summaries, no bodies");
  match((await call("get_decisions", { project: "harbor" })).structuredContent.decisions[0].text, /Postgres, not SQLite/);
  deepStrictEqual((await call("list_tasks", { project: "harbor", status: "todo" })).structuredContent.tasks.map((t: any) => t.title), ["Payments"]);
  const costs = (await call("get_costs", { period: "week" })).structuredContent;
  strictEqual(costs.byProject.find((p: any) => p.project === "harbor").devUsd, 1.25);
});

test("a private project is never exposed: not listed, not readable by any tool, no event", { timeout: 60_000 }, async () => {
  await fixtures();
  const { call } = await connect();
  for (const [tool, args] of [["get_brief", {}], ["get_reports", {}], ["get_decisions", {}], ["list_tasks", {}], ["get_costs", {}], ["get_events", {}]] as const) {
    const out = await call(tool, { ...args, project: "vault" });
    strictEqual(out.isError, true, `${tool} refuses it`);
    match(out.content[0].text, /No such project "vault"/);
    ok(!JSON.stringify(out).includes("Secret question"));
  }
  const all = JSON.stringify([await call("list_projects"), await call("get_events", { since_cursor: "0" }), await call("get_costs")]);
  ok(!all.includes("vault") && !all.includes("Secret question"));
});

test("secrets are redacted, refusals are answers not crashes, and every call is in the audit log", { timeout: 60_000 }, async () => {
  await fixtures();
  const { call } = await connect();
  const reports = JSON.stringify(await call("get_reports", { project: "harbor" }));
  ok(!reports.includes("abcdefghijklmnop"), "the key is redacted");
  const bad = await call("get_events", { since_cursor: "yesterday" });
  strictEqual(bad.isError, true);
  match(bad.content[0].text, /Not a cursor/);
  const lines = (await readFile(join(configRoot(), "mcp-audit.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  deepStrictEqual(lines.map((l) => [l.transport, l.tool, l.ok]), [["stdio", "get_reports", true], ["stdio", "get_events", false]]);
  ok(!lines.some((l) => "since_cursor" in l), "never the arguments' text");
});
