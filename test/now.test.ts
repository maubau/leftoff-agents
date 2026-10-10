import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, test } from "node:test";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { describeTool, latestStep, readNow, recordTurnEnd, recordTurnStart } from "../src/core/now.ts";
import { loadProject } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { buildSnapshot } from "../src/core/snapshot.ts";
import { executeTool } from "../src/pm/tools.ts";
import { Data } from "../src/web/data.ts";
import { emptyState } from "../src/hub/state.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const PASEO = "7a2e4c1d-0000-4000-8000-0000000main1";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
let dir = "";

beforeEach(async () => {
  dir = await isolateHost("leftoff-now-");
});

/** A Claude Code transcript: the turn's prompt, then what the assistant did, oldest first. */
async function claudeTranscript(entries: Array<Record<string, unknown>>): Promise<string> {
  const file = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
}
const at = (s: number) => new Date(Date.UTC(2026, 9, 10, 14, 0, s)).toISOString();
const tool = (s: number, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "assistant", timestamp: at(s), message: { content: [{ type: "tool_use", name, input }] }, ...extra });

/** Run the real CLI as a host would run a hook, in an isolated home. */
async function hook(cwd: string, event: string, payload: Record<string, unknown>): Promise<string> {
  const child = spawn(process.execPath, [CLI, "hook", "claude-code", event], { cwd, env: { ...process.env } });
  child.stdin.end(JSON.stringify({ cwd, ...payload }));
  let out = "";
  child.stdout.on("data", (c) => (out += String(c)));
  const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? 0)));
  strictEqual(code, 0, "a hook always exits 0");
  return out;
}

test("each tool call reads as one line: what it runs, edits, reads or looks for — never what it writes", () => {
  strictEqual(describeTool("Bash", { command: "npm test\nnpm run typecheck" }), "$ npm test");
  strictEqual(describeTool("Edit", { file_path: "/repo/src/hub/hub.ts", old_string: "secret", new_string: "x" }), "✎ hub.ts");
  strictEqual(describeTool("Read", { file_path: "/repo/README.md" }), "📖 README.md");
  strictEqual(describeTool("Grep", { pattern: "flushDeliveries" }), "🔎 flushDeliveries");
  strictEqual(describeTool("WebFetch", { url: "https://docs.example.com/x?y" }), "🌐 docs.example.com");
  strictEqual(describeTool("Task", { description: "survey the hooks" }), "🤖 survey the hooks");
  strictEqual(describeTool("TodoWrite", { todos: [{ status: "completed", content: "a" }, { status: "in_progress", content: "b", activeForm: "Writing the tests" }] }), "☑ Writing the tests");
  strictEqual(describeTool("Mystery", {}), "⚙ Mystery");
});

test("the latest step of this turn comes from the end of the transcript; sub-agents and older turns do not count", async () => {
  const file = await claudeTranscript([
    { type: "user", timestamp: at(0), message: { content: "old turn" } },
    tool(1, "Bash", { command: "ls" }),
    { type: "user", timestamp: at(10), message: { content: "run the tests" } },
    tool(11, "Bash", { command: "npm test" }),
    tool(12, "Read", { file_path: "/r/a.ts" }, { isSidechain: true }),
  ]);
  deepStrictEqual(await latestStep(file, at(10)), { text: "$ npm test", at: at(11) });
  strictEqual(await latestStep(file, at(30)), undefined, "nothing done yet in a turn begun after the last step");
  const said = await claudeTranscript([{ type: "assistant", timestamp: at(5), message: { content: [{ type: "text", text: "Tests pass.\nNow the docs." }] } }]);
  deepStrictEqual(await latestStep(said, at(0)), { text: "💬 Tests pass. Now the docs.", at: at(5) });
  strictEqual(await latestStep(join(dir, "missing.jsonl"), at(0)), undefined, "a missing transcript is no step, never an error");
});

