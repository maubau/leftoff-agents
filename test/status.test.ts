import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import type { IncomingMessage } from "../src/channels/channel.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { pending } from "../src/core/inbox.ts";
import { loadProject, saveProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub, type Contact } from "../src/hub/hub.ts";
import type { ModelProvider, RunRequest } from "../src/pm/provider.ts";
import { commit, isolateHost, tempProject } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-status-");
});

const PASEO = "0d8b831c-70bd-4ef5-add9-e5e1931b60a8";
const NOON = new Date("2026-10-06T12:00:00+02:00");
const hoursBefore = (h: number, from = NOON) => new Date(from.getTime() - h * 3_600_000).toISOString();
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

async function clipforge(extra: Record<string, unknown> = {}): Promise<Project> {
  const p = await tempProject({ id: "clipforge", name: "Clipforge", agents: [{ id: "claude", control: "paseo", host: "claude-code", paseoAgent: PASEO }], ...extra });
  await registerProject(p.id, p.root);
  return p;
}

function fakePaseo(status: "running" | "idle" | "closed") {
  const sent: string[] = [];
  const exec = async (_file: string, args: string[]) => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: PASEO, shortId: "0d8b831", status }]) };
    sent.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
    return { stdout: '{"status":"sent"}' };
  };
  return { exec, sent };
}

function hubWith(paseo: ReturnType<typeof fakePaseo>, config: Record<string, unknown> = {}, provider?: ModelProvider, contacts: Contact[] = []) {
  const channel = new ConsoleChannel();
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "it", timezone: "Europe/Rome", limits: { enabled: false }, notify: { level: "all" }, ...config }),
    channel,
    exec: paseo.exec,
    ...(provider ? { provider } : {}),
    onContact: (c) => contacts.push(c),
    log: () => undefined,
  });
  hub.state.lastStandup = "2026-10-06";
  return { hub, channel };
}

test("automatic: a working agent whose last report is stale is asked once, in the day, with a fixed question", async () => {
  const p = await clipforge();
  await report(p, { ...base, agent: "claude", status: "progress", done: ["x"], at: hoursBefore(3) });
  const paseo = fakePaseo("running");
  const { hub } = hubWith(paseo);
  await hub.tick(NOON);
  strictEqual(paseo.sent.length, 1);
  match(paseo.sent[0]!, /^\[leftoff\] Il project manager chiede un aggiornamento\./);
  ok(paseo.sent[0]!.includes("Non cambiare il tuo piano"), "a question, never an order");
  await hub.tick(new Date(NOON.getTime() + 60_000));
  await hub.tick(new Date(NOON.getTime() + 600_000));
  strictEqual(paseo.sent.length, 1, "asked once; the answer is awaited");
});

test("automatic: nothing is asked at night, when the report is fresh, when idle, or for a muted project", async () => {
  const p = await clipforge();
  await report(p, { ...base, agent: "claude", status: "progress", at: hoursBefore(3) });

  const night = fakePaseo("running");
  await hubWith(night).hub.tick(new Date("2026-10-06T23:30:00+02:00"));
  strictEqual(night.sent.length, 0, "outside 09:00–21:00");

  const idle = fakePaseo("idle");
  await hubWith(idle).hub.tick(NOON);
  strictEqual(idle.sent.length, 0, "an idle agent is not poked automatically");

  const muted = fakePaseo("running");
  const m = hubWith(muted);
  m.hub.state.mutes["clipforge"] = new Date(NOON.getTime() + 3_600_000).toISOString();
  await m.hub.tick(NOON);
  strictEqual(muted.sent.length, 0, "the owner muted this project");

  const fresh = fakePaseo("running");
  const q = await clipforge();
  void q;
  await report(await loadProject(p.root), { ...base, agent: "claude", status: "progress", at: hoursBefore(0.5) });
  await hubWith(fresh).hub.tick(NOON);
  strictEqual(fresh.sent.length, 0, "a report from 30 minutes ago is current");
});

