import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { NewProjectError, planProject, runStep, type RunFn } from "../src/commands/new-project.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, saveProject } from "../src/core/project.ts";
import { ensureAgent } from "../src/core/agents.ts";
import { readRegistry, registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { ProjectJobs } from "../src/hub/project-jobs.ts";
import type { IncomingMessage, SendOptions } from "../src/channels/channel.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { emptyState, type HubState, type ProjectJob } from "../src/hub/state.ts";
import { Data } from "../src/web/data.ts";
import { Feed } from "../src/web/feed.ts";
import { WebServer } from "../src/web/server.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const exec = promisify(execFile);
let dir = "";
let root = "";
const servers: WebServer[] = [];

beforeEach(async () => {
  dir = await isolateHost("leftoff-new-project-");
  root = join(dir, "projects");
});
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

/**
 * Real git, with an identity of its own (the machine running the tests may have none), and a pretend `paseo` that
 * remembers its workspaces. `paseo: "absent"` is a machine without it; `identity: false` a git that knows nobody.
 */
function machine(options: { paseo?: "present" | "absent"; identity?: boolean } = {}) {
  const calls: string[][] = [];
  const workspaces: Array<{ workspaceId: string; cwd: string; name: string }> = [];
  let paseo = options.paseo ?? "present";
  const run: RunFn = async (file, args, cwd) => {
    if (file === "git") {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...(options.identity === false ? {} : { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" }) };
      return exec("git", ["-c", "user.useConfigOnly=true", ...args], { cwd, env });
    }
    calls.push(args);
    if (paseo === "absent") throw Object.assign(new Error("spawn paseo ENOENT"), { code: "ENOENT" });
    if (args[0] === "workspace" && args[1] === "ls") return { stdout: JSON.stringify(workspaces) };
    if (args[0] === "workspace" && args[1] === "create") {
      const value = (flag: string) => args.find((a) => a.startsWith(`${flag}=`))!.slice(flag.length + 1);
      const w = { workspaceId: `wks_${workspaces.length + 1}`, cwd: value("--path"), name: value("--title") };
      workspaces.push(w);
      return { stdout: JSON.stringify({ ...w, project: "x", isolation: "local" }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { run, calls, workspaces, set paseo(v: "present" | "absent") { paseo = v; } };
}

function jobs(m: ReturnType<typeof machine>, state: HubState = emptyState(), changes: ProjectJob[] = []) {
  const config = ConfigSchema.parse({ projects: { root } });
  return { state, changes, jobs: new ProjectJobs({ config, state: () => state, save: async () => undefined, onChange: (j) => void changes.push(structuredClone(j)), run: m.run }) };
}

async function refused(work: Promise<unknown>): Promise<NewProjectError> {
  try {
    await work;
  } catch (error) {
    ok(error instanceof NewProjectError, String(error));
    return error;
  }
  throw new Error("not refused");
}

test("a name becomes an id and a folder under the root; what cannot be one is refused with its reason (D-056)", async () => {
  deepStrictEqual(await planProject("  Orchard   Club ", root), { name: "Orchard Club", id: "orchard-club", folder: join(root, "orchard-club") });
  strictEqual((await planProject("Città Nuova", root)).id, "citta-nuova");
  strictEqual((await refused(planProject("   ", root))).reason, "empty");
  strictEqual((await refused(planProject("x".repeat(61), root))).reason, "too_long");
  strictEqual((await refused(planProject("Orchard\u0000Club", root))).reason, "bad_chars");
  strictEqual((await refused(planProject("!!!", root))).reason, "no_id");
  strictEqual((await refused(planProject("Δέλτα", root))).reason, "no_id", "an id is Latin letters and digits");
  strictEqual((await refused(planProject("General", root))).reason, "reserved", "the general thread is web-general");
  strictEqual((await planProject("../../etc", root)).folder, join(root, "etc"), "a path in the name is only a name");

  const taken = await tempProject({ id: "harbor", name: "Harbor" });
  await registerProject("harbor", taken.root);
  const e = await refused(planProject("Harbor", root));
  deepStrictEqual([e.type, e.status, e.existing], ["exists", 409, { kind: "project", id: "harbor" }]);
  await mkdir(join(root, "orchard"), { recursive: true });
  deepStrictEqual((await refused(planProject("Orchard", root))).existing, { kind: "folder" });
});

test("a creation makes the folder, the repository, the Leftoff project with its first commit, the registry entry and the Paseo project", async () => {
  const m = machine();
  const { jobs: j, changes, state } = jobs(m);
  const job = await j.start({ name: "Orchard Club", purpose: "A club for orchards", private: true } as never, "web");
  strictEqual(job.status, "running");
  const done = (await j.settled(job.id))!;
  strictEqual(done.status, "done");
  deepStrictEqual(done.steps.map((s) => s.status), ["done", "done", "done", "done", "done"]);

  const folder = join(root, "orchard-club");
  const project = await loadProject(folder);
  deepStrictEqual([project.id, project.config.name, project.config.purpose, project.config.visibility], ["orchard-club", "Orchard Club", "A club for orchards", "normal"]);
  match(await readFile(join(folder, "AGENTS.md"), "utf8"), /leftoff/i);
  const { stdout: log } = await exec("git", ["log", "--format=%s", "--name-only"], { cwd: folder });
  match(log, /^Leftoff: new project/, "one first commit, with a fixed message");
  match(log, /AGENTS\.md/, "an agent's worktree, made from that commit, has the protocol");
  ok((await readRegistry()).projects.some((p) => p.id === "orchard-club" && p.path === folder));
  deepStrictEqual(m.workspaces, [{ workspaceId: "wks_1", cwd: folder, name: "Orchard Club" }]);
  deepStrictEqual(m.calls.map((c) => c.slice(0, 2).join(" ")), ["workspace ls", "workspace create"], "Paseo is asked before it is told");
  strictEqual(typeof state.themes["orchard-club"], "number");
  ok(changes.some((c) => c.steps[0]!.status === "running") && changes.at(-1)!.status === "done", "every change is told");
  strictEqual(j.creationOf("orchard-club"), undefined, "complete: no creation to show");
});

test("without Paseo the project is complete for Leftoff and waits at the Paseo step; a retry does only that step, once", async () => {
  const m = machine({ paseo: "absent" });
  const { jobs: j } = jobs(m);
  const job = await j.start({ name: "Orchard" }, "web");
  const stopped = (await j.settled(job.id))!;
  strictEqual(stopped.status, "failed");
  deepStrictEqual(stopped.steps.map((s) => s.status), ["done", "done", "done", "done", "failed"]);
  deepStrictEqual(stopped.steps[4]!.error?.type, "paseo_unavailable");
  ok(stopped.steps[4]!.retryable);
  ok((await readRegistry()).projects.some((p) => p.id === "orchard"), "registered: it is on the Home");
  deepStrictEqual(j.creationOf("orchard"), { jobId: job.id, status: "failed", step: "paseo" });

  m.paseo = "present";
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: join(root, "orchard") })).stdout;
  await j.retry(job.id);
  const done = (await j.settled(job.id))!;
  strictEqual(done.status, "done");
  strictEqual((await exec("git", ["rev-parse", "HEAD"], { cwd: join(root, "orchard") })).stdout, head, "nothing redone: no second commit");
  strictEqual(m.workspaces.length, 1);
  await rejects(j.retry("nope"), /no such creation/);
});

test("a git with no name and email stops at the Leftoff step and says so; nothing is deleted", async () => {
  const m = machine({ identity: false });
  const { jobs: j } = jobs(m);
  const job = await j.start({ name: "Orchard" }, "web");
  const stopped = (await j.settled(job.id))!;
  deepStrictEqual(stopped.steps.map((s) => s.status), ["done", "done", "failed", "pending", "pending"]);
  strictEqual(stopped.steps[2]!.error?.type, "git_identity");
  ok(stopped.steps[2]!.retryable);
  await loadProject(join(root, "orchard")); // the folder and its files stay
  ok(!(await readRegistry()).projects.some((p) => p.id === "orchard"), "not on the Home before it is made");
});

test("a creation the hub was running when it stopped is seen as stopped, and can be retried", async () => {
  const state = emptyState();
  state.projectJobs = [{ id: "j1", name: "Orchard", projectId: "orchard", folder: join(root, "orchard"), origin: "web", status: "running", steps: [{ id: "folder", status: "done", retryable: false }, { id: "repository", status: "running", retryable: false }, { id: "leftoff", status: "pending", retryable: false }, { id: "registry", status: "pending", retryable: false }, { id: "paseo", status: "pending", retryable: false }], startedAt: new Date().toISOString() }];
  await mkdir(join(root, "orchard"), { recursive: true });
  const m = machine();
  const { jobs: j } = jobs(m, state);
  strictEqual(j.get("j1")!.status, "failed");
  await j.retry("j1");
  strictEqual((await j.settled("j1"))!.status, "done");
});

test("adding a project changes no other room: today's themes are kept, the new one takes a free theme", async () => {
  const a = await tempProject({ id: "harbor", name: "Harbor" });
  const b = await tempProject({ id: "atlas", name: "Atlas" });
  await registerProject("harbor", a.root);
  await registerProject("atlas", b.root);
  const { themeIndexes } = await import("../src/web/public/office.js");
  const before = themeIndexes(["harbor", "atlas"]);
  const { jobs: j, state } = jobs(machine());
  const job = await j.start({ name: "Orchard" }, "web");
  await j.settled(job.id);
  deepStrictEqual([state.themes["harbor"], state.themes["atlas"]], [before.get("harbor"), before.get("atlas")]);
  ok(![before.get("harbor"), before.get("atlas")].includes(state.themes["orchard"]), "a theme nobody has");
});

test("the panel: options, the check, a creation followed to the end, its live event, a retry, and refusals in the panel's terms", async () => {
  const m = machine({ paseo: "absent" });
  const config = ConfigSchema.parse({ language: "en", projects: { root } });
  const state = emptyState();
  let web: WebServer | undefined;
  const j = new ProjectJobs({ config, state: () => state, save: async () => undefined, onChange: (job) => void web?.projectJob(job), run: m.run });
  web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0 }, data: new Data({ config, state: () => state }), feed: new Feed(join(dir, "feed.jsonl")), mirror: new MirrorChannel(new ConsoleChannel(), new Feed(join(dir, "mirror.jsonl"))), projects: j, log: () => undefined });
  await web.start();
  servers.push(web);
  const url = `http://127.0.0.1:${web.port}`;
  const post = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const options = (await (await fetch(`${url}/api/projects/options`)).json()) as any;
  deepStrictEqual([options.nameMax, options.root, options.paseo, options.themes], [60, root, "unavailable", 8]);

  deepStrictEqual(await (await post("/api/projects/check", { name: "Orchard Club" })).json(), { ok: true, id: "orchard-club", folder: join(root, "orchard-club") });
  const bad = await post("/api/projects/check", { name: "x".repeat(61) });
  strictEqual(bad.status, 400);
  deepStrictEqual(await bad.json(), { error: "the name is longer than 60 characters", type: "invalid_name", reason: "too_long" });

  const events: string[] = [];
  const stream = await fetch(`${url}/api/events`);
  const reader = stream.body!.getReader();
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      events.push(new TextDecoder().decode(value));
    }
  })();

  const started = await post("/api/projects", { name: "Orchard Club", private: true });
  strictEqual(started.status, 202);
  const { job } = (await started.json()) as any;
  await j.settled(job.id);
  strictEqual((await loadProject(join(root, "orchard-club"))).config.visibility, "normal", "never private from the panel");
  const listed = (await (await fetch(`${url}/api/projects/jobs`)).json()) as any;
  deepStrictEqual(listed.jobs.map((x: ProjectJob) => [x.id, x.status]), [[job.id, "failed"]]);
  const overview = (await (await fetch(`${url}/api/overview`)).json()) as any;
  const room = overview.projects.find((p: { id: string }) => p.id === "orchard-club");
  deepStrictEqual(room.creation, { jobId: job.id, status: "failed", step: "paseo" });
  strictEqual(typeof room.theme, "number");

  m.paseo = "present";
  const retried = await post(`/api/projects/jobs/${job.id}/retry`, {});
  strictEqual(retried.status, 200);
  await j.settled(job.id);
  strictEqual(((await (await fetch(`${url}/api/projects/jobs/${job.id}`)).json()) as any).job.status, "done");
  await new Promise((r) => setTimeout(r, 50));
  await reader.cancel();
  await reading.catch(() => undefined);
  const live = events.join("");
  match(live, /event: project\ndata: \{[^\n]*"status":"done"/, "the live event carries the whole job");
  match(live, /event: refresh/);

  const again = await post("/api/projects", { name: "Orchard Club" });
  strictEqual(again.status, 409);
  deepStrictEqual(((await again.json()) as any).existing, { kind: "project", id: "orchard-club" });
  strictEqual((await fetch(`${url}/api/projects/jobs/nope`)).status, 404);
});