test("Codex's transcript gives its commands too", async () => {
  const file = await claudeTranscript([
    { timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm run build"] }) } },
  ]);
  deepStrictEqual(await latestStep(file, at(0)), { text: "$ npm run build", at: at(1) });
});

test("a turn's request is kept with secrets redacted, and its end recorded", async () => {
  const p = await tempProject({ id: "harbor", name: "Harbor" });
  await recordTurnStart(p, "main-dev", "claude-code", { prompt: "Deploy with key sk-ant-api03-abcdefghijklmnopqrstuv\nthen   report", transcript_path: join(dir, "none.jsonl") }, new Date(at(0)));
  const now = (await readNow(p, "main-dev"))!;
  match(now.request, /^Deploy with key sk-ant-…\[redacted\] then report$/);
  strictEqual(now.ended, undefined);
  await recordTurnEnd(p, "main-dev", new Date(at(60)));
  strictEqual((await readNow(p, "main-dev"))!.ended, at(60));
  await recordTurnStart(p, "main-dev", "claude-code", { prompt: "   " });
  strictEqual((await readNow(p, "main-dev"))!.request.startsWith("Deploy"), true, "an empty prompt is not a request");
});

test("the hooks record it as it happens: UserPromptSubmit starts the turn, the Stop that lets it end closes it", async () => {
  const p = await tempProject({ id: "harbor", name: "Harbor" });
  const transcript = await claudeTranscript([tool(1, "Edit", { file_path: join(p.root, "src", "x.ts") })]);
  await hook(p.root, "user-prompt-submit", { prompt: "Aggiungi la paginazione (scritto in Paseo)", transcript_path: transcript });
  const live = (await readNow(p, "claude"))!;
  strictEqual(live.request, "Aggiungi la paginazione (scritto in Paseo)");
  strictEqual(live.ended, undefined);
  // Unreported work: the first Stop sends it back to write its report, so the turn goes on.
  match(await hook(p.root, "stop", { transcript_path: transcript }), /"decision":"block"/);
  strictEqual((await readNow(p, "claude"))!.ended, undefined);
  // The second Stop lets it end.
  await hook(p.root, "stop", { transcript_path: transcript, stop_hook_active: true });
  ok((await readNow(p, "claude"))!.ended, "the turn ended");
});

test("the snapshot carries it: always while the turn runs, after it only until the agent reports", async () => {
  const p = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: PASEO }] });
  await report(p, { ...base, agent: "main-dev", status: "progress", doing: ["Gap 1"], at: new Date(Date.now() - 60_000).toISOString() });
  await recordTurnStart(p, "main-dev", "claude-code", { prompt: "Fai il Gap 2" });
  const snapshot = async () => (await buildSnapshot(await loadProject(p.root))).agents.find((a) => a.id === "main-dev")!;
  strictEqual((await snapshot()).now?.request, "Fai il Gap 2");
  // A progress report in the middle of the turn: the live turn still shows.
  await report(await loadProject(p.root), { ...base, agent: "main-dev", status: "progress", doing: ["Gap 2, tests"] });
  strictEqual((await snapshot()).now?.request, "Fai il Gap 2");
  // The turn ends, and its report says it better.
  await recordTurnEnd(p, "main-dev", new Date(Date.now() - 1000));
  strictEqual((await snapshot()).now, undefined);
});

test("the panel shows what a working agent is doing this minute, and the PM's project_status has it in detail", async () => {
  const p = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: PASEO, label: "Harbor Main Dev" }] });
  await registerProject("harbor", p.root);
  await report(p, { ...base, agent: "main-dev", status: "progress", doing: ["Old work"], at: new Date(Date.now() - 3_600_000).toISOString() });
  const transcript = await claudeTranscript([tool(0, "Bash", { command: "npm test" }, { timestamp: new Date().toISOString() })]);
  await recordTurnStart(p, "main-dev", "claude-code", { prompt: "Fix the login form", transcript_path: transcript }, new Date(Date.now() - 5_000));

  const running = async () => JSON.stringify([{ id: PASEO, status: "running" }]);
  const config = ConfigSchema.parse({ language: "en", limits: { enabled: false } });
  const data = new Data({ config, state: () => ({ ...emptyState(), deliveryQueue: [{ id: "q", projectId: "harbor", agentId: "main-dev", paseoAgent: PASEO, text: "x", kind: "command", queuedAt: new Date().toISOString(), notify: true }] }), exec: async () => ({ stdout: await running() }) });
  const agent = (await data.detail("harbor"))!.project.agents[0]!;
  strictEqual(agent.live, "running");
  strictEqual(agent.summary, "$ npm test · «Fix the login form»");
  strictEqual(agent.now?.request, "Fix the login form");
  strictEqual(agent.now?.step, "$ npm test");
  strictEqual(agent.queued, 1, "and what waits for its turn to end");

  const status = JSON.parse((await executeTool({ surface: "chat" }, "project_status", { project: "harbor" })).content);
  const now = status.agents.find((a: { id: string }) => a.id === "main-dev").now;
  deepStrictEqual([now.request, now.latestStep, now.turnEndedAt], ["Fix the login form", "$ npm test", null]);
});

test("a private project's agents are recorded locally but never shown", async () => {
  const p = await tempProject({ id: "secret", name: "Secret", visibility: "private", agents: [{ id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: PASEO }] });
  await registerProject("secret", p.root);
  await recordTurnStart(p, "main-dev", "claude-code", { prompt: "Confidential work" });
  const data = new Data({ config: ConfigSchema.parse({ limits: { enabled: false } }), state: () => emptyState(), exec: async () => ({ stdout: "[]" }) });
  strictEqual(await data.detail("secret"), undefined);
  const status = await executeTool({ surface: "chat" }, "project_status", { project: "secret" });
  ok(!status.content.includes("Confidential"), "chat never sees it");
});
