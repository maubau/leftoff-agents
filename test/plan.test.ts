import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Channel, IncomingMessage, SendOptions } from "../src/channels/channel.ts";
import { addPlanTask, setTaskStatus, showPlan } from "../src/commands/plan.ts";
import { report } from "../src/commands/report.ts";
import { createTask, dropProposedTask, readTasks, updateTask } from "../src/core/backlog.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { buildBoard } from "../src/web/board.ts";
import { buildSnapshot } from "../src/core/snapshot.ts";
import { Data } from "../src/web/data.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const MAIN = "1a2b3c4d-0000-4000-8000-0000000main1";
const UX = "1a2b3c4d-0000-4000-8000-00000000ux01";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

beforeEach(async () => {
  await isolateHost("leftoff-plan-");
});

class Rec implements Channel {
  readonly name = "rec";
  readonly sent: Array<{ projectId: string | null; text: string }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(projectId: string | null, text: string, _options?: SendOptions): Promise<void> {
    this.sent.push({ projectId, text });
  }
}

/** A pretend Paseo with two idle agents: records what each is sent. */
function fakePaseo() {
  const sent: Record<string, string[]> = { [MAIN]: [], [UX]: [] };
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: MAIN, status: "idle" }, { id: UX, status: "idle" }]) };
    if (args[0] === "send") {
      sent[args[1]!]!.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
      return { stdout: '{"status":"sent"}' };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, sent };
}

/** A model that runs the tool calls the test scripts for each message, and keeps what the tools said. */
function model(script: (prompt: string) => Array<[string, Record<string, unknown>]>) {
  const outcomes: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request: RunRequest): Promise<RunResult> {
      for (const [name, input] of script(request.prompt)) outcomes.push((await request.execute(name, input)).content);
      return { text: "Ok.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  return { provider, outcomes };
}

async function team(): Promise<Project> {
  const p = await tempProject({
    id: "harbor",
    name: "Harbor",
    agents: [
      { id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: MAIN, label: "Harbor Main Dev", role: "architect and backend" },
      { id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX, label: "Harbor UX", role: "frontend and UX" },
    ],
  });
  await registerProject("harbor", p.root);
  return p;
}

async function setup(provider: ModelProvider) {
  const p = await team();
  const paseo = fakePaseo();
  const chat = new Rec();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false }, notify: { quietHours: { enabled: false } } });
  const hub = new Hub({ config, channel: chat, provider, exec: paseo.exec, log: () => undefined });
  const t0 = Date.now();
  await hub.tick(new Date(t0));
  const replies: Array<{ text: string; options?: SendOptions | undefined }> = [];
  const say = async (text: string) => {
    await hub.handle({ text, projectId: "harbor", threadKey: "web-harbor", reply: async (r, options) => void replies.push({ text: r, options }), typing: async () => undefined } satisfies IncomingMessage);
    return replies.at(-1)?.text ?? "";
  };
  return { p, paseo, chat, hub, say, replies, config, at: (m: number) => new Date(t0 + m * 60_000) };
}

test("tasks written at the same moment never share an id; phases, dependencies and edits keep the rest of the file", async () => {
  const p = await team();
  const made = await Promise.all(Array.from({ length: 12 }, (_, i) => createTask(p, { title: `Step ${i}`, description: "d", acceptanceCriteria: ["c"], labels: [], priority: "medium" })));
  strictEqual(new Set(made.map((t) => t.id)).size, 12, "twelve tasks, twelve ids");

  const planned = await createTask(p, { title: "API", description: "The bookings API", acceptanceCriteria: ["GET works"], labels: ["plan:x", "proposed"], priority: "high", assignee: ["main-dev"], dependencies: ["task-1"], milestone: "1 · Design" }, new Date(), { ledger: false });
  const read = (await readTasks(p)).find((t) => t.id === planned.id)!;
  deepStrictEqual([read.milestone, read.dependencies, read.assignee], ["1 · Design", ["TASK-1"], ["main-dev"]]);
  await updateTask(p, planned.id, { milestone: "2 · Build", removeLabels: ["proposed"] });
  const text = await readFile(join(p.root, planned.file), "utf8");
  match(text, /milestone: 2 · Build/);
  match(text, /The bookings API/, "the description is untouched");
  match(text, /priority: high/, "other keys stay");
  strictEqual(await dropProposedTask(p, planned.id, "plan:x"), false, "an approved task is never dropped");
});

