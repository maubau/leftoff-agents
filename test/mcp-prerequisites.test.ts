import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { init } from "../src/commands/init.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { paseoHome } from "../src/core/paths.ts";
import { loadProject } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { claudeCode } from "../src/hosts/claude-code.ts";
import { appendEvent, eventsFile, readAllEvents, readEvents } from "../src/hub/events.ts";
import { Hub } from "../src/hub/hub.ts";
import { knownClaudeAccounts } from "../src/limits/claude.ts";
import { commit, isolateHost, tempProject, tempRepo } from "./helpers.ts";

let dir = "";
beforeEach(async () => {
  dir = await isolateHost("leftoff-mcp-pre-");
});

const base = { done: [], doing: [], blocked: [], next: [], option: [] };

test("Paseo's home is PASEO_HOME everywhere: Claude config directories and account names come from it, not from ~/.paseo", async () => {
  strictEqual(paseoHome(), join(dir, "paseo"), "isolateHost points it at the sandbox");
  await mkdir(paseoHome(), { recursive: true });
  const work = join(dir, ".claude-work");
  await writeFile(join(paseoHome(), "config.json"), JSON.stringify({ agents: { providers: { "claude-work": { label: "Claude (Work)", env: { CLAUDE_CONFIG_DIR: work } } } } }), "utf8");
  ok((await claudeCode.detectRoots()).some((r) => r.dir === work), "hooks go into Paseo's extra config directory");
  ok((await knownClaudeAccounts()).some((a) => a.label === "Work"));
  strictEqual(paseoHome({ PASEO_HOME: "/elsewhere/paseo" }), "/elsewhere/paseo");
});

test("init records a project's stage and url, also on a project already set up; a stage is one word", async () => {
  const root = await tempRepo();
  await init(root, { name: "Orchard", hooks: false, force: false, stage: "production", url: "https://orchard.example.com" });
  let project = await loadProject(root);
  deepStrictEqual([project.config.stage, project.config.url], ["production", "https://orchard.example.com"]);
  await init(root, { hooks: false, force: false, stage: "staging" });
  project = await loadProject(root);
  deepStrictEqual([project.config.name, project.config.stage, project.config.url], ["Orchard", "staging", "https://orchard.example.com"], "only what was given changes");
  await rejects(init(root, { hooks: false, force: false, stage: "Not One Word" }), /stage is one lowercase word/);
});

test("the hub records events with a cursor: done, blocked, needs_input, idle, unreported commits — not progress", async () => {
  const p = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code" }, { id: "main-dev", control: "inbox", host: "claude-code" }] });
  await registerProject("harbor", p.root);
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false }, notify: { unreportedAfterMinutes: 1 } });
  let now = Date.now();
  const hub = new Hub({ config, channel: new ConsoleChannel(), clock: () => now, log: () => undefined });
  await hub.tick(new Date(now));
  await report(p, { ...base, agent: "ux", status: "needs_input", question: "Week or month view first?", option: ["Week", "Month"], recommend: "Week" } as never);
  await report(await loadProject(p.root), { ...base, agent: "main-dev", status: "progress", doing: ["Booking API"] });
  await hub.tick(new Date((now += 60_000)));
  await report(await loadProject(p.root), { ...base, agent: "main-dev", status: "done", done: ["Booking API with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"] });
  await hub.tick(new Date((now += 60_000)));

  const all = await readAllEvents();
  deepStrictEqual(all.map((e) => [e.seq, e.kind, e.agent]), [[1, "needs_input", "ux"], [2, "done", "main-dev"]], "progress is not an event");
  deepStrictEqual(all[0]!.question, { options: ["Week", "Month"], recommend: "Week" });
  ok(!all[1]!.text.includes("abcdefghijklmnop"), "redacted");

  const after = await readEvents({ since: 1 });
  deepStrictEqual([after.events.map((e) => e.seq), after.next], [[2], 2]);
  deepStrictEqual((await readEvents({ since: 2 })).events, [], "nothing new");
  strictEqual((await readEvents({ since: 2 })).next, 2, "the cursor stays");
  deepStrictEqual((await readEvents({ kinds: ["done"] })).events.map((e) => e.seq), [2]);
  deepStrictEqual((await readEvents({ projects: new Set(["orchard"]) })).events, [], "a project the caller may not see");

  await commit(p.root, "work.ts", "x", "Unreported work");
  await hub.tick(new Date((now += 10 * 60_000)));
  await hub.tick(new Date((now += 10 * 60_000)));
  ok((await readAllEvents()).some((e) => e.kind === "unreported_commits" && /Unreported work/.test(e.text)));
});

test("a private project never has an event; events older than thirty days go", async () => {
  const hidden = await tempProject({ id: "vault", name: "Vault", visibility: "private" });
  strictEqual(await appendEvent(hidden, { kind: "done", text: "secret work" }, new Date()), null);
  const open = await tempProject({ id: "harbor", name: "Harbor" });
  const old = new Date(Date.now() - 40 * 86_400_000);
  await appendEvent(open, { kind: "done", text: "long ago" }, old);
  await appendEvent(open, { kind: "done", text: "today" }, new Date());
  const all = await readAllEvents();
  deepStrictEqual(all.map((e) => [e.seq, e.text]), [[2, "today"]], "the old one is gone, the cursor is not reused");
  ok(!(await readFile(eventsFile(), "utf8")).includes("vault"));
});
