import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { readClaudeState } from "../src/limits/claude.ts";
import { readCodexLimits } from "../src/limits/codex.ts";
import { evaluateLimits, usedPhrase } from "../src/limits/evaluate.ts";
import { parseResetTime } from "../src/limits/reset-time.ts";
import type { LimitMemory, LimitWindow } from "../src/limits/types.ts";
import { tempProject, isolateHost } from "./helpers.ts";

const TZ = "Europe/Rome";
const rome = (hhmm: string, day = "06") => new Date(`2026-10-${day}T${hhmm}:00+02:00`).getTime();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

beforeEach(async () => {
  await isolateHost("leftoff-limits-");
});

test("reset time: clock, relative, epoch and ISO forms; unknown stays unknown", () => {
  const now = rome("14:00");
  strictEqual(parseResetTime("5-hour limit reached ∙ resets 3pm (Europe/Rome)", now, TZ), rome("15:00"));
  strictEqual(parseResetTime("You've hit your limit · resets at 15:30", now, TZ), rome("15:30"));
  strictEqual(parseResetTime("limit reached, resets 9am", now, TZ), rome("09:00", "07"), "9am has passed today: tomorrow");
  strictEqual(parseResetTime("Your limit resets in 2h 15m", now, TZ), now + 135 * 60_000);
  strictEqual(parseResetTime("retry after 1790819484", now, TZ), 1790819484 * 1000);
  strictEqual(parseResetTime("resets at 2026-10-06T17:00:00+02:00", now, TZ), rome("17:00"));
  strictEqual(parseResetTime("something went wrong", now, TZ), null);
  strictEqual(parseResetTime("", now, TZ), null);
});

async function codexHome(
  events: Array<{ at: string; primary: number; secondary: number; primaryReset: number; secondaryReset: number; reached?: string | null }>,
  source?: { cwd: string; sessionId: string },
) {
  const home = await mkdtemp(join(tmpdir(), "leftoff-codex-"));
  const dir = join(home, "sessions", "2026", "10", "01");
  await mkdir(dir, { recursive: true });
  const lines = [
    ...(source ? [JSON.stringify({ type: "session_meta", timestamp: events[0]?.at, payload: { id: source.sessionId, cwd: source.cwd } })] : []),
    // A first line cut in half, as a tail read produces.
    '{"timestamp":"2026-10-01T10:00:00Z","type":"event_msg","payload":{"type":"token_cou',
    ...events.map((e) =>
      JSON.stringify({
        timestamp: e.at,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: null,
          rate_limits: {
            primary: { used_percent: e.primary, window_minutes: 300, resets_at: e.primaryReset },
            secondary: { used_percent: e.secondary, window_minutes: 10080, resets_at: e.secondaryReset },
            rate_limit_reached_type: e.reached ?? null,
          },
        },
      }),
    ),
    '{"timestamp":"2026-10-01T10:05:00Z","type":"event_msg","payload":{"type":"agent_message"}}',
  ];
  await writeFile(join(dir, "rollout-2026-10-01T10-00-00-abc.jsonl"), lines.join("\n") + "\n", "utf8");
  return home;
}

test("Codex: the last reading in the newest session wins, with both windows named", async () => {
  const home = await codexHome([
    { at: "2026-10-01T10:01:00Z", primary: 10, secondary: 40, primaryReset: 1_790_000_000, secondaryReset: 1_790_500_000 },
    { at: "2026-10-01T10:04:00Z", primary: 82, secondary: 44, primaryReset: 1_790_000_000, secondaryReset: 1_790_500_000 },
  ]);
  const windows = await readCodexLimits({ codexHome: home, language: "it" });
  deepStrictEqual(windows.map((w) => [w.id, w.label, w.usedPercent]), [["codex:300", "5 ore", 82], ["codex:10080", "settimana", 44]]);
  strictEqual(windows[0]!.resetsAt, 1_790_000_000_000);
  deepStrictEqual(await readCodexLimits({ codexHome: join(home, "nowhere") }), []);
});

test("Codex limit readings retain the project session that produced them", async () => {
  const home = await codexHome(
    [{ at: "2026-10-01T10:04:00Z", primary: 100, secondary: 44, primaryReset: 1_790_000_000, secondaryReset: 1_790_500_000, reached: "rate_limit" }],
    { cwd: "/work/project", sessionId: "thread-1" },
  );
  const windows = await readCodexLimits({ codexHome: home, language: "it" });
  deepStrictEqual(windows[0]!.source, { cwd: "/work/project", sessionId: "thread-1" });
});

function codexWindows(used: number, resetsAt: number, week = 30): LimitWindow[] {
  return [
    { id: "codex:300", product: "Codex", label: "5 ore", usedPercent: used, resetsAt, reached: used >= 99.5, observedAt: 0 },
    { id: "codex:10080", product: "Codex", label: "settimana", usedPercent: week, resetsAt: resetsAt + 5 * 86_400_000, reached: false, observedAt: 0 },
  ];
}

