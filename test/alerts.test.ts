import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ActivityMeta, Channel, IncomingMessage } from "../src/channels/channel.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { commit, isolateHost, tempProject } from "./helpers.ts";

const TZ = "Europe/Rome";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

/** A chat that remembers what it was told, what the hub chose to keep to itself, and what went to the activity register. */
class Rec implements Channel {
  readonly name = "rec";
  readonly sent: Array<{ projectId: string | null; text: string }> = [];
  readonly noted: Array<{ projectId: string | null; text: string }> = [];
  readonly logged: Array<{ projectId: string; text: string; meta: ActivityMeta }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(projectId: string | null, text: string): Promise<void> {
    this.sent.push({ projectId, text });
  }
  async note(projectId: string | null, text: string): Promise<void> {
    this.noted.push({ projectId, text });
  }
  async activity(projectId: string, text: string, meta: ActivityMeta): Promise<void> {
    this.logged.push({ projectId, text, meta });
  }
}

beforeEach(async () => {
  await isolateHost("leftoff-alerts-");
});

async function setup(): Promise<{ p: Project; hub: Hub; chat: Rec; say: (t: string) => Promise<string> }> {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  await registerProject("clipforge", p.root);
  const chat = new Rec();
  // Quiet hours off: the hour the test runs must not decide what is sent. Level left at its default.
  const hub = new Hub({ config: ConfigSchema.parse({ timezone: TZ, language: "it", limits: { enabled: false }, notify: { quietHours: { start: "00:00", end: "00:00" } } }), channel: chat, log: () => undefined });
  await hub.tick(new Date()); // first sight: history is baselined, not told
  const say = async (text: string): Promise<string> => {
    let out = "";
    await hub.handle({ text, projectId: null, threadKey: "t", reply: async (r) => void (out += r), typing: async () => undefined } satisfies IncomingMessage);
    return out;
  };
  return { p, hub, chat, say };
}

const inClipforge = (c: Rec) => c.sent.filter((m) => m.projectId === "clipforge");

test("by default only what needs the owner reaches the chat; the rest is kept for the dashboard", async () => {
  const { p, hub, chat } = await setup();
  const t0 = Date.now(); // one instant: every time below is derived from it, so a slow machine cannot reorder them
  await report(p, { ...base, agent: "claude", status: "done", done: ["Form prenotazioni"] });
  await report(await loadProject(p.root), { ...base, agent: "codex", status: "idle", done: ["Test"] });
  await hub.tick(new Date(t0 + 60_000));
  strictEqual(inClipforge(chat).length, 0, "finished work is not pushed");
  deepStrictEqual(chat.noted.filter((n) => n.projectId === "clipforge").length, 2, "…but it is kept");
  match(chat.noted[0]!.text, /Form prenotazioni|Test/);

  await report(await loadProject(p.root), { ...base, agent: "claude", status: "blocked", blocked: ["serve l'URL iCal"] });
  await hub.tick(new Date(t0 + 120_000));
  await report(await loadProject(p.root), { ...base, agent: "codex", status: "needs_input", question: "Quale calendario?", option: ["iCal", "API"] });
  await hub.tick(new Date(t0 + 180_000));
  deepStrictEqual(inClipforge(chat).map((m) => /bloccato|ha bisogno di te/.test(m.text)), [true, true], "blocked and needs-you come through");
});

test("/avvisi widens or narrows what is pushed, in any language, and the choice is kept", async () => {
  const { p, hub, chat, say } = await setup();
  const t0 = Date.now(); // one instant: every time below is derived from it, so a slow machine cannot reorder them
  match(await say("/alerts"), /solo critici/);
  match(await say("/avvisi normali"), /Avvisi: normali/);
  strictEqual(hub.state.notifyLevel, "normal");

  await report(p, { ...base, agent: "claude", status: "done", done: ["Pagina tour"] });
  await hub.tick(new Date(t0 + 60_000));
  match(inClipforge(chat)[0]!.text, /✅ Claude ha finito: Pagina tour/, "at «normal» finished work is news");

  match(await say("/alerts klingon"), /Scegli tra/);
  strictEqual(hub.state.notifyLevel, "normal", "an unknown level changes nothing");
  match(await say("/meldungen kritisch"), /Avvisi: solo critici/);
  strictEqual(hub.state.notifyLevel, "critical");
  match(await say("/alertes tous"), /Avvisi: tutti/);

  await hub.stop();
  const again = new Hub({ config: ConfigSchema.parse({ timezone: TZ, limits: { enabled: false } }), channel: new Rec(), log: () => undefined });
  await again.start();
  strictEqual(again.state.notifyLevel, "all", "what the owner chose outlives the process");
  await again.stop();
});