test("automatic: a private project's agents are never asked, and a daily ceiling stops it", async () => {
  const secret = await clipforge({ id: "secret", name: "Secret", visibility: "private" });
  await report(secret, { ...base, agent: "claude", status: "progress", at: hoursBefore(5) });
  const paseo = fakePaseo("running");
  await hubWith(paseo).hub.tick(NOON);
  strictEqual(paseo.sent.length, 0);

  const open = await tempProject({ id: "open", name: "Open", agents: [{ id: "claude", control: "paseo", host: "claude-code", paseoAgent: PASEO }] });
  await registerProject("open", open.root);
  await report(open, { ...base, agent: "claude", status: "progress", at: hoursBefore(5) });
  const capped = hubWith(fakePaseo("running"), { statusChecks: { maxPerDay: 1 } });
  capped.hub.state.asks.push(NOON.toISOString());
  await capped.hub.tick(NOON);
  strictEqual(capped.hub.state.asks.length, 1, "the ceiling was already reached");
});

test("the answer comes back tagged as an update the PM asked for — not as an answer to an instruction", async () => {
  const p = await clipforge();
  await report(p, { ...base, agent: "claude", status: "progress", at: hoursBefore(3) });
  const { hub, channel } = hubWith(fakePaseo("running"));
  await hub.tick(NOON);
  await report(await loadProject(p.root), { ...base, agent: "claude", status: "progress", done: ["Validazione date"], at: new Date(NOON.getTime() + 120_000).toISOString() });
  await hub.tick(new Date(NOON.getTime() + 180_000));
  const msg = channel.sent.find((m) => m.projectId === "clipforge")!;
  match(msg.text, /↩️ Aggiornamento da Claude \(chiesto dal PM\)/);
  match(msg.text, /Validazione date/);
  ok(!/alla tua istruzione/.test(msg.text));
});

