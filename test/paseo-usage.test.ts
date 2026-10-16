import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { Hub } from "../src/hub/hub.ts";
import { DEFAULT_ACCOUNT, claudeWindows } from "../src/limits/claude.ts";
import { readClaudeUsage, recordClaudeUsage } from "../src/limits/claude-usage.ts";
import { claudeUsageFromPaseo, readPaseoClaudeUsage } from "../src/limits/paseo-usage.ts";
import { isolateHost } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-paseo-usage-");
});

const at = Date.parse("2026-10-16T14:21:16Z");
/** Paseo's answer as its daemon gives it, with an invented login. */
const answer = (five = 23, week = 40) => ({
  requestId: "r1",
  fetchedAt: new Date(at).toISOString(),
  providers: [
    { providerId: "claude", displayName: "Claude (ada@example.com)", status: "available", planLabel: "Pro", balances: [], details: [], error: null, windows: [
      { id: "five_hour", label: "Session", shortLabel: "5h", summary: true, usedPct: five, remainingPct: 100 - five, resetsAt: "2026-10-16T18:30:00.862951+00:00", tone: "ok" },
      { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, usedPct: week, remainingPct: 100 - week, resetsAt: "2026-10-18T14:00:00+00:00", tone: "ok" },
      { id: "weekly_model_fable", label: "Weekly · Fable", shortLabel: "wk Fable", usedPct: 0, remainingPct: 100, resetsAt: "2026-10-18T14:00:00+00:00", tone: "ok" },
    ] },
    { providerId: "claude", displayName: "Claude", status: "unavailable", planLabel: null, windows: [], balances: [], details: [], error: "Login expired" },
    { providerId: "codex", displayName: "Codex", status: "available", planLabel: "Plus", windows: [], balances: [], details: [], error: null },
  ],
});

test("Paseo's usage answer gives the default account's 5-hour and weekly windows; anything else is a reason, not an error", () => {
  const read = claudeUsageFromPaseo(answer());
  ok(read.ok);
  deepStrictEqual(read.usage, { fiveHour: { percent: 23, resetsAt: Date.parse("2026-10-16T18:30:00.862Z") }, sevenDay: { percent: 40, resetsAt: Date.parse("2026-10-18T14:00:00Z") }, observedAt: at });
  ok(!JSON.stringify(read.usage).includes("example.com"), "the login's address is not kept");

  strictEqual(claudeUsageFromPaseo({ providers: "nope" }).ok, false, "a changed shape");
  const none = answer();
  none.providers = none.providers.slice(1);
  deepStrictEqual(claudeUsageFromPaseo(none), { ok: false, reason: "Paseo reports no Claude usage" });
  const two = answer();
  two.providers = [two.providers[0]!, two.providers[0]!];
  strictEqual(claudeUsageFromPaseo(two).ok, false, "two logins: which is which is unknown");
});

test("a daemon that cannot be reached is a reason, never a throw", async () => {
  const read = await readPaseoClaudeUsage(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  deepStrictEqual(read, { ok: false, reason: "Paseo's daemon could not be asked for usage: connect ECONNREFUSED" });
});

test("the hub asks Paseo every five minutes and the panel's windows have the %; when Paseo fails, the status line's reading stays", async () => {
  let calls = 0;
  let fail = false;
  const lines: string[] = [];
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", statusChecks: { enabled: false }, limits: { enabled: true, codex: false } });
  let now = at + 1000;
  const hub = new Hub({ config, channel: new ConsoleChannel(), clock: () => now, log: (l) => void lines.push(l), paseoUsage: async () => {
    calls++;
    if (fail) throw new Error("connect ECONNREFUSED");
    return answer();
  } });
  await hub.tick(new Date(now));
  strictEqual(calls, 1);
  deepStrictEqual((await claudeWindows({ now, language: "en" })).map((w) => [w.id, w.usedPercent]).sort(), [["claude:10080", 40], ["claude:300", 23]]);
  strictEqual((await readClaudeUsage(DEFAULT_ACCOUNT))!.source, "paseo");

  now += 60_000;
  await hub.tick(new Date(now));
  strictEqual(calls, 1, "not again within five minutes");

  // Paseo goes away; a terminal session's status line reports meanwhile.
  fail = true;
  await recordClaudeUsage({ fiveHour: { percent: 30, resetsAt: Date.parse("2026-10-16T18:30:00Z") }, observedAt: now, source: "statusline" }, DEFAULT_ACCOUNT);
  now += 5 * 60_000;
  await hub.tick(new Date(now));
  await hub.tick(new Date((now += 5 * 60_000)));
  strictEqual(calls, 3);
  strictEqual(lines.filter((l) => /paseo usage unavailable, the status line stays the source/.test(l)).length, 1, "said once");
  strictEqual((await readClaudeUsage(DEFAULT_ACCOUNT))!.fiveHour!.percent, 30, "the status line's reading is the one shown");
});

test("an older reading never replaces a newer one, whichever source it comes from", async () => {
  await recordClaudeUsage({ fiveHour: { percent: 50, resetsAt: at + 3_600_000 }, observedAt: at, source: "paseo" }, DEFAULT_ACCOUNT);
  await recordClaudeUsage({ fiveHour: { percent: 10, resetsAt: at + 3_600_000 }, observedAt: at - 60_000, source: "statusline" }, DEFAULT_ACCOUNT);
  strictEqual((await readClaudeUsage(DEFAULT_ACCOUNT))!.fiveHour!.percent, 50);
});