test("a creation whose project was later made private is not shown", async () => {
  const m = machine();
  const config = ConfigSchema.parse({ language: "en", projects: { root } });
  const state = emptyState();
  const j = new ProjectJobs({ config, state: () => state, save: async () => undefined, run: m.run });
  const job = await j.start({ name: "Orchard" }, "web");
  await j.settled(job.id);
  const project = await loadProject(join(root, "orchard"));
  await writeFile(project.paths.project, (await readFile(project.paths.project, "utf8")).replace("visibility: normal", "visibility: private"), "utf8");
  const web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0 }, data: new Data({ config, state: () => state }), feed: new Feed(join(dir, "feed.jsonl")), mirror: new MirrorChannel(new ConsoleChannel(), new Feed(join(dir, "mirror.jsonl"))), projects: j, log: () => undefined });
  await web.start();
  servers.push(web);
  deepStrictEqual(((await (await fetch(`http://127.0.0.1:${web.port}/api/projects/jobs`)).json()) as any).jobs, []);
  strictEqual((await fetch(`http://127.0.0.1:${web.port}/api/projects/jobs/${job.id}`)).status, 404);
});

test("Paseo's daemon not running is «does not answer»; its refusal is a refusal, in its own words", async () => {
  const say = (stdout: string): RunFn => async (file, args, cwd) => (file === "git" ? machine().run(file, args, cwd) : { stdout });
  const config = ConfigSchema.parse({ projects: { root } });
  const fresh = emptyState();
  const down = new ProjectJobs({ config, state: () => fresh, save: async () => undefined, run: say(JSON.stringify({ error: { code: "DAEMON_NOT_RUNNING", message: "Cannot connect to daemon" } })) });
  strictEqual((await down.options()).paseo, "unavailable");
  const first = await down.start({ name: "Orchard" }, "web");
  strictEqual((await down.settled(first.id))!.steps[4]!.error?.type, "paseo_unavailable");

  const state = emptyState();
  const no = new ProjectJobs({ config, state: () => state, save: async () => undefined, run: async (file, args, cwd) => (file === "git" ? machine().run(file, args, cwd) : args[1] === "ls" ? { stdout: "[]" } : { stdout: JSON.stringify({ error: { code: "WORKSPACE_CREATE_FAILED", message: "Directory not found" } }) }) });
  const second = await no.start({ name: "Atlas" }, "web");
  deepStrictEqual((await no.settled(second.id))!.steps[4]!.error, { type: "paseo_refused", message: "Paseo refused it", detail: "Directory not found" });
});

