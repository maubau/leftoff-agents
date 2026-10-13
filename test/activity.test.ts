import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ActivityMeta, Channel, SendOptions } from "../src/channels/channel.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, saveProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const base = { done: [], doing: [], blocked: [], next: [], option: [] };

/** A chat that remembers what was sent, what was kept to the panel, and what went to the activity register. */
class Rec implements Channel {
  readonly name = "rec";
  readonly sent: Array<{ projectId: string | null; text: string; options?: SendOptions | undefined }> = [];
  readonly noted: Array<{ projectId: string | null; text: string }> = [];
  readonly logged: Array<{ projectId: string; text: string; meta: ActivityMeta }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(projectId: string | null, text: string, options?: SendOptions): Promise<void> {
    this.sent.push({ projectId, text, options });
  }
  async note(projectId: string | null, text: string): Promise<void> {
    this.noted.push({ projectId, text });
  }
  async activity(projectId: string, text: string, meta: ActivityMeta): Promise<void> {
    this.logged.push({ projectId, text, meta });
  }
}

beforeEach(async () => {
  await isolateHost("leftoff-activity-");
});

/** A fixed instant, noon in Rome: nothing here depends on when the tests run — not the burst cap, not the stand-up. */
const T0 = Date.UTC(2026, 9, 6, 10, 0);

/** The hub's clock and the pass's time move together: `at(ms)` is the moment `ms` after T0. */
async function setup(notify: Record<string, unknown> = {}): Promise<{ p: Project; hub: Hub; chat: Rec; at: (ms: number) => Date }> {
  const p = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code" }, { id: "main-dev", control: "inbox", host: "claude-code" }] });
  await registerProject("harbor", p.root);
  const chat = new Rec();
  const config = ConfigSchema.parse({ timezone: "Europe/Rome", language: "en", limits: { enabled: false }, statusChecks: { enabled: false }, notify: { quietHours: { start: "00:00", end: "00:00" }, standupAt: "23:59", ...notify } });
  let now = T0;
  const hub = new Hub({ config, channel: chat, log: () => undefined, clock: () => now });
  const at = (ms: number) => new Date((now = T0 + ms));
  await hub.tick(at(0)); // first sight: history is baselined
  return { p, hub, chat, at };
}

const questions = async (p: Project, from: number, to: number) => {
  for (let i = from; i <= to; i++) {
    await report(await loadProject(p.root), { ...base, agent: `agent-${i}`, status: "needs_input", question: `Question ${i}?`, option: ["A", "B"] });
  }
};
const inHarbor = (c: Rec) => c.sent.filter((m) => m.projectId === "harbor");

test("a burst is capped: past the limit, messages are held and go out as one summary when the window ends (D-052)", async () => {
  const { p, hub, chat, at } = await setup();
  await questions(p, 1, 9);
  await hub.tick(at(60_000));
  strictEqual(inHarbor(chat).length, 6, "the default cap: six in ten minutes");
  strictEqual(chat.noted.filter((n) => n.projectId === "harbor").length, 3, "the rest are in the panel's conversation at once");

  await hub.tick(at(5 * 60_000));
  strictEqual(inHarbor(chat).length, 6, "the summary waits for the window to end");

  await hub.tick(at(11 * 60_000));
  const sent = inHarbor(chat);
  strictEqual(sent.length, 7);
  const summary = sent.at(-1)!.text;
  match(summary, /^🗂️ 3 notices on Harbor, grouped so as not to write to you too often:/);
  match(summary, /• ❓ Agent-7 needs you\.\n• ❓ Agent-8 needs you\.\n• ❓ Agent-9 needs you\./);
  match(summary, /The details are in the control panel\./);

  await hub.tick(at(12 * 60_000));
  strictEqual(inHarbor(chat).length, 7, "a summary goes out once");
});

test("a long burst names the first held messages and counts the rest", async () => {
  const { p, hub, chat, at } = await setup({ burst: { max: 1, minutes: 10 } });
  await questions(p, 1, 9);
  await hub.tick(at(60_000));
  strictEqual(inHarbor(chat).length, 1);
  await hub.tick(at(11 * 60_000));
  const summary = inHarbor(chat).at(-1)!.text;
  match(summary, /^🗂️ 8 notices on Harbor/);
  strictEqual(summary.split("\n").filter((l) => l.startsWith("• ")).length, 6);
  match(summary, /… and 2 more\./);
});

test("what asks for a «yes» is never held by the cap", async () => {
  const { p, hub, chat, at } = await setup({ burst: { max: 1, minutes: 10 } });
  await questions(p, 1, 2);
  await report(await loadProject(p.root), { ...base, agent: "ux", status: "progress", handoff: ["main-dev: expose GET /api/bookings"] });
  await hub.tick(at(60_000));
  // Agents' questions have buttons too now (their options): the handoff is the one that asks for a «sì».
  const shown = inHarbor(chat).find((m) => m.options?.choices && /🤝/.test(m.text));
  ok(shown, "the handoff is shown with its buttons, past the cap");
  match(shown.text, /🤝/);
});

test("activity setup ignores a wall clock next to the configured stand-up", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-12T23:59:30+02:00"));
  const { chat } = await setup();
  deepStrictEqual(chat.sent, []);
});

test("a summary for a project that turned private is dropped", async () => {
  const { p, hub, chat, at } = await setup({ burst: { max: 1, minutes: 10 } });
  await questions(p, 1, 3);
  await hub.tick(at(60_000));
  strictEqual(inHarbor(chat).length, 1);
  const loaded = await loadProject(p.root);
  await saveProject(p.root, { ...loaded.config, visibility: "private" });
  await hub.tick(at(11 * 60_000));
  strictEqual(inHarbor(chat).length, 1, "nothing about a private project reaches chat");
  ok(!chat.sent.some((m) => /Harbor/.test(m.text)));
});

test("an autonomous team at work: the register has every step, chat only what needs the owner and what closed", async () => {
  const { p, hub, chat, at } = await setup();
  await hub.setProjectMode("harbor", "autonomous", "panel");
  const before = inHarbor(chat).length;
  // A busy minute: progress, handoffs between teammates, more progress — the steps that used to flood the chat.
  for (let i = 0; i < 4; i++) {
    await report(await loadProject(p.root), { ...base, agent: "ux", status: "progress", doing: [`Screen ${i}`], handoff: [`main-dev: endpoint ${i}`] });
    await report(await loadProject(p.root), { ...base, agent: "main-dev", status: "progress", doing: [`Endpoint ${i}`] });
  }
  await hub.tick(at(60_000));
  strictEqual(inHarbor(chat).length, before, "no step reached the chat");
  ok(chat.logged.filter((l) => l.meta.type === "report").length >= 8, "every report is in the register");
  ok(chat.logged.some((l) => l.meta.type === "handoff" && l.meta.agent === "ux" && l.meta.to === "main-dev"), "and the handoffs passed on");

  await report(await loadProject(p.root), { ...base, agent: "main-dev", status: "needs_input", question: "Postgres or SQLite?", option: ["Postgres", "SQLite"] });
  await report(await loadProject(p.root), { ...base, agent: "ux", status: "done", done: ["Booking screens"] });
  await hub.tick(at(120_000));
  const told = inHarbor(chat).slice(before).map((m) => m.text);
  strictEqual(told.length, 1, "at the default level: the question");
  match(told[0]!, /Postgres or SQLite\?/);
  deepStrictEqual(chat.noted.filter((n) => /Booking screens/.test(n.text)).length, 1, "the closure is in the panel's conversation, marked as not sent");
});