test("one cycle: a warning, then the limit, then 'available again' — each exactly once", () => {
  const mem: Record<string, LimitMemory> = {};
  const opts = (now: number) => ({ now, warnAtPercent: 80, language: "it" as const, timezone: TZ });
  const reset = rome("17:00");

  strictEqual(evaluateLimits(codexWindows(60, reset), mem, opts(rome("12:00"))).length, 0, "below the threshold: silence");

  const warn = evaluateLimits(codexWindows(83, reset), mem, opts(rome("13:00")));
  deepStrictEqual(warn.map((a) => a.kind), ["warn"]);
  match(warn[0]!.text, /Codex, finestra 5 ore: usato l'83%/);
  match(warn[0]!.text, /alle 17:00 \(tra 4h 00m\)/);
  strictEqual(evaluateLimits(codexWindows(85, reset), mem, opts(rome("13:30"))).length, 0, "no second warning in the same cycle");

  const hit = evaluateLimits(codexWindows(100, reset), mem, opts(rome("14:00")));
  deepStrictEqual(hit.map((a) => a.kind), ["reached"]);
  match(hit[0]!.text, /⛔ Codex, finestra 5 ore ha raggiunto il limite\. Si sblocca alle 17:00/);
  strictEqual(evaluateLimits(codexWindows(100, reset), mem, opts(rome("15:00"))).length, 0, "no repeats while blocked");

  const back = evaluateLimits(codexWindows(100, reset), mem, opts(rome("17:01")));
  deepStrictEqual(back.map((a) => a.kind), ["back"]);
  match(back[0]!.text, /✅ Codex, finestra 5 ore è di nuovo disponibile/);
  strictEqual(evaluateLimits(codexWindows(100, reset), mem, opts(rome("17:30"))).length, 0, "and only once");
});

test("a new cycle starts the warnings over, and a jump straight to the limit skips the warning", () => {
  const mem: Record<string, LimitMemory> = {};
  const opts = (now: number) => ({ now, warnAtPercent: 80, language: "it" as const, timezone: TZ });
  evaluateLimits(codexWindows(90, rome("17:00")), mem, opts(rome("13:00")));
  // The next window: new resets_at, usage low again, then high again.
  strictEqual(evaluateLimits(codexWindows(5, rome("22:00")), mem, opts(rome("17:10"))).length, 0);
  deepStrictEqual(evaluateLimits(codexWindows(81, rome("22:00")), mem, opts(rome("18:00"))).map((a) => a.kind), ["warn"]);

  const fresh: Record<string, LimitMemory> = {};
  deepStrictEqual(evaluateLimits(codexWindows(100, rome("23:00")), fresh, opts(rome("19:00"))).map((a) => a.kind), ["reached"]);
});

test("Claude: reached with a known reset, 'available again' on the next good turn, and the unknown-reset wording", () => {
  const mem: Record<string, LimitMemory> = {};
  const opts = (now: number) => ({ now, warnAtPercent: 80, language: "it" as const, timezone: TZ });
  const claude = (reached: boolean, resetsAt: number | null): LimitWindow[] => [
    { id: "claude", product: "Claude Code", label: "", usedPercent: null, resetsAt, reached, observedAt: rome("13:00") },
  ];
  const first = evaluateLimits(claude(true, rome("15:00")), mem, opts(rome("13:00")));
  match(first[0]!.text, /Claude Code ha raggiunto il limite\. Si sblocca alle 15:00/);
  strictEqual(evaluateLimits(claude(true, rome("15:00")), mem, opts(rome("13:30"))).length, 0);
  match(evaluateLimits(claude(false, rome("15:00")), mem, opts(rome("15:10")))[0]!.text, /Claude Code è di nuovo disponibile/);

  const unknown: Record<string, LimitMemory> = {};
  match(evaluateLimits(claude(true, null), unknown, opts(rome("13:00")))[0]!.text, /Non so quando si sblocca/);
});

test("Claude: if the reset time passes with nobody trying, it says 'should be available' once", () => {
  const mem: Record<string, LimitMemory> = {};
  const opts = (now: number) => ({ now, warnAtPercent: 80, language: "it" as const, timezone: TZ });
  const w: LimitWindow[] = [{ id: "claude", product: "Claude Code", label: "", usedPercent: null, resetsAt: rome("15:00"), reached: true, observedAt: rome("13:00") }];
  evaluateLimits(w, mem, opts(rome("13:00")));
  match(evaluateLimits(w, mem, opts(rome("15:01")))[0]!.text, /dovrebbe essere di nuovo disponibile/);
  strictEqual(evaluateLimits(w, mem, opts(rome("15:30"))).length, 0, "not repeated for the same episode");
});

function hubWith(codex: string, quietOk = true) {
  process.env.CODEX_HOME = codex;
  const channel = new ConsoleChannel();
  const hub = new Hub({ config: ConfigSchema.parse({ timezone: TZ, language: "it", limits: { claude: false }, notify: { level: "all", quietHours: { enabled: quietOk, start: "22:00", end: "08:00" } } }), channel, log: () => undefined });
  void quietOk;
  return { hub, channel };
}

test("hub: warning and limit go to General; availability arrives at the reset, once", async () => {
  const resetSec = rome("17:00") / 1000;
  const home = await codexHome([{ at: "2026-10-06T11:00:00Z", primary: 84, secondary: 30, primaryReset: resetSec, secondaryReset: resetSec + 400_000 }]);
  const { hub, channel } = hubWith(home);
  await hub.tick(new Date(rome("13:00")));
  const general = () => channel.sent.filter((m) => m.projectId === null && /^(⚠️|⛔|✅) Codex/.test(m.text));
  strictEqual(general().length, 1);
  match(general()[0]!.text, /⚠️ Codex, finestra 5 ore: usato l'84%/);

  const full = await codexHome([{ at: "2026-10-06T12:00:00Z", primary: 100, secondary: 30, primaryReset: resetSec, secondaryReset: resetSec + 400_000, reached: "rate_limit" }]);
  process.env.CODEX_HOME = full;
  await hub.tick(new Date(rome("14:00")));
  match(general().at(-1)!.text, /⛔ Codex, finestra 5 ore ha raggiunto il limite/);

  await hub.tick(new Date(rome("17:02")));
  match(general().at(-1)!.text, /✅ Codex, finestra 5 ore è di nuovo disponibile/);
  const count = general().length;
  await hub.tick(new Date(rome("17:20")));
  strictEqual(general().length, count);
});

test("a Codex agent stopped by a limit restarts after the reset grace period", async () => {
  const paseoId = "11111111-2222-3333-4444-555555555555";
  const project = await tempProject({
    id: "autoresume",
    name: "Auto Resume",
    agents: [{ id: "codex", host: "codex", control: "paseo", paseoAgent: paseoId }],
  });
  await registerProject("autoresume", project.root);
  const resetSec = rome("17:00") / 1000;
  const home = await codexHome(
    [{ at: "2026-10-06T12:00:00Z", primary: 100, secondary: 30, primaryReset: resetSec, secondaryReset: resetSec + 400_000, reached: "rate_limit" }],
    { cwd: project.root, sessionId: "codex-thread" },
  );
  process.env.CODEX_HOME = home;
  const prompts: string[] = [];
  const exec = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    strictEqual(file, "paseo");
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: paseoId, shortId: paseoId.slice(0, 8), status: "idle" }]) };
    if (args[0] === "send") {
      prompts.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
      return { stdout: JSON.stringify({ status: "sent" }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  const channel = new ConsoleChannel();
  const hub = new Hub({
    config: ConfigSchema.parse({ timezone: TZ, language: "it", limits: { claude: false }, notify: { level: "all" } }),
    channel,
    exec,
    log: () => undefined,
  });
  await hub.tick(new Date(rome("14:00")));
  strictEqual(hub.state.resumeTargets.length, 1);
  strictEqual(hub.state.resumeTargets[0]!.resumeAt, resetSec * 1000 + 60_000);
  strictEqual(prompts.length, 0);
  await hub.tick(new Date(resetSec * 1000 + 59_000));
  strictEqual(prompts.length, 0, "never restart before the one-minute grace period");
  await hub.tick(new Date(resetSec * 1000 + 61_000));
  strictEqual(prompts.length, 1);
  match(prompts[0]!, /limite di Codex si è azzerato/);
  strictEqual(hub.state.resumeTargets.length, 0);
  ok(channel.sent.some((m) => /ho chiesto di ripartire/.test(m.text)));
});

test("a Claude agent stopped by StopFailure restarts after its parsed reset plus grace", async () => {
  const paseoId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const project = await tempProject({
    id: "claude-resume",
    name: "Claude Resume",
    agents: [{ id: "claude", host: "claude-code", control: "paseo", paseoAgent: paseoId }],
  });
  await registerProject("claude-resume", project.root);
  await runHook("stop-failure", { cwd: project.root, error: "rate_limit", error_details: "limit reached, resets in 1m" });
  const reset = (await readClaudeState()).resetsAt!;
  const prompts: string[] = [];
  const exec = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    strictEqual(file, "paseo");
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: paseoId, shortId: paseoId.slice(0, 8), status: "idle" }]) };
    if (args[0] === "send") {
      prompts.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
      return { stdout: JSON.stringify({ status: "sent" }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  const hub = new Hub({
    config: ConfigSchema.parse({ timezone: TZ, language: "it", limits: { codex: false }, notify: { level: "all" } }),
    channel: new ConsoleChannel(),
    exec,
    log: () => undefined,
  });
  await hub.tick(new Date(reset - 30_000));
  strictEqual(hub.state.resumeTargets.length, 1);
  strictEqual(hub.state.resumeTargets[0]!.resumeAt, reset + 60_000);
  await hub.tick(new Date(reset + 59_000));
  strictEqual(prompts.length, 0, "never restart before the one-minute grace period");
  await hub.tick(new Date(reset + 61_000));
  strictEqual(prompts.length, 1);
  match(prompts[0]!, /limite di Claude Code si è azzerato/);
});

test("hub at night: a limit hit and lifted while the owner slept is never mentioned", async () => {
  const resetSec = rome("23:50") / 1000;
  const home = await codexHome([{ at: "2026-10-06T21:00:00Z", primary: 100, secondary: 30, primaryReset: resetSec, secondaryReset: resetSec + 400_000, reached: "rate_limit" }]);
  const { hub, channel } = hubWith(home);
  await hub.tick(new Date(rome("23:00")));
  strictEqual(channel.sent.filter((m) => /Codex/.test(m.text)).length, 0, "quiet hours");
  await hub.tick(new Date(rome("23:55")));
  await hub.tick(new Date(rome("08:30", "07")));
  strictEqual(channel.sent.filter((m) => /Codex/.test(m.text)).length, 0, "reached + back collapsed");
});

test("hub at night: a limit announced before bedtime and lifted overnight is told in the morning", async () => {
  const resetSec = rome("23:50") / 1000;
  const home = await codexHome([{ at: "2026-10-06T19:00:00Z", primary: 100, secondary: 30, primaryReset: resetSec, secondaryReset: resetSec + 400_000, reached: "rate_limit" }]);
  const { hub, channel } = hubWith(home);
  await hub.tick(new Date(rome("21:30")));
  strictEqual(channel.sent.filter((m) => /raggiunto il limite/.test(m.text)).length, 1);
  await hub.tick(new Date(rome("23:55")));
  strictEqual(channel.sent.filter((m) => /disponibile/.test(m.text)).length, 0, "held back overnight");
  await hub.tick(new Date(rome("08:10", "07")));
  strictEqual(channel.sent.filter((m) => /disponibile/.test(m.text)).length, 1, "delivered when quiet hours end");
});

async function runHook(event: string, payload: unknown) {
  const child = spawn(process.execPath, [CLI, "hook", "claude-code", event], { env: { ...process.env, LEFTOFF_CONFIG_DIR: process.env.LEFTOFF_CONFIG_DIR } });
  child.stdin.end(JSON.stringify(payload));
  let out = "";
  child.stdout.on("data", (c) => (out += String(c)));
  const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? 0)));
  return { code, out };
}

