import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import { deliverToSession } from "../src/agents/delivery.ts";
import type { Channel, IncomingMessage, SendOptions } from "../src/channels/channel.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { pending } from "../src/core/inbox.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub, type Contact } from "../src/hub/hub.ts";
import { loadState } from "../src/hub/state.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const MAIN = "6f1d2c3b-0000-4000-8000-00000000main";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

beforeEach(async () => {
  await isolateHost("leftoff-queue-");
});

class Rec implements Channel {
  readonly name = "rec";
  readonly sent: Array<{ projectId: string | null; text: string; options?: SendOptions | undefined }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(projectId: string | null, text: string, options?: SendOptions): Promise<void> {
    this.sent.push({ projectId, text, options });
  }
}

/** A pretend Paseo whose agent works until the test lets it stop; it fails the test if anything is sent to it while it works. */
function fakePaseo(options: { refuse?: boolean } = {}) {
  const sent: string[] = [];
  const agent = { status: "running" as "running" | "idle" | "closed", listed: true };
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "ls") return { stdout: JSON.stringify(agent.listed ? [{ id: MAIN, shortId: "6f1d2c3", status: agent.status }] : [{ id: "someone-else", status: "idle" }]) };
    if (args[0] === "send") {
      ok(agent.status !== "running", "never sent to a working agent: Paseo would interrupt its turn");
      if (options.refuse) throw new Error("daemon busy");
      sent.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
      return { stdout: '{"status":"sent"}' };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, sent, agent };
}

function model(script: (prompt: string) => Array<[string, Record<string, unknown>]> = () => []): ModelProvider {
  return {
    id: "fake",
    model: "fake",
    async run(request: RunRequest): Promise<RunResult> {
      for (const [name, input] of script(request.prompt)) await request.execute(name, input);
      return { text: "Noted.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
}

async function team(): Promise<Project> {
  const p = await tempProject({
    id: "harbor",
    name: "Harbor",
    agents: [
      { id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: MAIN, label: "Harbor Main Dev", role: "backend" },
      { id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX", role: "frontend" },
    ],
  });
  await registerProject("harbor", p.root);
  return p;
}

async function setup(paseo = fakePaseo(), provider = model()) {
  const p = await team();
  const chat = new Rec();
  const contacts: Contact[] = [];
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false }, notify: { quietHours: { enabled: false } } });
  const hub = new Hub({ config, channel: chat, provider, exec: paseo.exec, onContact: (c) => contacts.push(c), log: () => undefined });
  const t0 = Date.now();
  await hub.tick(new Date(t0));
  const replies: string[] = [];
  const say = async (text: string) => {
    await hub.handle({ text, projectId: "harbor", threadKey: "t", reply: async (r) => void replies.push(r), typing: async () => undefined } satisfies IncomingMessage);
    return replies.at(-1) ?? "";
  };
  return { p, chat, hub, say, contacts, config, at: (m: number) => new Date(t0 + m * 60_000) };
}

test("an approved instruction to a working agent waits for its turn to end, then goes out and the owner is told", async () => {
  const paseo = fakePaseo();
  const { hub, say, chat, contacts } = await setup(paseo, model((q) => (q.includes("tests") ? [["propose_agent_command", { project: "harbor", agent: "main-dev", prompt: "Run the tests.", summary: "tests", owner_asked: true, irreversible: false }]] : [])));
  match(await say("tell main-dev to run the tests"), /Working now: I give it this when its current turn ends, without interrupting it/);
  match(await say("yes"), /It is working: I give it this when its current turn ends, without interrupting it/);
  deepStrictEqual(paseo.sent, []);
  strictEqual(hub.state.awaiting["harbor:main-dev"], undefined, "the report of the turn in progress is not the answer to it");
  deepStrictEqual(contacts, []);

  paseo.agent.status = "idle";
  await hub.flushDeliveries();
  deepStrictEqual(paseo.sent, ["Run the tests."]);
  ok(hub.state.awaiting["harbor:main-dev"], "from now on its next report is the answer");
  deepStrictEqual(contacts, [{ project: "harbor", agent: "main-dev", kind: "command" }]);
  match(chat.sent.at(-1)!.text, /📨 Delivered to Harbor Main Dev \(Harbor\): it had finished its turn/);
  await hub.flushDeliveries();
  strictEqual(paseo.sent.length, 1, "delivered once");
});

test("autonomous: a teammate's handoff to a working agent is queued too, and its answer still goes back", async () => {
  const paseo = fakePaseo();
  const { p, hub, at } = await setup(paseo);
  await hub.setProjectMode("harbor", "autonomous", "panel");
  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["main-dev: expose GET /api/bookings"], at: at(1).toISOString() });
  await hub.tick(at(2));
  deepStrictEqual(paseo.sent, []);
  strictEqual(hub.state.deliveryQueue[0]?.kind, "handoff");
  paseo.agent.status = "idle";
  await hub.tick(at(3));
  strictEqual(paseo.sent.length, 1);
  match(paseo.sent[0]!, /expose GET \/api\/bookings/);
  strictEqual(hub.state.handoffReplies["harbor:main-dev"], "ux");
});

