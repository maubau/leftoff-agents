import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { beforeEach, test } from "node:test";
import type { IncomingMessage } from "../src/channels/channel.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema, loadConfig } from "../src/core/config.ts";
import { readDecisions } from "../src/core/decisions.ts";
import type { Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { appendOutbox } from "../src/hub/operational.ts";
import type { ModelProvider, RunResult } from "../src/pm/provider.ts";
import { isolateHost, tempProject } from "./helpers.ts";

/**
 * The operational PM (D-064): an invented Paseo agent «ops» in project «hq», following project «harbor», whose team
 * is «ux». Paseo is faked; nothing reaches a model or a real session.
 */
beforeEach(async () => {
  await isolateHost("leftoff-ops-");
});

const OPS = "11111111-1111-4111-8111-111111111111";
const UX = "22222222-2222-4222-8222-222222222222";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

async function setup(options: { vault?: boolean } = {}): Promise<{ hq: Project; harbor: Project; vault?: Project }> {
  const hq = await tempProject({ id: "hq", name: "HQ", agents: [{ id: "ops", control: "paseo", host: "claude-code", paseoAgent: OPS, label: "Ops PM" }] });
  await registerProject("hq", hq.root);
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX }] });
  await registerProject("harbor", harbor.root);
  if (!options.vault) return { hq, harbor };
  const vault = await tempProject({ id: "vault", name: "Vault", visibility: "private" });
  await registerProject("vault", vault.root);
  return { hq, harbor, vault };
}