test("Claude hooks: StopFailure(rate_limit) records the episode and its reset; a good Stop clears it", async () => {
  const none = await runHook("stop-failure", { cwd: "/tmp", error: "server_error" });
  strictEqual(none.code, 0);
  strictEqual((await readClaudeState()).limited, false, "other errors are not usage limits");

  const project = await tempProject({ id: "claude-limited", name: "Claude Limited", agents: [{ id: "claude", host: "claude-code", control: "inbox" }] });
  const hit = await runHook("stop-failure", {
    cwd: project.root,
    error: "rate_limit",
    error_details: "5-hour limit reached ∙ resets 3pm (Europe/Rome)",
    last_assistant_message: "",
  });
  strictEqual(hit.code, 0);
  strictEqual(hit.out.trim(), "", "a failure hook must never print");
  const state = await readClaudeState();
  ok(state.limited);
  ok(state.since);
  match(state.details, /resets 3pm/);
  ok(state.resetsAt && state.resetsAt > Date.now() - 1000);
  deepStrictEqual(state.targets, [{ projectRoot: project.root, projectId: "claude-limited", agentId: "claude" }]);

  await runHook("stop", { cwd: "/tmp" });
  const cleared = await readClaudeState();
  strictEqual(cleared.limited, false);
  ok(cleared.lastOkAt);
});

test("Italian reads right: l'83%, l'11%, il 60%, il 18%", () => {
  strictEqual(usedPhrase(83, "it"), "usato l'83%");
  strictEqual(usedPhrase(80, "it"), "usato l'80%");
  strictEqual(usedPhrase(11, "it"), "usato l'11%");
  strictEqual(usedPhrase(60, "it"), "usato il 60%");
  strictEqual(usedPhrase(18, "it"), "usato il 18%");
  strictEqual(usedPhrase(92, "it"), "usato il 92%");
  strictEqual(usedPhrase(83, "en"), "83% used");
});
