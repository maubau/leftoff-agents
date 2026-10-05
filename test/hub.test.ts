import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import type { Channel, IncomingMessage } from "../src/channels/channel.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, saveProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { inQuietHours, standupDue } from "../src/hub/clock.ts";
import { Hub } from "../src/hub/hub.ts";
import { redact } from "../src/hub/redact.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { commit, tempProject, isolateHost } from "./helpers.ts";

const TZ = "Europe/Rome";
const config = ConfigSchema.parse({ timezone: TZ, language: "it", notify: { level: "all", quietHours: { enabled: true, start: "22:00", end: "08:00" }, unreportedAfterMinutes: 30, pollSeconds: 60 } });
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

/** A wall-clock time in Rome on 2026-10-06 (a Tuesday). */
const rome = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00+02:00`);

beforeEach(async () => {
  await isolateHost("leftoff-hub-");
});

async function project(id: string, extra: Record<string, unknown> = {}): Promise<Project> {
  const p = await tempProject({ id, name: id[0]!.toUpperCase() + id.slice(1), ...extra });
  await registerProject(id, p.root);
  return p;
}

function hubWith(provider?: ModelProvider) {
  const channel = new ConsoleChannel();
  const hub = new Hub({ config, channel, ...(provider ? { provider } : {}), log: () => undefined });
  return { hub, channel };
}

test("clock: quiet hours wrap midnight, the stand-up fires once a day", () => {
  ok(inQuietHours(rome("23:30"), TZ, { start: "22:00", end: "08:00" }));
  ok(inQuietHours(rome("07:59"), TZ, { start: "22:00", end: "08:00" }));
  ok(!inQuietHours(rome("08:00"), TZ, { start: "22:00", end: "08:00" }));
  ok(!standupDue(rome("08:59"), TZ, "09:00", undefined));
  ok(standupDue(rome("09:01"), TZ, "09:00", undefined));
  ok(!standupDue(rome("15:00"), TZ, "09:00", "2026-10-06"));
});

test("history is baselined silently; then only reports that matter are pushed", async () => {
  const p = await project("clipforge");
  await report(p, { ...base, agent: "claude", status: "done", done: ["old work"] });
  const { hub, channel } = hubWith();
  await hub.tick(rome("10:00"));
  strictEqual(channel.sent.filter((m) => m.projectId === "clipforge").length, 0, "no replay of history");

  await report(await loadProject(p.root), { ...base, agent: "claude", status: "progress", done: ["step"] });
  await report(await loadProject(p.root), {
    ...base,
    agent: "claude",
    status: "needs_input",
    question: "Committo le specifiche su main?",
    option: ["Sì", "Prima rivedo"],
    recommend: "Sì",
  });
  await hub.tick(rome("10:01"));
  const sent = channel.sent.filter((m) => m.projectId === "clipforge");
  strictEqual(sent.length, 1, "progress is never pushed");
  match(sent[0]!.text, /❓ Claude ha bisogno di te/);
  match(sent[0]!.text, /1\. Sì/);
  match(sent[0]!.text, /Consiglia: Sì/);
});

test("quiet hours hold blockers until morning and drop the rest into the stand-up", async () => {
  const p = await project("harbor");
  const { hub, channel } = hubWith();
  await hub.tick(rome("21:00"));
  await report(p, { ...base, agent: "claude", status: "blocked", blocked: ["serve l'URL iCal"] });
  await report(await loadProject(p.root), { ...base, agent: "codex", status: "done", done: ["test del form"] });
  await hub.tick(rome("23:00"));
  strictEqual(channel.sent.filter((m) => m.projectId).length, 0, "nothing at night");

  await hub.tick(rome("08:05"));
  const morning = channel.sent.filter((m) => m.projectId === "harbor");
  strictEqual(morning.length, 1);
  match(morning[0]!.text, /⛔ Claude è bloccato: serve l'URL iCal/);
});

test("a muted project stays silent", async () => {
  const p = await project("storefront");
  const { hub, channel } = hubWith();
  await hub.tick(rome("10:00"));
  hub.state.mutes.storefront = rome("20:00").toISOString();
  await report(p, { ...base, agent: "claude", status: "blocked", blocked: ["Leaflet o Google Maps?"] });
  await hub.tick(rome("10:05"));
  strictEqual(channel.sent.filter((m) => m.projectId === "storefront").length, 0);
});

test("a transient channel failure retries an event instead of consuming it", async () => {
  const p = await project("retry");
  let fail = false;
  const sent: string[] = [];
  const channel: Channel = {
    name: "flaky",
    start: async () => undefined,
    stop: async () => undefined,
    send: async (_projectId, text) => {
      if (fail) {
        fail = false;
        throw new Error("temporary outage");
      }
      sent.push(text);
    },
  };
  const hub = new Hub({ config, channel, log: () => undefined });
  await hub.tick(rome("08:30"));
  await report(p, { ...base, agent: "claude", status: "done", done: ["important"] });
  fail = true;
  await hub.tick(rome("08:31"));
  strictEqual(sent.length, 0);
  await hub.tick(rome("08:32"));
  strictEqual(sent.filter((text) => /important/.test(text)).length, 1);
});

test("a muted answer closes the wait and a later report is not mislabelled", async () => {
  const p = await project("muted-reply");
  const { hub, channel } = hubWith();
  await hub.tick(rome("10:00"));
  hub.state.awaiting["muted-reply:claude"] = rome("10:01").toISOString();
  hub.state.mutes["muted-reply"] = rome("11:00").toISOString();
  await report(p, { ...base, agent: "claude", status: "progress", done: ["real answer"], at: rome("10:02").toISOString() });
  await hub.tick(rome("10:03"));
  strictEqual(hub.state.awaiting["muted-reply:claude"], undefined);
  delete hub.state.mutes["muted-reply"];
  await report(p, { ...base, agent: "claude", status: "progress", done: ["unrelated"], at: rome("10:04").toISOString() });
  await hub.tick(rome("10:05"));
  strictEqual(channel.sent.filter((m) => m.projectId === "muted-reply").length, 0);
});

test("quiet hours are off by default and /quiet toggles them persistently", async () => {
  await project("quiet-toggle");
  const channel = new ConsoleChannel();
  const hub = new Hub({ config: ConfigSchema.parse({ timezone: TZ, language: "it", notify: { level: "all" } }), channel, log: () => undefined });
  const replies: string[] = [];
  const message = (text: string): IncomingMessage => ({ text, projectId: null, threadKey: "quiet", reply: async (value) => void replies.push(value), typing: async () => undefined });
  strictEqual(hub.state.quietHoursEnabled, undefined);
  await hub.handle(message("/quiet"));
  match(replies.at(-1)!, /disattivate/);
  await hub.handle(message("/quiet on"));
  strictEqual(hub.state.quietHoursEnabled, true);
  await hub.handle(message("/quiet off"));
  strictEqual(hub.state.quietHoursEnabled, false);
});

test("the stand-up goes out once, in General, after 09:00 and not before", async () => {
  const p = await project("clipforge");
  await report(p, { ...base, agent: "claude", status: "needs_input", question: "Committo su main?", option: [] });
  const { hub, channel } = hubWith();
  await hub.tick(rome("08:30"));
  strictEqual(channel.sent.filter((m) => m.projectId === null).length, 0);
  await hub.tick(rome("09:00"));
  await hub.tick(rome("09:30"));
  const standups = channel.sent.filter((m) => m.projectId === null);
  strictEqual(standups.length, 1);
  match(standups[0]!.text, /Stand-up di martedì/);
  match(standups[0]!.text, /Clipforge: .*❓ Claude: Committo su main\?/);
});

test("commits that sit unreported are flagged once", async () => {
  const p = await project("ledger");
  // This test steps the clock forward from the real "now"; with default quiet hours it
  // would pass or fail depending on the hour it runs, so switch quiet hours off here.
  const channel = new ConsoleChannel();
  const hub = new Hub({
    config: ConfigSchema.parse({ timezone: TZ, language: "it", notify: { level: "all", quietHours: { start: "00:00", end: "00:00" } } }),
    channel,
    log: () => undefined,
  });
  await hub.tick(new Date());
  await commit(p.root, "x.ts", "export {};\n", "feat: something nobody reported");
  await hub.tick(new Date(Date.now() + 10 * 60_000));
  strictEqual(channel.sent.filter((m) => m.projectId === "ledger").length, 0, "not before 30 minutes");
  await hub.tick(new Date(Date.now() + 40 * 60_000));
  await hub.tick(new Date(Date.now() + 80 * 60_000));
  const flagged = channel.sent.filter((m) => m.projectId === "ledger");
  strictEqual(flagged.length, 1);
  match(flagged[0]!.text, /⚠️ 1 commit .*senza report/);
  match(flagged[0]!.text, /something nobody reported/);
});

test("private projects never reach the chat", async () => {
  const p = await project("secret", { visibility: "private" });
  const { hub, channel } = hubWith();
  await hub.tick(rome("10:00"));
  await report(p, { ...base, agent: "claude", status: "blocked", blocked: ["x"] });
  await hub.tick(rome("10:01"));
  await hub.tick(rome("09:10"));
  ok(!channel.sent.some((m) => m.text.includes("Secret") || m.projectId === "secret"));
});

test("questions go to the PM with the thread's project and memory; /mute works", async () => {
  await project("clipforge");
  const seen: RunRequest[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      seen.push(request);
      if (request.prompt.includes("silenzia")) {
        const out = await request.execute("mute_project", { project: "clipforge", hours: 12 });
        return { text: `Fatto: ${out.content}`, model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
      }
      return { text: "Risposta, con sk-ant-api03-abcdefghijklmnop dentro", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const { hub } = hubWith(provider);
  const replies: string[] = [];
  const msg = (text: string): IncomingMessage => ({
    text,
    projectId: "clipforge",
    threadKey: "test-clipforge",
    reply: async (r) => void replies.push(r),
    typing: async () => undefined,
  });

  await hub.handle(msg("a che punto siamo?"));
  await hub.handle(msg("e il tedesco?"));
  match(seen[0]!.prompt, /project "Clipforge"/);
  strictEqual(seen[1]!.history.length, 2, "the second question carries the first exchange");
  ok(!replies[0]!.includes("abcdefghijklmnop"), "secrets are redacted on the way out");

  await hub.handle(msg("silenzia clipforge per oggi"));
  ok(hub.state.mutes.clipforge, "the PM can mute through its action tool");
  await hub.handle(msg("/unmute clipforge"));
  strictEqual(hub.state.mutes.clipforge, undefined);
});

test("redaction catches the usual suspects", () => {
  const out = redact("key sk-ant-api03-XYZXYZXYZXYZ, token=abc123, ghp_aaaaaaaaaaaaaaaaaaaaaaaa");
  ok(!out.includes("XYZXYZ"));
  ok(!out.includes("abc123"));
  ok(!out.includes("aaaaaaaa"));
});