test("the queue survives a restart of the hub", async () => {
  const paseo = fakePaseo();
  const { hub, say, config } = await setup(paseo, model((q) => (q.includes("tests") ? [["propose_agent_command", { project: "harbor", agent: "main-dev", prompt: "Run the tests.", summary: "tests", owner_asked: true, irreversible: false }]] : [])));
  await say("tell main-dev to run the tests");
  await say("yes");
  await hub.stop();
  strictEqual((await loadState())!.deliveryQueue.length, 1);
  const again = new Hub({ config, channel: new Rec(), exec: paseo.exec, log: () => undefined });
  await again.start();
  try {
    paseo.agent.status = "idle";
    await again.flushDeliveries();
    deepStrictEqual(paseo.sent, ["Run the tests."]);
  } finally {
    await again.stop();
  }
});

test("a session that closed gets the instruction in its inbox; one Paseo keeps refusing goes there after a few tries", async () => {
  const paseo = fakePaseo();
  const { p, hub, say } = await setup(paseo, model((q) => (q.includes("tests") ? [["propose_agent_command", { project: "harbor", agent: "main-dev", prompt: "Run the tests.", summary: "tests", owner_asked: true, irreversible: false }]] : [])));
  await say("tell main-dev to run the tests");
  await say("yes");
  paseo.agent.status = "closed";
  await hub.flushDeliveries();
  deepStrictEqual(paseo.sent, []);
  deepStrictEqual((await pending(await loadProject(p.root), "main-dev")).map((m) => m.text), ["Run the tests."]);
  deepStrictEqual(hub.state.deliveryQueue, []);

  const refusing = fakePaseo({ refuse: true });
  const second = await setup(refusing, model((q) => (q.includes("lint") ? [["propose_agent_command", { project: "harbor", agent: "main-dev", prompt: "Run the linter.", summary: "lint", owner_asked: true, irreversible: false }]] : [])));
  await second.say("tell main-dev to run the lint");
  await second.say("yes");
  refusing.agent.status = "idle";
  for (let i = 0; i < 4; i++) await second.hub.flushDeliveries();
  strictEqual(second.hub.state.deliveryQueue.length, 1, "retried");
  await second.hub.flushDeliveries();
  deepStrictEqual(second.hub.state.deliveryQueue, []);
  ok((await pending(await loadProject(second.p.root), "main-dev")).some((m) => m.text === "Run the linter."), "not lost");
});

test("when Paseo does not answer, nothing is assumed idle and nothing is sent", async () => {
  const paseo = fakePaseo();
  const { hub, say } = await setup(paseo, model((q) => (q.includes("tests") ? [["propose_agent_command", { project: "harbor", agent: "main-dev", prompt: "Run the tests.", summary: "tests", owner_asked: true, irreversible: false }]] : [])));
  await say("tell main-dev to run the tests");
  await say("yes");
  paseo.agent.listed = false;
  await hub.flushDeliveries();
  // Paseo listed others but not this session: it is gone, so the instruction goes to the inbox.
  deepStrictEqual(hub.state.deliveryQueue, []);
});

test("a restart after a limit is not sent to an agent that is already working again", async () => {
  const paseo = fakePaseo();
  const p = await team();
  const outcome = await deliverToSession(p, "main-dev", "Resume.", { paseoAgent: MAIN }, paseo.exec);
  deepStrictEqual(outcome, { agentId: "main-dev", via: "none", reason: "it is already working again" });
  deepStrictEqual(paseo.sent, []);
});