test("commits nobody reported are a step, not news: the register has them, chat never — not even at «all» (D-052)", async () => {
  const { p, hub, chat, say } = await setup();
  const t0 = Date.now(); // one instant: every time below is derived from it, so a slow machine cannot reorder them
  await say("/alerts all");
  await commit(p.root, "x.ts", "export {};\n", "feat: something nobody reported");
  await hub.tick(new Date(t0 + 40 * 60_000));
  await hub.tick(new Date(t0 + 80 * 60_000));
  strictEqual(inClipforge(chat).length, 0);
  ok(!chat.noted.some((n) => /senza report/.test(n.text)), "nor in the panel's conversation");
  ok(chat.logged.some((l) => l.meta.type === "commits" && /senza report/.test(l.text)), "kept in the register");
});

test("an agent's progress report is a step: in the register, never in chat — not even at «all» (D-052)", async () => {
  const { p, hub, chat, say } = await setup();
  const t0 = Date.now();
  await say("/alerts all");
  await report(p, { ...base, agent: "claude", status: "progress", doing: ["Metà del form"] });
  await hub.tick(new Date(t0 + 60_000));
  strictEqual(inClipforge(chat).length, 0);
  ok(!chat.noted.some((n) => /Metà del form/.test(n.text)), "not even as «not sent» in the conversation");
  deepStrictEqual(chat.logged.filter((l) => /Metà del form/.test(l.text)).map((l) => [l.meta.type, l.meta.agent]), [["report", "claude"]]);
});

test("the answer to what the owner asked is always pushed; the answer to the PM's own automatic question waits", async () => {
  const { p, hub, chat } = await setup();
  const t0 = Date.now(); // one instant: every time below is derived from it, so a slow machine cannot reorder them
  const key = "clipforge:claude";
  const sentAt = new Date(t0 + 1_000).toISOString();
  const later = (s: number) => new Date(t0 + s * 1000).toISOString();

  // The owner told the PM to instruct the agent: the turn that carried it out, finished, is a closure (D-052).
  hub.state.awaiting[key] = sentAt;
  await report(p, { ...base, agent: "claude", status: "done", done: ["Fatto come chiesto"], at: later(30) });
  await hub.tick(new Date(t0 + 60_000));
  match(inClipforge(chat).at(-1)!.text, /Risposta di Claude alla tua istruzione[\s\S]*Fatto come chiesto/);

  // Half done: a step, for the register only.
  hub.state.awaiting[key] = later(70);
  await report(await loadProject(p.root), { ...base, agent: "claude", status: "progress", done: ["Metà del lavoro"], at: later(80) });
  let before = inClipforge(chat).length;
  await hub.tick(new Date(t0 + 90_000));
  strictEqual(inClipforge(chat).length, before, "an answer that is not the end of it stays out of chat");
  ok(chat.logged.some((l) => l.meta.type === "reply" && /Metà del lavoro/.test(l.text)));

  // The hub asked on its own initiative: a step between the PM and the agent.
  hub.state.awaiting[key] = later(100);
  hub.state.statusAsked[key] = later(100);
  hub.state.statusAskedBy[key] = "auto";
  await report(await loadProject(p.root), { ...base, agent: "claude", status: "progress", done: ["Aggiornamento automatico"], at: later(130) });
  before = inClipforge(chat).length;
  await hub.tick(new Date(t0 + 160_000));
  strictEqual(inClipforge(chat).length, before, "the automatic answer is held back");
  ok(!chat.noted.some((n) => /Aggiornamento automatico/.test(n.text)), "and is not conversation");
  ok(chat.logged.some((l) => l.meta.type === "reply" && /Aggiornamento automatico/.test(l.text)));

  // The owner asked the PM to ask: that answer they want.
  hub.state.awaiting[key] = later(200);
  hub.state.statusAsked[key] = later(200);
  hub.state.statusAskedBy[key] = "pm";
  await report(await loadProject(p.root), { ...base, agent: "claude", status: "progress", done: ["Come richiesto dal proprietario"], at: later(230) });
  await hub.tick(new Date(t0 + 260_000));
  match(inClipforge(chat).at(-1)!.text, /Aggiornamento da Claude \(chiesto dal PM\)[\s\S]*Come richiesto/);
});