test("an agent can only write into a plan the PM asked for, within limits; its tasks show phase by phase", async () => {
  const pm = model((q) => (q.includes("plan") ? [["request_plans", { project: "harbor", goal: "A booking page", agents: ["main-dev", "ux"] }]] : []));
  const { p, hub, say } = await setup(pm.provider);
  await rejects(addPlanTask(p, { agent: "ux", plan: "nope", phase: "1 · Design", title: "x", criteria: [], depends: [] }), /No plan "nope"/);

  await say("let's plan the booking page");
  const planId = hub.state.plans.harbor!.id;
  const t1 = await addPlanTask(p, { agent: "main-dev", plan: planId, phase: "1 · Design", title: "Bookings API contract", criteria: ["Documented"], depends: [] });
  await addPlanTask(p, { agent: "ux", plan: planId, phase: "2 · Build", title: "Booking form", criteria: [], depends: [t1.id] });
  await rejects(addPlanTask(p, { agent: "ux", plan: planId, phase: "1", title: "x", criteria: [], depends: ["not an id"] }), /Not a task id/);
  await rejects(addPlanTask(p, { agent: "ghost", plan: planId, phase: "1", title: "x", criteria: [], depends: [] }), /No agent "ghost"/);
  for (let i = 0; i < 14; i++) await addPlanTask(p, { agent: "ux", plan: planId, phase: "3", title: `t${i}`, criteria: [], depends: [] });
  await rejects(addPlanTask(p, { agent: "ux", plan: planId, phase: "3", title: "one too many", criteria: [], depends: [] }), /already have 15 tasks/);

  const shown = await showPlan(p);
  match(shown, /1 · Design\n  TASK-\d+ \[To Do\] main-dev: Bookings API contract \(proposed\)/);
  match(shown, /2 · Build\n  TASK-\d+ \[To Do\] ux: Booking form ← TASK-\d+ \(proposed\)/);
  strictEqual((await setTaskStatus(p, { agent: "ux", task: t1.id, status: "in progress" })).status, "In Progress");
  await rejects(setTaskStatus(p, { agent: "ux", task: t1.id, status: "maybe" }), /Unknown status/);
});

test("the whole plan: asked by role, told when it is in, consolidated, shown, approved once, and each agent gets its own tasks", async () => {
  let dup = "";
  const pm = model((q) => {
    if (q.includes("let's plan")) return [["request_plans", { project: "harbor", goal: "A booking page", agents: ["main-dev", "ux"] }]];
    if (q.includes("prepare the plan")) return [["read_plan", { project: "harbor" }], ["revise_plan_task", { project: "harbor", task: dup, phase: "", change_depends: false, depends: [], assignee: "", drop: true }], ["submit_plan", { project: "harbor", summary: "Two phases: the API, then the form." }]];
    return [];
  });
  const { p, paseo, chat, hub, say, replies, at } = await setup(pm.provider);
  await say("let's plan the booking page");
  const plan = hub.state.plans.harbor!;
  strictEqual(plan.status, "collecting");
  for (const id of [MAIN, UX]) {
    strictEqual(paseo.sent[id]!.length, 1);
    match(paseo.sent[id]![0]!, new RegExp(`Do not start implementing yet[\\s\\S]*leftoff plan add --agent (main-dev|ux) --plan ${plan.id}`));
  }
  match(pm.outcomes[0]!, /main-dev: asked; ux: asked/);

  await hub.tick(at(5));
  ok(!chat.sent.some((m) => /every agent has sent its part/.test(m.text)), "not before every part is in");
  const api = await addPlanTask(p, { agent: "main-dev", plan: plan.id, phase: "1 · API", title: "Bookings API", criteria: ["GET /api/bookings answers"], depends: [] });
  await addPlanTask(p, { agent: "ux", plan: plan.id, phase: "2 · Form", title: "Booking form", criteria: [], depends: [api.id] });
  dup = (await addPlanTask(p, { agent: "ux", plan: plan.id, phase: "2 · Form", title: "Booking form again", criteria: [], depends: [] })).id;
  await hub.tick(at(10));
  match(chat.sent.at(-1)!.text, /📋 Plan for «A booking page» \(Harbor\): every agent has sent its part, 3 tasks/);

  const shown = await say("prepare the plan");
  match(shown, /📋 Plan for «A booking page» \(Harbor\) — waiting for your approval\nTwo phases: the API, then the form\.\n\n1 · API\n• TASK-\d+ Harbor Main Dev: Bookings API\n\n2 · Form\n• TASK-\d+ Harbor UX: Booking form \(after TASK-\d+\)/);
  ok(!shown.includes("again"), "the duplicate was dropped");
  ok(replies.at(-1)!.options, "Yes/No");
  strictEqual(hub.state.plans.harbor!.status, "shown");

  match(await say("yes"), /✅ Plan approved: «A booking page» \(Harbor\), 2 tasks/);
  strictEqual(hub.state.plans.harbor!.status, "approved");
  ok((await readTasks(p)).filter((t) => t.labels.includes(`plan:${plan.id}`)).every((t) => !t.labels.includes("proposed")), "no longer proposals");
  match(paseo.sent[MAIN]!.at(-1)!, /The plan «A booking page» is approved\. Your tasks, in order:\n- TASK-\d+ \[1 · API\] Bookings API/);
  match(paseo.sent[UX]!.at(-1)!, /- TASK-\d+ \[2 · Form\] Booking form \(after TASK-\d+\)/);
  match(await readFile(join(p.root, ".leftoff", "decisions.md"), "utf8"), /Plan approved: «A booking page» \(2 tasks in 2 phases\)/);
});

