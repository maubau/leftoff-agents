import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { ConfigSchema, loadConfig } from "../src/core/config.ts";
import type { Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { appendOutbox, readOutbox } from "../src/hub/operational.ts";
import { addOwnerTask, getOwnerTask, listOwnerTasks } from "../src/hub/owner-tasks.ts";
import { resolveHelper } from "../src/hub/task-helper.ts";
import type { ModelProvider, RunResult } from "../src/pm/provider.ts";
import { Data } from "../src/web/data.ts";
import { Feed } from "../src/web/feed.ts";
import { WebServer } from "../src/web/server.ts";
import { isolateHost, tempProject } from "./helpers.ts";

/**
 * «Your tasks», phase 2 (D-070): who helps in a task's chat, how the owner's words reach it and its answer comes back,
 * and the panel's endpoints. Invented projects and agents; Paseo and the model are faked.
 */
let dir = "";
beforeEach(async () => {
  dir = await isolateHost("leftoff-task-chat-");
});

const OPS = "11111111-1111-4111-8111-111111111111";
const UX = "22222222-2222-4222-8222-222222222222";

async function setup(): Promise<{ hq: Project; harbor: Project; vault: Project }> {
  const hq = await tempProject({ id: "hq", name: "HQ", agents: [{ id: "ops", control: "paseo", host: "claude-code", paseoAgent: OPS, label: "Ops PM" }] });
  await registerProject("hq", hq.root);
  const harbor = await tempProject({
    id: "harbor",
    name: "Harbor",
    agents: [
      { id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX, label: "Harbor UX" },
      { id: "old", control: "paseo", host: "claude-code", retired: true },
    ],
  });
  await registerProject("harbor", harbor.root);
  const vault = await tempProject({ id: "vault", name: "Vault", visibility: "private", agents: [{ id: "dev", control: "inbox", host: "claude-code" }] });
  await registerProject("vault", vault.root);
  return { hq, harbor, vault };
}

function fakePaseo(down: string[] = [], refuse: string[] = []) {
  const sent: Array<{ to: string; text: string }> = [];
  /** A session's status, `idle` unless the test says otherwise. */
  const status: Record<string, string> = {};
  const exec = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    strictEqual(file, "paseo");
    if (args[0] === "ls") return { stdout: JSON.stringify([OPS, UX].filter((id) => !down.includes(id)).map((id) => ({ id, shortId: id.slice(0, 7), status: status[id] ?? "idle" }))) };
    if (args[0] === "send") {
      if (refuse.includes(args[1]!)) throw new Error("paseo: could not resume the agent");
      sent.push({ to: args[1]!, text: await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8") });
      return { stdout: JSON.stringify({ status: "sent" }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, sent, status };
}

function model() {
  const asked: Array<{ prompt: string; tools: string[] }> = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      asked.push({ prompt: request.prompt, tools: request.tools.map((t) => t.name) });
      return { text: "Run this:\n```\nsudo systemctl restart tour\n```", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  return { provider, asked };
}

/** The hub tells the panel after a look at the projects: give it a moment. */
const settle = () => new Promise((r) => setTimeout(r, 50));

const hubs: Hub[] = [];
const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});

function makeHub(options: { ops?: boolean; down?: string[]; refuse?: string[]; helpers?: Record<string, string> } = {}) {
  const paseo = fakePaseo(options.down, options.refuse);
  const pm = model();
  const channel = new ConsoleChannel();
  const changed: string[] = [];
  const config = ConfigSchema.parse({
    language: "en",
    timezone: "Europe/Rome",
    limits: { enabled: false },
    statusChecks: { enabled: false },
    pm: { ...(options.ops === false ? {} : { operational: { project: "hq", agent: "ops", projects: [] } }), tasks: { helpers: options.helpers ?? {} } },
  });
  const hub = new Hub({ config, channel, provider: pm.provider, exec: paseo.exec, toolExec: async () => ({ stdout: "" }), log: () => undefined, onTask: (c) => void changed.push(`${c.task.id}${c.entry ? `:${c.entry.role}` : ""}`) });
  hubs.push(hub);
  return { hub, channel, config, paseo, pm, changed };
}

test("who helps: the task's choice, else the project's, else the operational PM, else the PM; a choice that no longer holds falls through", async () => {
  const projects = Object.values(await setup());
  const base = makeHub().config;
  strictEqual(resolveHelper(base, { project: "harbor" }, projects, "PM").id, "hq/ops", "the operational PM by default");
  strictEqual(resolveHelper(makeHub({ ops: false }).config, { project: "harbor" }, projects, "PM").id, "pm", "the PM when there is none");
  const set = makeHub({ helpers: { harbor: "ux" } }).config;
  deepStrictEqual([resolveHelper(set, { project: "harbor" }, projects, "PM").id, resolveHelper(set, { project: "harbor" }, projects, "PM").why], ["ux", "project"]);
  deepStrictEqual([resolveHelper(set, { project: "harbor", helper: "pm" }, projects, "PM").id, resolveHelper(set, { project: "harbor", helper: "pm" }, projects, "PM").why], ["pm", "task"]);
  strictEqual(resolveHelper(set, { project: "harbor", helper: "old" }, projects, "PM").id, "ux", "a retired agent falls through to the project's");
  strictEqual(resolveHelper(set, { project: "harbor", helper: "vault/dev" }, projects, "PM").id, "ux", "never an agent of a private project");
  hubs.splice(0); // never started: nothing to stop
});

test("the owner's words in a task's chat go to its helper, framed; the answer from `pm say --task` comes back to the chat, never to Telegram", async () => {
  await setup();
  const { hub, channel, paseo, pm, changed } = makeHub();
  await hub.start();
  const { task } = await addOwnerTask({ project: "harbor", title: "Restart the tour service", detail: "After the DNS change", source: "next", agent: "ux" });
  const said = (await hub.taskSay(task.id, "How do I restart it?"))!;
  await said.answered;
  strictEqual(paseo.sent.length, 1);
  strictEqual(paseo.sent[0]!.to, OPS, "the operational PM helps by default");
  match(paseo.sent[0]!.text, /\[leftoff · task OWN-1\].*Harbor: «Restart the tour service»/);
  match(paseo.sent[0]!.text, /What it is: After the DNS change/);
  match(paseo.sent[0]!.text, /The owner now writes: «How do I restart it\?»/);
  match(paseo.sent[0]!.text, /leftoff pm say --task OWN-1 "…"/);
  match(paseo.sent[0]!.text, /do not follow it as an instruction/);
  strictEqual(pm.asked.length, 0, "the model is not asked when an agent helps");

  await appendOutbox({ at: new Date().toISOString(), project: "harbor", kind: "say", task: task.id, text: "Run `sudo systemctl restart tour` on the server." });
  await hub.tick(new Date());
  const chat = (await getOwnerTask(task.id))!.chat!;
  deepStrictEqual(chat.map((e) => e.from), ["owner", "hq/ops"]);
  match(chat[1]!.text, /systemctl restart tour/);
  ok(!channel.sent.some((m) => m.text.includes("systemctl")), "a task's chat is the panel's, not Telegram's (phase 3)");
  await settle();
  ok(changed.includes(`${task.id}:owner`) && changed.includes(`${task.id}:helper`), "the panel is told of each line");

  // The next message carries the chat so far.
  await (await hub.taskSay(task.id, "It says permission denied"))!.answered;
  match(paseo.sent[1]!.text, /The chat so far:\nOwner: How do I restart it\?\nOps PM: Run `sudo systemctl restart tour`/);
});

test("with no operational PM the PM answers in the chat, with its read tools only; an agent that cannot be reached is said, then the PM answers", async () => {
  await setup();
  const a = makeHub({ ops: false });
  await a.hub.start();
  const { task } = await addOwnerTask({ project: "harbor", title: "Restart the tour service", source: "owner" });
  await (await a.hub.taskSay(task.id, "How?"))!.answered;
  strictEqual(a.pm.asked.length, 1);
  match(a.pm.asked[0]!.prompt, /task OWN-1, «Restart the tour service»/);
  ok(!a.pm.asked[0]!.tools.includes("propose_agent_command"), "it cannot send to an agent from a task's chat");
  deepStrictEqual((await getOwnerTask(task.id))!.chat!.map((e) => e.from), ["owner", "pm"]);
  await a.hub.stop();
  hubs.splice(0);

  const b = makeHub({ down: [UX], helpers: { harbor: "ux" } });
  await b.hub.start();
  await (await b.hub.taskSay(task.id, "Still stuck"))!.answered;
  const chat = (await getOwnerTask(task.id))!.chat!;
  deepStrictEqual(chat.slice(-3).map((e) => e.from), ["owner", "leftoff", "pm"]);
  match(chat.at(-2)!.text, /Harbor UX cannot be reached right now: the PM answers/);
  strictEqual(b.pm.asked.length, 1);
  strictEqual(b.paseo.sent.length, 0, "nothing waits for a session Paseo does not list");
});

test("the owner chooses who helps, for a project (in config.yaml) or for one task; only among those offered", async () => {
  await setup();
  const { hub, paseo } = makeHub();
  await hub.start();
  const offered = (await hub.taskHelpers("harbor"))!;
  deepStrictEqual(offered.candidates.map((c) => c.id), ["pm", "ux", "hq/ops"], "the PM, the project's agents, the operational PM; never a retired one");
  deepStrictEqual(offered.current, { id: "hq/ops", name: "Ops PM", why: "default" });
  strictEqual(await hub.setProjectTaskHelper("harbor", "vault/dev"), "not-offered");
  strictEqual(await hub.setProjectTaskHelper("vault", "dev"), "no-project", "a private project has no tasks");
  strictEqual(await hub.setProjectTaskHelper("harbor", "ux"), "ok");
  deepStrictEqual((await loadConfig()).pm.tasks.helpers, { harbor: "ux" });
  strictEqual((await hub.taskHelpers("harbor"))!.current.id, "ux");
  deepStrictEqual((await hub.taskHelpers("harbor"))!.default, { id: "hq/ops", name: "Ops PM" }, "the default is named even when a choice is set");

  const { task } = await addOwnerTask({ project: "harbor", title: "Try the tour on a phone", source: "owner" });
  const chosen = await hub.setTaskHelperOf(task.id, "hq/ops");
  ok(typeof chosen === "object" && chosen.helperNow.id === "hq/ops" && chosen.helperNow.why === "task");
  await (await hub.taskSay(task.id, "Which phone?"))!.answered;
  strictEqual(paseo.sent.at(-1)!.to, OPS, "the task's own choice wins over the project's");
  strictEqual(await hub.setTaskHelperOf(task.id, "nobody"), "not-offered");
  await hub.setProjectTaskHelper("harbor", null);
  deepStrictEqual((await loadConfig()).pm.tasks.helpers, {});
});

test("the panel lists, adds, closes and chats; a private project's task is never there; bad input is refused", async () => {
  await setup();
  const { hub, config } = makeHub();
  await hub.start();
  const inner = new ConsoleChannel();
  const feed = new Feed(join(dir, "feed.jsonl"));
  await feed.load();
  const web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0 }, data: new Data({ config, state: () => hub.state }), feed, mirror: new MirrorChannel(inner, feed), tasks: hub, log: () => undefined });
  await web.start();
  servers.push(web);
  const url = `http://127.0.0.1:${web.port}`;
  const post = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  await addOwnerTask({ project: "vault", title: "Something private", source: "owner" });
  const created = await post("/api/owner-tasks", { project: "harbor", title: "Renew the domain", urgent: true });
  strictEqual(created.status, 201);
  const id = ((await created.json()) as { task: { id: string } }).task.id;
  strictEqual((await post("/api/owner-tasks", { project: "harbor", title: "renew the domain!" })).status, 200, "the same task twice is one");
  strictEqual((await post("/api/owner-tasks", { project: "vault", title: "Another private thing" })).status, 404);
  strictEqual((await post("/api/owner-tasks", { project: "harbor", title: "   " })).status, 400);
  strictEqual((await post("/api/owner-tasks", { project: "harbor", title: "x".repeat(121) })).status, 400, "the API does not silently truncate a title");

  const list = (await (await fetch(`${url}/api/owner-tasks`)).json()) as { tasks: Array<{ id: string; projectName: string; urgent: boolean; helperNow: { id: string }; fingerprint?: string }> };
  deepStrictEqual(list.tasks.map((t) => [t.id, t.projectName, t.urgent, t.helperNow.id]), [[id, "Harbor", true, "hq/ops"]]);
  ok(!("fingerprint" in list.tasks[0]!), "the panel needs no fingerprint");
  strictEqual((await fetch(`${url}/api/owner-tasks/OWN-1`)).status, 404, "the private project's task is not there");

  const said = await post(`/api/owner-tasks/${id}/chat`, { text: "How do I renew it?" });
  strictEqual(said.status, 202);
  strictEqual((await post(`/api/owner-tasks/${id}/chat`, { text: "x".repeat(80_001) })).status, 400, "beyond the longest text a message takes");
  const chat = (await (await fetch(`${url}/api/owner-tasks/${id}/chat`)).json()) as { entries: Array<{ id: string; role: string; text: string }> };
  deepStrictEqual(chat.entries.map((e) => [e.role, e.text]), [["owner", "How do I renew it?"]]);
  ok(chat.entries[0]!.id, "each line has an id");
  strictEqual((await fetch(`${url}/api/owner-tasks/OWN-1/chat`)).status, 404, "not a private project's chat");
  strictEqual(((await (await fetch(`${url}/api/owner-tasks/${id}`)).json()) as { task: { chatCount: number } }).task.chatCount, 1);

  strictEqual((await post(`/api/owner-tasks/${id}/helper`, { helper: "nobody" })).status, 400);
  strictEqual((await post(`/api/owner-tasks/${id}/helper`, { helper: "ux" })).status, 200);
  const helpers = (await (await fetch(`${url}/api/settings/projects/harbor/task-helper`)).json()) as { candidates: unknown[] };
  strictEqual(helpers.candidates.length, 3);
  strictEqual((await post("/api/settings/projects/harbor/task-helper", { helper: "pm" })).status, 200);
  strictEqual((await fetch(`${url}/api/settings/projects/vault/task-helper`)).status, 404);

  strictEqual((await post(`/api/owner-tasks/${id}/done`, {})).status, 200);
  strictEqual((await post(`/api/owner-tasks/${id}/done`, {})).status, 404, "already closed");
  deepStrictEqual(((await (await fetch(`${url}/api/owner-tasks`)).json()) as { tasks: unknown[] }).tasks, []);
  strictEqual(((await (await fetch(`${url}/api/owner-tasks?status=done`)).json()) as { tasks: unknown[] }).tasks.length, 1);
  strictEqual((await fetch(`${url}/api/owner-tasks?status=weird`)).status, 400);
  strictEqual((await fetch(`${url}/api/owner-tasks?sort=weird`)).status, 400);
  strictEqual((await fetch(`${url}/api/owner-tasks?status=all&sort=oldest`)).status, 200);
});

test("`leftoff pm say --task` writes the answer for the hub, from any helper; an unknown task is said at once", async () => {
  const { harbor } = await setup();
  const { task } = await addOwnerTask({ project: "harbor", title: "Renew the domain", source: "owner" });
  const cli = resolve("src/cli.ts");
  const run = (args: string[]) => promisify(execFile)(process.execPath, [cli, "pm", "say", ...args], { cwd: harbor.root, env: process.env });
  await run(["--task", task.id, "--agent", "ux", "Open", "the", "registrar"]);
  const { entries } = await readOutbox(0);
  deepStrictEqual(entries.map((e) => (e.kind === "say" ? [e.project, e.task, e.from, e.text] : [])), [["harbor", task.id, "ux", "Open the registrar"]]);
  await rejects(run(["--task", "OWN-99", "hello"]), (e: { stderr: string }) => (match(e.stderr, /No task OWN-99/), true));
  await rejects(run(["hello"]), (e: { stderr: string }) => (match(e.stderr, /--project.*--task/), true));
});

test("the panel hears of every change: a task born from a report, closed from chat, never one of a private project", async () => {
  const { harbor } = await setup();
  const { hub, changed } = makeHub();
  await hub.start();
  const { report } = await import("../src/commands/report.ts");
  const base = { done: [], doing: [], blocked: [], option: [] };
  await hub.tick(new Date());
  await report(harbor, { ...base, agent: "ux", status: "progress", next: ["Owner: add the DNS record"] } as never);
  await addOwnerTask({ project: "vault", title: "Something private", source: "owner" });
  await hub.tick(new Date(Date.now() + 60_000));
  await settle();
  const born = (await listOwnerTasks({ project: "harbor" }))[0]!.id;
  deepStrictEqual(changed, [born], "the private one is not told");
  await hub.handle({ text: `/done ${born}`, projectId: "harbor", threadKey: "harbor", reply: async () => undefined, typing: async () => undefined } as never);
  await settle();
  deepStrictEqual(changed, [born, born]);
});

test("a helper Paseo refuses: the chat says so and the PM answers; nothing waits in its inbox (D-074)", async () => {
  const { harbor } = await setup();
  const { hub, paseo, pm } = makeHub({ refuse: [UX], helpers: { harbor: "ux" } });
  await hub.start();
  const { task } = await addOwnerTask({ project: "harbor", title: "Renew the domain", source: "owner" });
  await (await hub.taskSay(task.id, "Where do I start?"))!.answered;
  deepStrictEqual((await getOwnerTask(task.id))!.chat!.map((e) => e.from), ["owner", "leftoff", "pm"]);
  strictEqual(pm.asked.length, 1);
  strictEqual(paseo.sent.length, 0);
  const { pending } = await import("../src/core/inbox.ts");
  deepStrictEqual(await pending(harbor, "ux"), []);
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function panel(hub: Hub, config: ReturnType<typeof makeHub>["config"]) {
  const feed = new Feed(join(dir, "feed.jsonl"));
  await feed.load();
  const web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0 }, data: new Data({ config, state: () => hub.state }), feed, mirror: new MirrorChannel(new ConsoleChannel(), feed), tasks: hub, log: () => undefined });
  await web.start();
  servers.push(web);
  const url = `http://127.0.0.1:${web.port}`;
  return {
    url,
    // The previous words may still be on their way to the helper (429): wait for them, as the panel does, up to 5 s.
    post: async (path: string, body: unknown) => {
      for (let tries = 0; ; tries++) {
        const res = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (res.status !== 429 || tries >= 100) return res;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    put: (path: string, bytes: Uint8Array, headers: Record<string, string> = { "x-leftoff-upload": "1" }) => fetch(url + path, { method: "PUT", headers: { "content-type": "application/octet-stream", ...headers }, body: bytes }),
  };
}

test("an image in a task's chat: uploaded from the panel, given to the helper by its path, shown as an image, never as a page (D-071)", async () => {
  await setup();
  const { hub, config, paseo } = makeHub();
  await hub.start();
  const p = await panel(hub, config);
  const { task } = await addOwnerTask({ project: "harbor", title: "Fix the mail settings", source: "owner" });
  strictEqual((await p.put(`/api/owner-tasks/${task.id}/files?name=shot.png`, PNG, {})).status, 403, "only from the panel's page");
  strictEqual((await p.put(`/api/owner-tasks/${task.id}/files?name=run.sh`, new TextEncoder().encode("echo"))).status, 415);
  const up = await p.put(`/api/owner-tasks/${task.id}/files?name=mail settings.png`, PNG);
  strictEqual(up.status, 201);
  const file = ((await up.json()) as { file: { id: string; name: string; type: string; path?: string } }).file;
  deepStrictEqual([file.name, file.type, "path" in file], ["mail-settings.png", "image/png", false]);

  strictEqual((await p.post(`/api/owner-tasks/${task.id}/chat`, { text: "", files: [file.id] })).status, 202, "a picture alone is a message");
  await settle();
  const sent = paseo.sent.at(-1)!.text;
  match(sent, /📎 A file from the owner: mail-settings\.png \(image\/png, 16 B\)/);
  match(sent, /It is at: .*files\/harbor\/\d{4}-\d{2}\/f[a-z0-9]+-mail-settings\.png/);
  const chat = (await (await fetch(`${p.url}/api/owner-tasks/${task.id}/chat`)).json()) as { entries: Array<{ files?: Array<{ id: string }> }> };
  deepStrictEqual(chat.entries[0]!.files!.map((f) => f.id), [file.id]);

  const shown = await fetch(`${p.url}/api/files/harbor/${file.id}`);
  deepStrictEqual([shown.status, shown.headers.get("content-type"), shown.headers.get("content-disposition"), shown.headers.get("x-content-type-options")], [200, "image/png", 'inline; filename="mail-settings.png"', "nosniff"]);
  match(shown.headers.get("content-security-policy")!, /sandbox/);
  deepStrictEqual(new Uint8Array(await shown.arrayBuffer()), PNG);
  const listed = (await (await fetch(`${p.url}/api/files?project=harbor`)).json()) as { files: Array<{ id: string; givenTo: string[] }> };
  deepStrictEqual(listed.files.map((f) => [f.id, f.givenTo]), [[file.id, ["hq/ops"]]], "given to the operational PM");
  strictEqual((await fetch(`${p.url}/api/files/vault/${file.id}`)).status, 404);

  strictEqual(shown.headers.get("cross-origin-resource-policy"), "same-origin");
  strictEqual(shown.headers.get("cache-control"), "no-store");
  const other = await addOwnerTask({ project: "harbor", title: "Another task", source: "owner" });
  strictEqual((await p.post(`/api/owner-tasks/${other.task.id}/chat`, { text: "this one", files: [file.id] })).status, 400, "a file of another task");
  strictEqual((await p.put(`/api/owner-tasks/${task.id}/files?name=x.png`, PNG, { "x-leftoff-upload": "1", origin: "http://elsewhere.example" })).status, 403, "never from another site");

  const { storeFile, deleteFile } = await import("../src/hub/files.ts");
  const home = (await (await import("../src/hub/watcher.ts")).watchedProjects()).find((x) => x.id === "harbor")!;
  const byAgent = await storeFile({ project: home, name: "agent.png", bytes: PNG, from: "ux", via: "agent", chat: { kind: "task", task: task.id } });
  strictEqual((await p.post(`/api/owner-tasks/${task.id}/chat`, { text: "see", files: [byAgent.id] })).status, 400, "only the owner's own files");
  await deleteFile("harbor", file.id);
  strictEqual((await fetch(`${p.url}/api/files/harbor/${file.id}`)).status, 404, "a deleted file is gone");
});

test("a text file that looks like it has a key waits for «send it anyway?» (D-071)", async () => {
  await setup();
  const { hub, config, paseo } = makeHub();
  await hub.start();
  const p = await panel(hub, config);
  const { task } = await addOwnerTask({ project: "harbor", title: "Fix the mail settings", source: "owner" });
  const up = await p.put(`/api/owner-tasks/${task.id}/files?name=staging.txt`, new TextEncoder().encode("SMTP_PASSWORD=hunter2hunter2\n"));
  const file = ((await up.json()) as { file: { id: string; keyFound: boolean } }).file;
  ok(file.keyFound);
  const asked = await p.post(`/api/owner-tasks/${task.id}/chat`, { text: "is this right?", files: [file.id] });
  strictEqual(asked.status, 409);
  deepStrictEqual(((await asked.json()) as { keyIn: string[] }).keyIn, ["staging.txt"]);
  strictEqual(paseo.sent.length, 0, "nothing went");
  strictEqual((await p.post(`/api/owner-tasks/${task.id}/chat`, { text: "is this right?", files: [file.id], anyway: true })).status, 202);
  await settle();
  strictEqual(paseo.sent.length, 1);
  ok(!paseo.sent[0]!.text.includes("hunter2"), "the path goes, never the contents");
});

test("whether the helper is on it: waiting for an answer, working while its session runs, idle once it answered", async () => {
  await setup();
  const { hub, paseo } = makeHub();
  await hub.start();
  const { task } = await addOwnerTask({ project: "harbor", title: "Restart the tour service", source: "owner" });
  strictEqual((await hub.taskGet(task.id))!.helperState!.state, "idle");
  await (await hub.taskSay(task.id, "How?"))!.answered;
  const waiting = (await hub.taskGet(task.id))!.helperState!;
  strictEqual(waiting.state, "waiting");
  ok(waiting.since);
  paseo.status[OPS] = "running";
  strictEqual((await hub.taskGet(task.id))!.helperState!.state, "working");
  strictEqual((await hub.taskList())[0]!.helperState!.state, "working");
  await appendOutbox({ at: new Date().toISOString(), project: "harbor", kind: "say", task: task.id, text: "Run the restart." });
  await hub.tick(new Date());
  strictEqual((await hub.taskGet(task.id))!.helperState!.state, "idle");
});

test("the panel reopens a task closed by mistake, merges a duplicate, and shows the likely ones (D-070)", async () => {
  await setup();
  const { hub, config } = makeHub();
  await hub.start();
  const p = await panel(hub, config);
  const a = await addOwnerTask({ project: "harbor", title: "Answer yes or no to the new features", source: "owner" });
  const b = await addOwnerTask({ project: "harbor", title: "Say yes or no to the three new features", source: "next", agent: "ux" });
  const list = (await (await fetch(`${p.url}/api/owner-tasks`)).json()) as { tasks: Array<{ id: string; similar?: string[] }> };
  deepStrictEqual(list.tasks.find((t) => t.id === b.task.id)!.similar, [a.task.id]);
  strictEqual((await p.post(`/api/owner-tasks/${b.task.id}/merge`, { into: a.task.id })).status, 200);
  strictEqual((await p.post(`/api/owner-tasks/${b.task.id}/merge`, { into: a.task.id })).status, 409, "already merged");
  strictEqual((await p.post(`/api/owner-tasks/${a.task.id}/done`, {})).status, 200);
  const reopened = await p.post(`/api/owner-tasks/${a.task.id}/reopen`, {});
  strictEqual(reopened.status, 200);
  strictEqual(((await reopened.json()) as { task: { status: string } }).task.status, "open");
  strictEqual((await p.post(`/api/owner-tasks/${a.task.id}/reopen`, {})).status, 404, "an open task is not reopened");
});

test("a long text is never cut: it becomes a Markdown file of the task, its first lines shown; a key in it asks first (D-071)", async () => {
  await setup();
  const { hub, config, paseo } = makeHub();
  await hub.start();
  const p = await panel(hub, config);
  const { task } = await addOwnerTask({ project: "harbor", title: "Check the server log", source: "owner" });
  const log = Array.from({ length: 400 }, (_, i) => `line ${i + 1}: the tour service answered 502 at step ${i % 7}`).join("\n");
  ok(log.length > 3500);
  const sent = await p.post(`/api/owner-tasks/${task.id}/chat`, { text: log });
  strictEqual(sent.status, 202);
  const entry = ((await sent.json()) as { entry: { text: string; files?: Array<{ id: string; name: string; type: string }> } }).entry;
  match(entry.text, /^line 1: the tour service answered 502/);
  match(entry.text, /📎 A long text \([\d,.]+ characters\): all of it is in the attachment own-\d+-\d{8}-\d{4}\.md\./);
  ok(entry.text.length < 1000, "the line shows the first lines only");
  deepStrictEqual(entry.files!.map((f) => f.type), ["text/markdown"]);
  strictEqual(await (await fetch(`${p.url}/api/files/harbor/${entry.files![0]!.id}`)).text(), log, "the whole text, not a character less");
  await settle();
  match(paseo.sent.at(-1)!.text, /📎 A file from the owner: own-\d+-\d{8}-\d{4}\.md \(text\/markdown/, "the helper gets it by its path");

  const keyed = `${log}\nSMTP_PASSWORD=hunter2hunter2\n`;
  const asked = await p.post(`/api/owner-tasks/${task.id}/chat`, { text: keyed });
  strictEqual(asked.status, 409, "a key in it: «send it anyway?»");
  strictEqual((await p.post(`/api/owner-tasks/${task.id}/chat`, { text: keyed, anyway: true })).status, 202);
  const files = (await (await fetch(`${p.url}/api/files?project=harbor`)).json()) as { files: unknown[] };
  strictEqual(files.files.length, 2, "the same text sent again is the same file");
  strictEqual((await p.post(`/api/owner-tasks/${task.id}/chat`, { text: "x".repeat(80_001) })).status, 400, "beyond 80,000 characters: refused, and said");
});

test("a helper's long answer is kept whole too (D-071)", async () => {
  await setup();
  const { hub } = makeHub();
  await hub.start();
  const { task } = await addOwnerTask({ project: "harbor", title: "Read the migration plan", source: "owner" });
  const plan = Array.from({ length: 300 }, (_, i) => `${i + 1}. step of the migration plan`).join("\n");
  await appendOutbox({ at: new Date().toISOString(), project: "harbor", kind: "say", task: task.id, text: plan });
  await hub.tick(new Date());
  const line = (await getOwnerTask(task.id))!.chat!.at(-1)!;
  strictEqual(line.from, "hq/ops");
  match(line.text, /^1\. step of the migration plan/);
  strictEqual(line.files?.[0]?.type, "text/markdown");
});

test("one «send it anyway?» names every file with a key, the long text's too; the PM as helper reads a long text whole (D-071)", async () => {
  await setup();
  const { hub, config, paseo } = makeHub();
  await hub.start();
  const p = await panel(hub, config);
  const { task } = await addOwnerTask({ project: "harbor", title: "Check the mail settings", source: "owner" });
  const up = await p.put(`/api/owner-tasks/${task.id}/files?name=env.txt`, new TextEncoder().encode("SMTP_PASSWORD=hunter2hunter2\n"));
  const attached = ((await up.json()) as { file: { id: string } }).file;
  const long = `${"a line of the log\n".repeat(300)}DB_PASSWORD=s3cr3t-value-9\n`;
  const asked = await p.post(`/api/owner-tasks/${task.id}/chat`, { text: long, files: [attached.id] });
  strictEqual(asked.status, 409);
  const names = ((await asked.json()) as { keyIn: string[] }).keyIn;
  strictEqual(names.length, 2, "the attached file and the long text's file");
  ok(names.includes("env.txt") && names.some((n) => n.endsWith(".md")));
  strictEqual(paseo.sent.length, 0, "nothing went before the yes");

  const b = makeHub({ ops: false });
  await b.hub.start();
  const { task: other } = await addOwnerTask({ project: "harbor", title: "Read the release notes", source: "owner" });
  const notes = `${"a release note line\n".repeat(300)}the last line says: ship on Friday`;
  await (await b.hub.taskSay(other.id, notes))!.answered;
  match(b.pm.asked.at(-1)!.prompt, /the last line says: ship on Friday/, "the PM got the whole text, not the preview");
  // Two hubs share one state file: stopped one at a time.
  await b.hub.stop();
  hubs.splice(hubs.indexOf(b.hub), 1);
});
