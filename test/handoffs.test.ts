import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import type { Channel, IncomingMessage } from "../src/channels/channel.ts";
import { report } from "../src/commands/report.ts";
import { findTeammate } from "../src/core/agents.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { pending } from "../src/core/inbox.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { sessionBriefing } from "../src/core/protocol.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { isolateHost, tempProject } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-handoff-");
});

const MAIN = "6f1d2c3b-0000-4000-8000-00000000main";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

class Rec implements Channel {
  readonly name = "rec";
  readonly sent: Array<{ projectId: string | null; text: string }> = [];
  readonly noted: Array<{ projectId: string | null; text: string }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(projectId: string | null, text: string): Promise<void> {
    this.sent.push({ projectId, text });
  }
  async note(projectId: string | null, text: string): Promise<void> {
    this.noted.push({ projectId, text });
  }
}

/** A pretend `paseo` running the main dev: records what it is sent. */
function fakePaseo() {
  const sent: string[] = [];
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: MAIN, shortId: "6f1d2c3", status: "idle" }]) };
    if (args[0] === "send") {
      sent.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
      return { stdout: "{}" };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, sent };
}

/** A model that only ever says one thing, or runs a tool first. */
function model(step: (request: RunRequest) => Promise<string> = async () => "Noted.") {
  const seen: RunRequest[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      seen.push(request);
      return { text: await step(request), model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  return { provider, seen };
}

async function team(): Promise<Project> {
  const p = await tempProject({
    id: "harbor",
    name: "Harbor",
    agents: [
      { id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: MAIN, label: "Harbor Main Dev", role: "architect and backend; merges to main" },
      { id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX", role: "frontend, UX and usability" },
      { id: "qa", control: "inbox", host: "claude-code", role: "tests and code review" },
    ],
  });
  await registerProject("harbor", p.root);
  return p;
}

async function setup(provider = model().provider) {
  const p = await team();
  const paseo = fakePaseo();
  const chat = new Rec();
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } }),
    channel: chat,
    provider,
    exec: paseo.exec,
    log: () => undefined,
  });
  const t0 = Date.now();
  await hub.tick(new Date(t0)); // first sight: history is baselined
  const replies: string[] = [];
  const say = async (text: string, threadKey = "telegram-7"): Promise<string> => {
    await hub.handle({ text, projectId: "harbor", threadKey, reply: async (r) => void replies.push(r), typing: async () => undefined } satisfies IncomingMessage);
    return replies.at(-1) ?? "";
  };
  const at = (minutes: number) => new Date(t0 + minutes * 60_000);
  return { p, paseo, chat, hub, say, at };
}

const inHarbor = (c: Rec) => c.sent.filter((m) => m.projectId === "harbor").map((m) => m.text);

test("--handoff is recorded in the report as teammate and ask, and a malformed one is refused", async () => {
  const p = await team();
  const { data } = await report(p, { ...base, agent: "ux", status: "progress", doing: ["Booking page"], handoff: ["main-dev: expose GET /api/bookings: dates and status"] });
  deepStrictEqual(data.handoffs, [{ to: "main-dev", ask: "expose GET /api/bookings: dates and status" }], "only the first colon separates");
  await rejects(report(await loadProject(p.root), { ...base, agent: "ux", status: "progress", handoff: ["no colon here"] }), /Cannot read --handoff/);
});

test("every agent learns its team, with roles, and how to hand work over", async () => {
  const p = await team();
  const briefing = sessionBriefing(p, "ux");
  match(briefing, /main-dev \(Harbor Main Dev\): architect and backend; merges to main/);
  match(briefing, /ux \(Harbor UX\) — you: frontend, UX and usability/);
  match(briefing, /--handoff "<teammate id>: <what you need, and why>"/);
  const alone = await tempProject({ agents: [{ id: "claude", control: "inbox", host: "claude-code" }] });
  ok(!sessionBriefing(alone, "claude").includes("Your team"), "a lone agent is not told about a team");
});

test("a teammate is found by id, by workspace name or by role — never the asker, never by a role two share", async () => {
  const p = await team();
  strictEqual(findTeammate(p, "main-dev", "ux")?.id, "main-dev");
  strictEqual(findTeammate(p, "Harbor UX", "qa")?.id, "ux");
  strictEqual(findTeammate(p, "backend developer", "ux")?.id, "main-dev");
  strictEqual(findTeammate(p, "the reviewer of tests", "main-dev")?.id, "qa");
  strictEqual(findTeammate(p, "ux", "ux"), undefined, "an agent does not hand work to itself");
  p.config.agents[2]!.role = "backend tests";
  strictEqual(findTeammate(p, "backend", "ux"), undefined, "two agents mention backend: ambiguous, so nobody");
});

test("a handoff is shown in the project's thread as a draft for the teammate, and nothing is sent before «yes»", async () => {
  const { p, paseo, chat, hub, at } = await setup();
  await report(p, { ...base, agent: "ux", status: "progress", doing: ["Booking page"], handoff: ["backend: expose GET /api/bookings with dates and status"], at: at(1).toISOString() });
  await hub.tick(at(2));

  const shown = inHarbor(chat).find((t) => t.includes("🤝"))!;
  match(shown, /🤝 Handoff — Harbor UX → Harbor Main Dev \(Harbor\)/);
  match(shown, /«expose GET \/api\/bookings with dates and status»/);
  match(shown, /add --handoff "ux: <what>"/, "the teammate is told how to answer");
  match(shown, /Reply "yes" to send it/);
  strictEqual(paseo.sent.length, 0);
  strictEqual(hub.state.handoffs.length, 1);
});