function fakePaseo(status: Record<string, "idle" | "running" | "closed"> = {}) {
  const sent: Array<{ to: string; text: string }> = [];
  const live = { [OPS]: "idle", [UX]: "idle", ...status } as Record<string, string>;
  const exec = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    strictEqual(file, "paseo");
    if (args[0] === "ls") return { stdout: JSON.stringify(Object.entries(live).map(([id, s]) => ({ id, shortId: id.slice(0, 7), status: s }))) };
    if (args[0] === "send") {
      sent.push({ to: args[1]!, text: await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8") });
      return { stdout: JSON.stringify({ status: "sent" }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, sent, live };
}

function model() {
  const asked: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      asked.push(request.prompt);
      return { text: "The PM answers.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  return { provider, asked };
}

function makeHub(paseo: ReturnType<typeof fakePaseo>, provider: ModelProvider, projects: string[] = ["harbor"]) {
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false }, pm: { operational: { project: "hq", agent: "ops", projects } } });
  const hub = new Hub({ config, channel, provider, exec: paseo.exec, log: () => undefined });
  return { hub, channel, config };
}

function chat(projectId: string | null) {
  const replies: string[] = [];
  const text = (t: string): IncomingMessage => ({ text: t, projectId, threadKey: projectId ?? "general", reply: async (r) => void replies.push(r), typing: async () => undefined });
  return { replies, text };
}

test("in a delegated project the owner's words go to the operational PM, framed, and the model is not asked", async () => {
  await setup();
  const paseo = fakePaseo();
  const pm = model();
  const { hub } = makeHub(paseo, pm.provider);
  await hub.start();
  const c = chat("harbor");
  await hub.handle(c.text("Where are we with the tour?"));
  strictEqual(pm.asked.length, 0);
  strictEqual(paseo.sent.length, 1);
  strictEqual(paseo.sent[0]!.to, OPS);
  match(paseo.sent[0]!.text, /Harbor's thread: «Where are we with the tour\?»/);
  match(paseo.sent[0]!.text, /leftoff pm say --project harbor/);
  match(c.replies.at(-1)!, /Passed to Ops PM/);
  strictEqual(hub.state.awaiting["hq:ops"], undefined, "it answers with pm say, not with a report the hub waits for");

  // A project it does not follow, and the general thread, stay with the PM.
  await hub.handle(chat("hq").text("And here?"));
  await hub.handle(chat(null).text("Anything new?"));
  strictEqual(pm.asked.length, 2);
  strictEqual(paseo.sent.length, 1);
  await hub.stop();
});

test("when the operational PM cannot be reached the PM says so and answers, so the thread never goes silent", async () => {
  await setup();
  const paseo = fakePaseo({ [OPS]: "closed" });
  const pm = model();
  const { hub } = makeHub(paseo, pm.provider);
  await hub.start();
  const c = chat("harbor");
  await hub.handle(c.text("Where are we?"));
  match(c.replies[0]!, /cannot be reached right now/);
  strictEqual(pm.asked.length, 1);
  strictEqual(paseo.sent.length, 0);
  await hub.stop();
});

test("what it hands back: a word reaches the owner in the project's thread; an ask becomes a handoff waiting for a yes", async () => {
  const { harbor } = await setup();
  const paseo = fakePaseo();
  const { hub, channel } = makeHub(paseo, model().provider);
  await hub.start();
  await appendOutbox({ at: "2026-10-24T08:00:00.000Z", project: "harbor", kind: "say", text: "The tour is half done; UX is on step 3." });
  await appendOutbox({ at: "2026-10-24T08:01:00.000Z", project: "harbor", kind: "ask", to: "ux", text: "Add the last two steps of the tour." });
  await appendOutbox({ at: "2026-10-24T08:02:00.000Z", project: "hq", kind: "say", text: "Not mine to say." });
  await hub.tick(new Date());
  const said = channel.sent.map((l) => l.text).join("\n");
  match(said, /🧭 Ops PM \(operational PM\): The tour is half done/);
  ok(!said.includes("Not mine to say"), "a project it does not follow gets nothing");
  const handoff = hub.state.handoffs.find((h) => h.projectId === harbor.id);
  ok(handoff, "the ask is a handoff");
  deepStrictEqual([handoff!.from, handoff!.to, handoff!.ask], ["ops", "ux", "Add the last two steps of the tour."]);
  strictEqual(paseo.sent.length, 0, "nothing reaches UX before the owner's yes");
  // Read once: the next pass sends nothing again.
  await hub.tick(new Date());
  strictEqual(channel.sent.filter((l) => l.text.includes("The tour is half done")).length, 1);
  await hub.stop();
});

test("it is told what happens in its projects, at most every ten minutes, and never its own reports", async () => {
  const { harbor, hq } = await setup();
  const paseo = fakePaseo();
  const { hub } = makeHub(paseo, model().provider);
  await hub.start();
  let now = Date.now();
  await hub.tick(new Date(now));
  await report(harbor, { ...base, agent: "ux", status: "needs_input", question: "Week or month view first?", option: ["Week", "Month"] } as never);
  await report(hq, { ...base, agent: "ops", status: "done", done: ["Read the board"] } as never);
  await hub.tick(new Date((now += 60_000)));
  const told = paseo.sent.filter((s) => s.to === OPS);
  strictEqual(told.length, 1);
  match(told[0]!.text, /Harbor · Ux · needs_input: Week or month view first\? \[Week \/ Month\]/);
  ok(!told[0]!.text.includes("Read the board"));

  await report(harbor, { ...base, agent: "ux", status: "blocked", blocked: ["The map key is missing"] } as never);
  await hub.tick(new Date((now += 60_000)));
  strictEqual(paseo.sent.filter((s) => s.to === OPS).length, 1, "rationed");
  await hub.tick(new Date((now += 10 * 60_000)));
  strictEqual(paseo.sent.filter((s) => s.to === OPS).length, 2);
  match(paseo.sent.at(-1)!.text, /The map key is missing/);
  await hub.stop();
});

test("/delegate hands a project over and back, in config.yaml and in the project's decisions; never a private one", async () => {
  const { hq } = await setup({ vault: true });
  const paseo = fakePaseo();
  const { hub, config } = makeHub(paseo, model().provider, []);
  await hub.start();
  const c = chat(null);
  await hub.handle(c.text("/delegate HQ"));
  match(c.replies.at(-1)!, /HQ is now followed by Ops PM/);
  deepStrictEqual(config.pm.operational.projects, ["hq"]);
  deepStrictEqual((await loadConfig()).pm.operational.projects, ["hq"]);
  match(await readDecisions(hq), /HQ handed to Ops PM/);
  await hub.handle(c.text("/delegate HQ off"));
  deepStrictEqual((await loadConfig()).pm.operational.projects, []);
  await hub.handle(c.text("/delegate Vault"));
  match(c.replies.at(-1)!, /Which project\?/);
  await hub.handle(c.text("/delegate"));
  match(c.replies.at(-1)!, /Operational PM: Ops PM\. Projects it follows: none/);
  await hub.stop();
});

test("leftoff pm say refuses a project the operational PM does not follow", async () => {
  const { hq } = await setup();
  const cli = resolve("src/cli.ts");
  await rejects(promisify(execFile)(process.execPath, [cli, "pm", "say", "--project", "harbor", "hello"], { cwd: hq.root, env: process.env }), (e: { stderr: string }) => (match(e.stderr, /not followed by the operational PM/), true));
});

test("the panel offers the Paseo agents as operational PM, sets one, and hands a project over; nobody takes all back", async () => {
  const { Settings } = await import("../src/web/settings.ts");
  const { harbor } = await setup({ vault: true });
  const paseo = fakePaseo();
  const { hub, config } = makeHub(paseo, model().provider, []);
  config.pm.operational = { projects: [] };
  const settings = new Settings({ config, modes: hub, exec: paseo.exec });
  const offered = (await settings.pm()).operational;
  deepStrictEqual(offered.candidates.map((c) => `${c.project}/${c.agent}`).sort(), ["harbor/ux", "hq/ops"]);
  strictEqual(offered.current, null);
  await rejects(settings.setDelegation(harbor, { on: true }), /no operational PM/);
  await rejects(settings.setPm({ operational: { project: "vault", agent: "x" } }), /not one of the Paseo agents offered/);
  strictEqual((await settings.setPm({ operational: { project: "hq", agent: "ops" } })).operational.current?.name, "Ops PM · HQ");
  deepStrictEqual(await settings.setDelegation(harbor, { on: true }), { delegated: true });
  deepStrictEqual((await loadConfig()).pm.operational, { project: "hq", agent: "ops", projects: ["harbor"] });
  await settings.setPm({ operational: null });
  deepStrictEqual((await loadConfig()).pm.operational, { projects: [] }, "no operational PM, no project left delegated");
});