/** A PM that calls ask_agent_status once and says what happened. */
function asking(project = "clipforge", agent = "claude"): { provider: ModelProvider; outcomes: string[] } {
  const outcomes: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request: RunRequest) {
      const out = await request.execute("ask_agent_status", { project, agent });
      outcomes.push(out.content);
      return { text: out.isError ? `Non l'ho chiesto: ${out.content}` : "Gliel'ho chiesto.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  return { provider, outcomes };
}
const say = (text: string): IncomingMessage => ({ text, projectId: "clipforge", threadKey: "t", reply: async () => undefined, typing: async () => undefined });

test("PM tool: asks a working agent on request, and is refused when asked again", async () => {
  const p = await clipforge();
  await report(p, { ...base, agent: "claude", status: "progress", at: hoursBefore(2) });
  const paseo = fakePaseo("running");
  const { provider, outcomes } = asking();
  const contacts: Contact[] = [];
  const { hub } = hubWith(paseo, {}, provider, contacts);
  await hub.handle(say("a che punto è Claude?"));
  strictEqual(paseo.sent.length, 1);
  match(outcomes[0]!, /Asked Claude \(Clipforge\) for a status report \(it is working/);
  deepStrictEqual(contacts, [{ project: "clipforge", agent: "claude", kind: "status" }], "the panel is told the PM asked");
  await hub.handle(say("e adesso?"));
  strictEqual(paseo.sent.length, 1);
  match(outcomes[1]!, /already expected to answer/);
  strictEqual(contacts.length, 1, "a refused ask is not a contact");
});

test("PM tool: an idle agent with nothing new is not woken; one with unreported commits may be asked", async () => {
  const p = await clipforge();
  // The report is written after the repo's own "init" commit, so nothing is unreported yet.
  await report(p, { ...base, agent: "claude", status: "done", at: new Date().toISOString() });
  const idle = fakePaseo("idle");
  const first = asking();
  await hubWith(idle, {}, first.provider).hub.handle(say("e Claude?"));
  strictEqual(idle.sent.length, 0);
  match(first.outcomes[0]!, /idle and has nothing unreported/);

  // Git dates have second precision: wait one, so the commit is unambiguously after the report.
  await new Promise((r) => setTimeout(r, 1100));
  await commit((await loadProject(p.root)).root, "work.ts", "export {};\n", "work nobody reported");
  const idle2 = fakePaseo("idle");
  const second = asking();
  await hubWith(idle2, {}, second.provider).hub.handle(say("e Claude?"));
  strictEqual(idle2.sent.length, 1, "it worked without reporting: asking is useful");
});

test("PM tool: a closed agent is not asked and nothing waits in its inbox", async () => {
  const p = await clipforge();
  await report(p, { ...base, agent: "claude", status: "progress", at: hoursBefore(2) });
  const closed = fakePaseo("closed");
  const { provider, outcomes } = asking();
  await hubWith(closed, {}, provider).hub.handle(say("e Claude?"));
  strictEqual(closed.sent.length, 0);
  match(outcomes[0]!, /cannot be reached live/);
  strictEqual((await pending(await loadProject(p.root), "claude")).length, 0, "a question has no value hours later");
});

test("PM tool: unknown project and agent are refused; private projects do not exist for it", async () => {
  await clipforge();
  const secret = await tempProject({ id: "secret", name: "Secret", visibility: "private", agents: [{ id: "claude", control: "paseo", host: "claude-code", paseoAgent: PASEO }] });
  await registerProject("secret", secret.root);
  const paseo = fakePaseo("running");
  const a = asking("nope");
  await hubWith(paseo, {}, a.provider).hub.handle(say("x"));
  match(a.outcomes[0]!, /No project "nope"/);
  const b = asking("clipforge", "codex");
  await hubWith(paseo, {}, b.provider).hub.handle(say("x"));
  match(b.outcomes[0]!, /No agent "codex" in clipforge/);
  const c = asking("secret");
  await hubWith(paseo, {}, c.provider).hub.handle(say("x"));
  match(c.outcomes[0]!, /No project "secret"/);
  strictEqual(paseo.sent.length, 0);
});

test("a queued notice for a project that has since turned private is not sent", async () => {
  const p = await clipforge();
  const { hub, channel } = hubWith(fakePaseo("idle"));
  hub.state.queued.push({ projectId: "clipforge", text: "↩️ Risposta di Claude: dettagli di Clipforge", at: NOON.toISOString() });
  p.config.visibility = "private";
  await saveProject(p.root, p.config);
  await hub.tick(NOON);
  ok(!channel.sent.some((m) => m.text.includes("dettagli di Clipforge")));
  strictEqual(hub.state.queued.length, 0);
});

test("a failure while following the work never costs the owner the rest of the pass", async () => {
  const p = await clipforge();
  await report(p, { ...base, agent: "claude", status: "progress", at: hoursBefore(3) });
  const broken = {
    exec: async () => {
      throw new Error("paseo exploded");
    },
    sent: [] as string[],
  };
  const { hub } = hubWith(broken);
  hub.state.queued.push({ projectId: null, text: "a queued notice", at: NOON.toISOString() });
  const channel = (hub as unknown as { "#channel"?: unknown });
  void channel;
  await hub.tick(NOON);
  strictEqual(hub.state.queued.length, 0, "the queue was still flushed");
});

test("automatic: near a subscription limit the PM does not spend more of it asking", async () => {
  const p = await tempProject({ id: "cx", name: "Cx", agents: [{ id: "codex", control: "paseo", host: "codex", paseoAgent: PASEO }] });
  await registerProject("cx", p.root);
  await report(p, { ...base, agent: "codex", status: "progress", at: hoursBefore(4) });
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "06");
  await mkdir(dir, { recursive: true });
  const usage = (pct: number) =>
    writeFile(join(dir, "rollout-x.jsonl"), JSON.stringify({ timestamp: NOON.toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: NOON.getTime() / 1000 + 7200 }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: NOON.getTime() / 1000 + 400000 } } } }) + "\n");

  await usage(85);
  const strained = fakePaseo("running");
  await hubWith(strained, { limits: { enabled: true, claude: false } }).hub.tick(NOON);
  strictEqual(strained.sent.length, 0, "at 85% of the 5-hour window the PM stays out of the way");

  await usage(20);
  const calm = fakePaseo("running");
  await hubWith(calm, { limits: { enabled: true, claude: false } }).hub.tick(NOON);
  strictEqual(calm.sent.length, 1, "with room to spare it asks");
});