/** A hub with the jobs attached, a chat thread to talk in, and a PM that runs the tool calls a test gives it. */
async function chat(m: ReturnType<typeof machine>, script: (prompt: string) => Array<[string, Record<string, unknown>]> = () => [], programs = [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }]) {
  const outcomes: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request: RunRequest): Promise<RunResult> {
      for (const [name, input] of script(request.prompt)) outcomes.push((await request.execute(name, input)).content);
      return { text: "Sure.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false }, projects: { root } });
  const hub = new Hub({ config, channel: new ConsoleChannel(), provider, log: () => undefined });
  await hub.tick(new Date());
  const jobs = new ProjectJobs({ config, state: () => hub.state, save: async () => undefined, run: m.run });
  hub.attachProjects(jobs);
  // The panel's own agent maker, pretended: what it was asked to make, and the agent it would answer with.
  const made: Array<{ project: string; input: Record<string, unknown> }> = [];
  hub.attachAgents({
    newAgentOptions: async () => ({ providers: programs }),
    createAgent: async (project, input) => {
      made.push({ project: project.id, input });
      return { agent: { label: String(input.name) } };
    },
  });
  const replies: Array<{ text: string; options?: SendOptions | undefined }> = [];
  const say = async (text: string): Promise<string> => {
    await hub.handle({ text, projectId: null, threadKey: "telegram-1", reply: async (r, options) => void replies.push({ text: r, options }), typing: async () => undefined } satisfies IncomingMessage);
    return replies.at(-1)?.text ?? "";
  };
  const settle = async () => {
    for (const job of hub.state.projectJobs) await jobs.settled(job.id);
    await new Promise((r) => setTimeout(r, 20));
  };
  return { hub, jobs, say, replies, outcomes, settle, made };
}

test("from chat: /newproject shows what will be made with Yes/No; only «yes» makes it, and the end is told (D-056)", async () => {
  const m = machine();
  const { hub, say, replies, settle } = await chat(m);
  const shown = await say("/nuovoprogetto Orchard Club");
  match(shown, /New project «Orchard Club»[\s\S]*orchard-club/);
  ok(replies.at(-1)!.options?.choices, "with Yes/No");
  strictEqual(hub.state.projectJobs.length, 0, "nothing made before the yes");

  match(await say("yes"), /Creating «Orchard Club»/);
  await settle();
  match(replies.at(-1)!.text, /Project «Orchard Club» created/);
  const job = hub.state.projectJobs[0]!;
  deepStrictEqual([job.origin, job.status], ["chat", "done"]);
  await loadProject(join(root, "orchard-club"));
  deepStrictEqual(hub.state.projectDrafts, {}, "used once");
});

test("from chat: «no» drops it; a bad name is told and nothing waits; a second draft in the same thread is refused", async () => {
  const m = machine();
  const { hub, say, replies } = await chat(m);
  await say("/newproject Orchard");
  match(await say("no"), /Dropped\. Nothing was created/);
  strictEqual(hub.state.projectJobs.length, 0);

  match(await say("/newproject " + "x".repeat(61)), /too long/);
  strictEqual(replies.at(-1)!.options, undefined);
  deepStrictEqual(hub.state.projectDrafts, {});

  await say("/newproject Orchard");
  match(await say("/newproject Atlas"), /waits for your yes in this thread/);
  match(await say("/newproject"), /Tell me the name/);
});

test("from chat: the PM can only propose, only what the owner asked for; the owner's yes makes it", async () => {
  const m = machine();
  const { hub, say, replies, outcomes, settle } = await chat(m, (prompt) =>
    prompt.includes("own idea") ? [["propose_new_project", { name: "Shiny", purpose: "", owner_asked: false }]] : prompt.includes("Orchard") ? [["propose_new_project", { name: "Orchard", purpose: "Fruit", owner_asked: true }]] : [],
  );
  await say("any own idea?");
  match(outcomes.at(-1)!, /Refused/);
  deepStrictEqual(hub.state.projectDrafts, {});

  const shown = await say("make a project called Orchard");
  match(shown, /^Sure\.[\s\S]*New project «Orchard»[\s\S]*«Fruit»/);
  ok(replies.at(-1)!.options?.choices);
  await say("sì");
  await settle();
  strictEqual((await loadProject(join(root, "orchard"))).config.purpose, "Fruit");
});

test("from chat: a stopped creation says where, with Retry; the button resumes it", async () => {
  const m = machine({ paseo: "absent" });
  const { hub, say, replies, settle } = await chat(m);
  await say("/newproject Orchard");
  await say("yes");
  await settle();
  const stopped = replies.at(-1)!;
  match(stopped.text, /«Orchard» was made up to the step «Paseo»/);
  const retry = stopped.options?.choices?.[0];
  ok(retry && /^\/newproject --retry /.test(retry.reply));
  m.paseo = "present";
  await say(retry!.reply);
  await settle();
  match(replies.at(-1)!.text, /Project «Orchard» created/);
  strictEqual(hub.state.projectJobs[0]!.status, "done");
});

test("a symlink in the project's place is never followed: not at the folder step, not on a retry", async () => {
  const outside = join(dir, "outside");
  await mkdir(outside, { recursive: true });
  await mkdir(root, { recursive: true });

  // Planted between the check and the folder step: an empty folder elsewhere, in the project's place.
  await symlink(outside, join(root, "orchard"));
  const e = await refused(runStep("folder", { name: "Orchard", id: "orchard", folder: join(root, "orchard"), root }));
  deepStrictEqual(e.existing, { kind: "folder" });
  await rm(join(root, "orchard"));

  // Planted while a creation was stopped, before its retry.
  const m2 = machine({ identity: false });
  const { jobs: j2 } = jobs(m2);
  const second = await j2.start({ name: "Atlas" }, "web");
  strictEqual((await j2.settled(second.id))!.steps[2]!.status, "failed");
  await rm(join(root, "atlas"), { recursive: true });
  await symlink(outside, join(root, "atlas"));
  await j2.retry(second.id);
  const again = (await j2.settled(second.id))!;
  strictEqual(again.status, "failed");
  match(again.steps.find((x) => x.status === "failed")!.error!.message, /not a plain folder/);
  deepStrictEqual(await readdir(outside), [], "nothing written through the link");
});

test("from chat: «Add an agent» asks the role, the name and the program, each with Cancel; only «yes» adds it", async () => {
  const m = machine();
  const { hub, say, replies, settle, made } = await chat(m);
  await say("/newproject Orchard");
  await say("yes");
  await settle();
  const add = replies.at(-1)!.options?.choices?.[0];
  deepStrictEqual(add, { label: "Add an agent", reply: "/newagent orchard" });

  match(await say(add!.reply), /new agent for «Orchard»/);
  const roles = replies.at(-1)!.options!.choices!;
  deepStrictEqual(roles.map((c) => c.reply), ["Backend", "Frontend and UX", "Tests and review", "Documentation", "no"]);
  match(await say("Frontend and UX"), /What is its name\? Tap «Frontend»/);
  deepStrictEqual(replies.at(-1)!.options!.choices!.map((c) => c.reply), ["Frontend", "no"]);
  match(await say("Frontend"), /Which program/);
  deepStrictEqual(replies.at(-1)!.options!.choices!.map((c) => c.reply), ["claude", "codex", "no"]);
  match(await say("codex"), /New agent «Frontend» \(Frontend, UX and usability\) in «Orchard», on Codex/);
  deepStrictEqual(made, [], "nothing made before the yes");

  await say("yes");
  match(replies.at(-1)!.text, /«Frontend» has joined «Orchard»/);
  deepStrictEqual(made, [{ project: "orchard", input: { name: "Frontend", role: "Frontend, UX and usability", provider: "codex" } }]);
  deepStrictEqual(hub.state.agentDrafts, {}, "used once");
});

test("from chat: an agent's role and name can be written; what is not a name or a program is asked again; «no» drops it", async () => {
  const m = machine();
  const { hub, say, replies, settle, made } = await chat(m);
  await say("/newproject Orchard");
  await say("yes");
  await settle();
  match(await say("/newagent"), /Which project\?/, "the general thread names no project");
  await say("/nuovoagente Orchard");
  match(await say("security audits"), /Tap «Security»/);
  match(await say("!!!"), /needs letters or digits/);
  match(await say("Warden"), /Which program/);
  match(await say("vim"), /Tap one of the programs/);
  match(await say("Claude Code"), /New agent «Warden» \(security audits\)/);
  match(await say("which model will it use?"), /^Sure\./, "at the summary, talk is the PM's");
  strictEqual(hub.state.agentDrafts?.["telegram-1"]?.step, "confirm", "and the summary still waits");
  match(await say("/newproject Atlas"), /waits for your yes/, "one yes at a time in a thread");
  match(await say("no"), /No agent was added/);
  deepStrictEqual([made, hub.state.agentDrafts], [[], {}]);
});

test("from chat: with no program on offer the agent is left to the panel; nothing waits", async () => {
  const m = machine();
  const { hub, say, settle, made } = await chat(m, () => [], []);
  await say("/newproject Orchard");
  await say("yes");
  await settle();
  await say("/newagent orchard");
  await say("Backend");
  match(await say("Backend"), /Paseo does not answer/);
  deepStrictEqual([made, hub.state.agentDrafts], [[], {}]);
});

test("from chat: while an agent waits for its «yes», the PM can show nothing else for one; the next «yes» adds only the agent", async () => {
  const m = machine();
  const { hub, say, replies, settle, made, outcomes } = await chat(m, (prompt) =>
    prompt.includes("tell wren")
      ? [["propose_agent_command", { project: "orchard", agent: "wren", prompt: "Write the README.", summary: "README", owner_asked: true, irreversible: false, task: "" }]]
      : prompt.includes("autonomous")
        ? [["set_project_mode", { project: "orchard", mode: "autonomous" }]]
        : prompt.includes("Atlas")
          ? [["propose_new_project", { name: "Atlas", purpose: "", owner_asked: true }]]
          : [],
  );
  await say("/newproject Orchard");
  await say("yes");
  await settle();
  const orchard = await loadProject(join(root, "orchard"));
  ensureAgent(orchard, "wren", "claude-code");
  await saveProject(orchard.root, orchard.config);

  await say("/newagent orchard");
  await say("Backend");
  await say("Backend");
  match(await say("claude"), /New agent «Backend»/);
  for (const ask of ["please tell wren to write the README", "make orchard autonomous", "and a project called Atlas"]) {
    await say(ask);
    match(outcomes.at(-1)!, /waits for (the owner's|your) yes/, ask);
    strictEqual(replies.at(-1)!.options, undefined, `no second Yes/No: ${ask}`);
  }
  deepStrictEqual([hub.state.proposals, hub.state.modeRequests, hub.state.projectDrafts], [{}, {}, {}], "nothing else waits");

  await say("yes");
  deepStrictEqual(made.map((x) => x.input.name), ["Backend"], "the yes added the agent, which was the one thing shown");
  deepStrictEqual(hub.state.agentDrafts, {});
});

test("from chat: in an autonomous project, an instruction that fails to go out is not turned into a draft while an agent waits for its «yes»", async () => {
  const m = machine();
  const { hub, say, replies, settle, made, outcomes } = await chat(m, (prompt) =>
    prompt.includes("tell wren") ? [["propose_agent_command", { project: "orchard", agent: "wren", prompt: "Write the README.", summary: "README", owner_asked: true, irreversible: false, task: "" }]] : [],
  );
  await say("/newproject Orchard");
  await say("yes");
  await settle();
  const orchard = await loadProject(join(root, "orchard"));
  ensureAgent(orchard, "wren", "claude-code");
  await saveProject(orchard.root, orchard.config);
  // Where the agent's inbox would be there is a file: the instruction cannot go out.
  await rm(orchard.paths.inbox, { recursive: true, force: true });
  await mkdir(dirname(orchard.paths.inbox), { recursive: true });
  await writeFile(orchard.paths.inbox, "not a folder", "utf8");
  hub.state.modes.orchard = "autonomous";

  await say("/newagent orchard");
  await say("Backend");
  await say("Backend");
  await say("claude");
  await say("please tell wren to write the README");
  match(outcomes.at(-1)!, /Sending failed, and it is not shown as a draft/);
  strictEqual(replies.at(-1)!.options, undefined, "no second Yes/No");
  deepStrictEqual(hub.state.proposals, {}, "no draft waits behind the agent");

  await say("yes");
  deepStrictEqual(made.map((x) => x.input.name), ["Backend"], "the yes added the agent, the one thing shown");
});

test("from chat: a proposed name longer than a Telegram button's 64 bytes keeps its button: the channel keeps long replies (#57)", async () => {
  const m = machine();
  const { say, replies, settle } = await chat(m);
  await say("/newproject Orchard");
  await say("yes");
  await settle();
  await say("/newagent orchard");
  const long = "测".repeat(30);
  await say(long);
  const use = replies.at(-1)!.options?.choices?.[0];
  ok(use && use.reply === long && Buffer.byteLength(use.reply) > 64, JSON.stringify(use));
});