test("«yes» in the project's thread sends exactly the shown text, records it, and routes the answer back as the reply to the asker", async () => {
  const { p, paseo, chat, hub, say, at } = await setup();
  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["main-dev: expose GET /api/bookings"], at: at(1).toISOString() });
  await hub.tick(at(2));
  const shown = inHarbor(chat).at(-1)!;

  match(await say("yes"), /Sent to Harbor Main Dev \(Harbor\)/);
  strictEqual(paseo.sent.length, 1);
  ok(shown.includes(paseo.sent[0]!), "what is sent is byte for byte what was shown");
  deepStrictEqual(hub.state.handoffs, []);
  strictEqual(hub.state.handoffReplies["harbor:main-dev"], "ux");
  match(await readFile(`${p.root}/.leftoff/decisions.md`, "utf8"), /Handoff approved: Harbor UX → Harbor Main Dev: expose GET \/api\/bookings/);

  const sentAt = Date.parse(hub.state.awaiting["harbor:main-dev"]!);
  await report(await loadProject(p.root), { ...base, agent: "main-dev", status: "progress", done: ["GET /api/bookings"], at: new Date(sentAt + 1000).toISOString() });
  await hub.tick(new Date(sentAt + 2000));
  match(inHarbor(chat).at(-1)!, /↩️ Harbor Main Dev's answer to Harbor UX's request:\n.*GET \/api\/bookings/);
});

test("«no» drops the handoff; nothing is sent and the next one is shown", async () => {
  const { p, paseo, chat, hub, say, at } = await setup();
  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["main-dev: first ask", "qa: second ask"], at: at(1).toISOString() });
  await hub.tick(at(2));
  strictEqual(inHarbor(chat).filter((t) => t.includes("🤝")).length, 1, "one at a time: a «yes» can only mean the last thing shown");
  match(await say("no"), /Dropped, nothing was sent/);
  strictEqual(paseo.sent.length, 0);
  await hub.tick(at(3));
  match(inHarbor(chat).at(-1)!, /Harbor UX → Qa/);
  await say("yes");
  match((await pending(await loadProject(p.root), "qa"))[0]!.text, /«second ask»/, "an agent Paseo does not run gets it in its inbox");
});

test("a handoff to nobody the project knows tells the owner who is on the team, and queues nothing", async () => {
  const { p, chat, hub, at } = await setup();
  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["designer: pick the colours"], at: at(1).toISOString() });
  await hub.tick(at(2));
  match(inHarbor(chat).at(-1)!, /Harbor UX needs «pick the colours» from “designer”, but no agent of this project matches\. Team: Harbor Main Dev \(architect and backend; merges to main\), Qa \(tests and code review\)/);
  deepStrictEqual(hub.state.handoffs, []);
});

test("a handoff not yet shown cannot be approved, and is not shown while the PM's own draft waits in that thread", async () => {
  const proposing = model(async (request) => {
    await request.execute("propose_agent_command", { project: "harbor", agent: "qa", prompt: "Run the booking tests.", summary: "Tests" });
    return "I'll ask QA to run the tests.";
  });
  const { p, paseo, chat, hub, say, at } = await setup(proposing.provider);
  await say("tell qa to run the booking tests");
  ok(hub.state.proposals["telegram-7"], "the PM's draft is pending in the project's thread");

  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["main-dev: expose GET /api/bookings"], at: at(1).toISOString() });
  await hub.tick(at(2));
  ok(!inHarbor(chat).some((t) => t.includes("🤝")), "not shown: «yes» would be ambiguous");

  await say("yes");
  strictEqual(paseo.sent.length, 0, "the «yes» went to the PM's draft (QA, by inbox), not to the handoff");
  match((await pending(await loadProject(p.root), "qa"))[0]!.text, /Run the booking tests/);
  await hub.tick(at(3));
  ok(inHarbor(chat).some((t) => t.includes("🤝")), "shown once the thread is free");
});

test("asked to change a shown handoff, the PM's revised draft replaces it, and the answer still goes back to the asker", async () => {
  const revising = model(async (request) => {
    await request.execute("propose_agent_command", { project: "harbor", agent: "main-dev", prompt: "Expose GET /api/bookings, paginated.", summary: "Paginated" });
    return "Same request, paginated.";
  });
  const { p, paseo, hub, say, at } = await setup(revising.provider);
  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["main-dev: expose GET /api/bookings"], at: at(1).toISOString() });
  await hub.tick(at(2));

  await say("ok but make it paginated");
  match(revising.seen[0]!.prompt, /A handoff from Harbor UX to Harbor Main Dev .* is waiting for the owner's approval/);
  deepStrictEqual(hub.state.handoffs, [], "the revision replaced the handoff");
  await say("yes");
  deepStrictEqual(paseo.sent, ["Expose GET /api/bookings, paginated."]);
  strictEqual(hub.state.handoffReplies["harbor:main-dev"], "ux");
});

test("a shown handoff nobody answered expires, with a note in the panel", async () => {
  const { p, chat, hub, at } = await setup();
  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["main-dev: expose GET /api/bookings"], at: at(1).toISOString() });
  await hub.tick(at(2));
  ok(hub.state.handoffs[0]!.expiresAt);
  await hub.tick(at(2 + 121));
  deepStrictEqual(hub.state.handoffs, []);
  match(chat.noted.at(-1)!.text, /⌛ The handoff Harbor UX → Harbor Main Dev expired/);
});

test("the owner's words become a role, through the PM", async () => {
  const setting = model(async (request) => {
    const outcome = await request.execute("set_agent_role", { project: "harbor", agent: "Harbor UX", role: "frontend and usability" });
    return outcome.content;
  });
  const { p, say } = await setup(setting.provider);
  match(await say("UX does the frontend and usability"), /now has the role «frontend and usability»/);
  strictEqual((await loadProject(p.root)).config.agents.find((a) => a.id === "ux")?.role, "frontend and usability");
});