test("«no» sends the plan back for revision; after two hours the owner hears who is missing", async () => {
  const pm = model((q) => (q.includes("let's plan") ? [["request_plans", { project: "harbor", goal: "A booking page", agents: ["main-dev", "ux"] }]] : q.includes("show it") ? [["submit_plan", { project: "harbor", summary: "s" }]] : []));
  const { p, chat, hub, say, at } = await setup(pm.provider);
  await say("let's plan the booking page");
  const plan = hub.state.plans.harbor!;
  await addPlanTask(p, { agent: "main-dev", plan: plan.id, phase: "1", title: "API", criteria: [], depends: [] });
  await hub.tick(at(60));
  ok(!chat.sent.some((m) => /still missing/.test(m.text)));
  await hub.tick(at(121));
  match(chat.sent.at(-1)!.text, /1 tasks so far; still missing: Harbor UX/);

  await say("show it to me");
  match(await say("no"), /Plan not approved: tell me what to change/);
  strictEqual(hub.state.plans.harbor!.status, "collecting");
});

test("every instruction shows on the board: a task is opened for it and its answer moves it; one tied to a task moves that one", async () => {
  const pm = model((q) =>
    q.includes("tests") ? [["propose_agent_command", { project: "harbor", agent: "main-dev", prompt: "Run the tests.", summary: "Run the tests", owner_asked: true, irreversible: false, task: "" }]]
    : q.includes("form") ? [["propose_agent_command", { project: "harbor", agent: "ux", prompt: "Build the form.", summary: "Build the form", owner_asked: true, irreversible: false, task: "TASK-1" }]]
    : [],
  );
  const { p, hub, say, at } = await setup(pm.provider);
  await createTask(p, { title: "Booking form", description: "", acceptanceCriteria: [], labels: [], priority: "medium", assignee: ["ux"] });
  await hub.setProjectMode("harbor", "autonomous", "panel");

  await say("tell main-dev to run the tests");
  const auto = (await readTasks(p)).find((t) => t.labels.includes("auto"))!;
  deepStrictEqual([auto.title, auto.status, auto.assignee], ["Run the tests", "In Progress", ["main-dev"]]);
  await report(await loadProject(p.root), { ...base, agent: "main-dev", status: "done", done: ["Tests pass"], at: at(2).toISOString() });
  await hub.tick(at(3));
  strictEqual((await readTasks(p)).find((t) => t.id === auto.id)!.status, "Done", "its answer finished it");

  await say("tell ux to build the form");
  const tasks = await readTasks(p);
  strictEqual(tasks.find((t) => t.id === "TASK-1")!.status, "In Progress");
  strictEqual(tasks.filter((t) => t.labels.includes("auto")).length, 1, "no second task for an instruction that had one");

  const card = buildBoard(await buildSnapshot(await loadProject(p.root))).done.find((c) => c.id === `task:${auto.id}`)!;
  strictEqual(card.auto, true, "the panel can tell automatic work apart");
});

test("the panel gets the plan phase by phase, with who has not answered", async () => {
  const pm = model((q) => (q.includes("let's plan") ? [["request_plans", { project: "harbor", goal: "A booking page", agents: ["main-dev", "ux"] }]] : []));
  const { p, hub, say, config } = await setup(pm.provider);
  await say("let's plan the booking page");
  const plan = hub.state.plans.harbor!;
  await addPlanTask(p, { agent: "main-dev", plan: plan.id, phase: "1 · API", title: "Bookings API", criteria: [], depends: [] });
  const data = new Data({ config, state: () => hub.state, exec: async () => ({ stdout: "[]" }) });
  const web = (await data.detail("harbor"))!.project.plan!;
  deepStrictEqual([web.goal, web.status, web.missing], ["A booking page", "collecting", ["ux"]]);
  deepStrictEqual(web.phases.map((ph) => [ph.name, ph.tasks.map((t) => [t.title, t.agent, t.proposed])]), [["1 · API", [["Bookings API", "main-dev", true]]]]);
});
