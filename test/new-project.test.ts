import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { NewProjectError, planProject, type RunFn } from "../src/commands/new-project.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject } from "../src/core/project.ts";
import { readRegistry, registerProject } from "../src/core/registry.ts";
import { ProjectJobs } from "../src/hub/project-jobs.ts";
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
