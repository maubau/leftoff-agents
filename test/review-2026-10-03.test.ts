/**
 * Regressions from an internal code review (2026-10-03). R1–R5 are the
 * reviewer's reproductions, unchanged in what they assert; all five failed on 7c9a383.
 * The tests after them cover what the fixes added. Only temporary repositories and
 * configuration and a fake model/Paseo/channel are used.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { pending } from "../src/core/inbox.ts";
import { loadProject, saveProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { recordClaudeLimit } from "../src/limits/claude.ts";
import { saveState } from "../src/hub/state.ts";
import type { ModelProvider } from "../src/pm/provider.ts";
import { tempProject } from "./helpers.ts";

const start = Date.parse("2026-10-06T10:00:00Z");
const reset = start + 3_600_000;
const previousEnv = { LEFTOFF_CONFIG_DIR: process.env.LEFTOFF_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
let directories: string[];

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "leftoff-review-"));
  directories = [dir];
  process.env.LEFTOFF_CONFIG_DIR = join(dir, "config");
  process.env.CODEX_HOME = join(dir, "codex");
});

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
});

async function project(id: string, host: "codex" | "claude-code" = "claude-code", visibility = "normal") {
  const p = await tempProject({
    id,
    name: id,
    visibility,
    agents: [{ id: "worker", host, control: "paseo", paseoAgent: `${id}-old-session` }],
  });
  directories.push(dirname(p.root));
  await registerProject(id, p.root);
  return p;
}

function harness(projects: Project[], provider?: ModelProvider, codex = false) {
  const sent: string[] = [];
  const channel = new ConsoleChannel();
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "it", timezone: "UTC", limits: { codex, claude: !codex }, notify: { level: "all" } }),
    channel,
    ...(provider ? { provider } : {}),
    exec: async (file, args) => {
      strictEqual(file, "paseo");
      if (args[0] === "ls") return { stdout: JSON.stringify(projects.flatMap((p) => p.config.agents.map((a) => ({ id: a.paseoAgent, status: "idle" })))) };
      if (args[0] === "send") {
        sent.push(args[1]!);
        return { stdout: JSON.stringify({ status: "sent" }) };
      }
      throw new Error(`Unexpected Paseo operation: ${args[0]}`);
    },
    // Tick errors must not accidentally turn a broken fixture into a passing test.
    log: (line) => { if (/failed:/.test(line)) throw new Error(line); },
  });
  hub.state.lastStandup = "2026-10-06";
  return { hub, channel, sent };
}

const target = (p: Project) => ({ projectRoot: p.root, projectId: p.id, agentId: "worker" });

async function codexReading(p: Project, weeklyFull: boolean) {
  const dir = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "06");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout-review.jsonl"), [
    { type: "session_meta", payload: { cwd: p.root, id: "original-codex-thread" } },
    {
      type: "event_msg", timestamp: new Date(start).toISOString(), payload: {
        type: "token_count", rate_limits: {
          primary: { used_percent: 100, window_minutes: 300, resets_at: reset / 1000 },
          secondary: { used_percent: weeklyFull ? 100 : 20, window_minutes: 10080, resets_at: (reset + 86_400_000) / 1000 },
          rate_limit_reached_type: "rate_limit",
        },
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

test("R1: a draft never shown after a provider failure cannot be approved", async () => {
  const p = await project("unseen-draft");
  const provider: ModelProvider = {
    id: "fake", model: "fake",
    async run(request) {
      const outcome = await request.execute("propose_agent_command", {
        project: p.id, agent: "worker", prompt: "UNSHOWN PROMPT", summary: "An unseen instruction",
      });
      strictEqual(outcome.isError, undefined);
      throw new Error("provider failed after drafting");
    },
  };
  // Model errors are expected here; Hub.handle catches them and reports them to chat.
  const sent: string[] = [];
  const hub = new Hub({
    config: ConfigSchema.parse({ limits: { enabled: false } }),
    channel: new ConsoleChannel(), provider, log: () => undefined,
    exec: async (_file, args) => {
      if (args[0] === "ls") return { stdout: JSON.stringify([{ id: p.config.agents[0]!.paseoAgent, status: "idle" }]) };
      strictEqual(args[0], "send");
      sent.push(args[1]!);
      return { stdout: '{"status":"sent"}' };
    },
  });
  const replies: string[] = [];
  const message = (text: string) => ({
    text, projectId: p.id, threadKey: "review",
    reply: async (text: string) => { replies.push(text); },
    typing: async () => undefined,
  });
  await hub.handle(message("Prepara una istruzione"));
  ok(!replies.some((text) => text.includes("UNSHOWN PROMPT")));
  await hub.handle(message("sì"));
  strictEqual(sent.length, 0, "no instruction may be sent before its prompt has been shown");
});

test("R2: agents hitting the same Claude limit on later polls are also scheduled", async () => {
  const a = await project("first-agent");
  const b = await project("second-agent");
  const { hub } = harness([a, b]);
  await recordClaudeLimit({ error_details: `resets at ${new Date(reset).toISOString()}` }, start, "UTC", target(a));
  await hub.tick(new Date(start));
  strictEqual(hub.state.resumeTargets.length, 1);
  await recordClaudeLimit({ error_details: `resets at ${new Date(reset).toISOString()}` }, start + 60_000, "UTC", target(b));
  await hub.tick(new Date(start + 60_000));
  deepStrictEqual(hub.state.resumeTargets.map((t) => t.projectId).sort(), [a.id, b.id].sort());
});

test("R3: resetting the short window must not wake an agent still at its weekly limit", async () => {
  const p = await project("dual-window", "codex");
  await codexReading(p, true);
  const { hub, sent } = harness([p], undefined, true);
  await hub.tick(new Date(start));
  strictEqual(hub.state.resumeTargets.length, 2);
  await hub.tick(new Date(reset + 61_000));
  strictEqual(sent.length, 0, "the weekly limit still blocks the same agent");
});

test("R4: changing the configured Paseo session must not redirect an armed restart", async () => {
  const p = await project("rebound-agent", "codex");
  await codexReading(p, false);
  const { hub, sent } = harness([p], undefined, true);
  await hub.tick(new Date(start));
  strictEqual(hub.state.resumeTargets.length, 1);
  // Mirrors ensureAgent updating the binding when a new session writes a report.
  p.config.agents[0]!.paseoAgent = "replacement-session";
  await saveProject(p.root, p.config);
  await hub.tick(new Date(reset + 61_000));
  ok(!sent.includes("replacement-session"), "the new session did not hit the recorded limit");
});

test("R5: a private project's automatic restart must not reveal its name in chat", async () => {
  const p = await project("private-project-name", "claude-code", "private");
  const { hub, channel } = harness([p]);
  await recordClaudeLimit({ error_details: `resets at ${new Date(reset).toISOString()}` }, start, "UTC", target(p));
  await hub.tick(new Date(start));
  await hub.tick(new Date(reset + 61_000));
  ok(!channel.sent.some((m) => m.text.includes(p.config.name)), "private projects must produce no identifying chat output");
});


// ───────────────────────── what the fixes added ─────────────────────────

const claudeHit = (p: Project, at: number, extra: Record<string, unknown> = {}) =>
  recordClaudeLimit({ error_details: `resets at ${new Date(reset).toISOString()}` }, at, "UTC", { ...target(p), ...extra });

test("R1: a draft that was shown survives a hub restart, and one that was not never reaches the disk", async () => {
  const p = await project("restart-draft");
  const sent: string[] = [];
  const exec = async (_f: string, args: string[]) => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: p.config.agents[0]!.paseoAgent, status: "idle" }]) };
    sent.push(args[1]!);
    return { stdout: '{"status":"sent"}' };
  };
  const proposing = (reply: boolean): ModelProvider => ({
    id: "fake", model: "fake",
    async run(request) {
      await request.execute("propose_agent_command", { project: p.id, agent: "worker", prompt: "SHOWN PROMPT", summary: "s" });
      if (!reply) throw new Error("model died");
      return { text: "Ok.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  });
  const make = (provider: ModelProvider) => new Hub({ config: ConfigSchema.parse({ limits: { enabled: false } }), channel: new ConsoleChannel(), provider, exec, log: () => undefined });
  const msg = (text: string) => ({ text, projectId: p.id, threadKey: "t", reply: async () => undefined, typing: async () => undefined });

  const failing = make(proposing(false));
  await failing.handle(msg("prepara"));
  strictEqual(Object.keys(failing.state.proposals).length, 0, "nothing approvable after a failure");

  const first = make(proposing(true));
  await first.handle(msg("prepara"));
  await saveState(first.state);
  const second = make(proposing(true));
  await second.start();
  await second.handle(msg("sì"));
  await second.stop();
  deepStrictEqual(sent, [p.config.agents[0]!.paseoAgent], "the shown draft survived the restart and went out once");
});

test("R1: if the reply carrying the draft never goes out, the draft is not approvable", async () => {
  const p = await project("reply-fails");
  const sent: string[] = [];
  const provider: ModelProvider = {
    id: "fake", model: "fake",
    async run(request) {
      await request.execute("propose_agent_command", { project: p.id, agent: "worker", prompt: "NEVER SEEN", summary: "s" });
      return { text: "Ok.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const hub = new Hub({
    config: ConfigSchema.parse({ limits: { enabled: false } }), channel: new ConsoleChannel(), provider, log: () => undefined,
    exec: async (_f, args) => (args[0] === "ls" ? { stdout: JSON.stringify([{ id: p.config.agents[0]!.paseoAgent, status: "idle" }]) } : (sent.push(args[1]!), { stdout: '{"status":"sent"}' })),
  });
  let down = true;
  const message = (text: string) => ({
    text, projectId: p.id, threadKey: "t",
    reply: async () => { if (down) throw new Error("channel down"); },
    typing: async () => undefined,
  });
  await hub.handle(message("prepara")).catch(() => undefined);
  down = false;
  await hub.handle(message("sì"));
  strictEqual(sent.length, 0);
});

test("R1: when a revision fails, the earlier draft stays and the owner is told so", async () => {
  const p = await project("revision-fails");
  let calls = 0;
  const provider: ModelProvider = {
    id: "fake", model: "fake",
    async run(request) {
      if (++calls === 2) throw new Error("boom");
      await request.execute("propose_agent_command", { project: p.id, agent: "worker", prompt: "FIRST DRAFT", summary: "s" });
      return { text: "Ok.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const sent: string[] = [];
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "it", limits: { enabled: false } }), channel: new ConsoleChannel(), provider, log: () => undefined,
    exec: async (_f, args) => (args[0] === "ls" ? { stdout: JSON.stringify([{ id: p.config.agents[0]!.paseoAgent, status: "idle" }]) } : (sent.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8")), { stdout: '{"status":"sent"}' })),
  });
  const replies: string[] = [];
  const message = (text: string) => ({ text, projectId: p.id, threadKey: "t", reply: async (r: string) => void replies.push(r), typing: async () => undefined });
  await hub.handle(message("prepara"));
  await hub.handle(message("ok ma cambia la data"));
  match(replies.at(-1)!, /La bozza che ti ho mostrato prima è ancora in attesa/);
  await hub.handle(message("sì"));
  deepStrictEqual(sent, ["FIRST DRAFT"], "only what was shown can be sent");
});

test("R5: a project that turns private while its notice waits in the queue is dropped at send time", async () => {
  const p = await project("turns-private");
  const { hub, channel } = harness([p]);
  hub.state.queued.push({ projectId: null, text: "▶️ Worker (turns-private): limite azzerato", at: new Date(start).toISOString(), key: "resume:x", about: [p.id] });
  hub.state.queued.push({ projectId: null, text: "a general notice", at: new Date(start).toISOString(), key: "general" });
  p.config.visibility = "private";
  await saveProject(p.root, p.config);
  await hub.tick(new Date(start));
  ok(!channel.sent.some((m) => m.text.includes("turns-private")), "no private name after the project went private");
  ok(channel.sent.some((m) => m.text === "a general notice"), "unrelated queued notices still go out");
  strictEqual(hub.state.queued.length, 0, "and the queue does not clog");
});

test("R5: a private project is still restarted — only the chat stays silent about it", async () => {
  const p = await project("private-but-restarted", "claude-code", "private");
  const { hub, channel, sent } = harness([p]);
  await claudeHit(p, start);
  await hub.tick(new Date(start));
  await hub.tick(new Date(reset + 61_000));
  deepStrictEqual(sent, ["private-but-restarted-old-session"], "the agent is woken: that is the owner's D-024");
  ok(!channel.sent.some((m) => /private-but-restarted|ripartire/.test(m.text)));
});

test("R5: the 'restart scheduled' count never includes private projects", async () => {
  const open = await project("open-one");
  const secret = await project("secret-one", "claude-code", "private");
  const { hub, channel } = harness([open, secret]);
  await claudeHit(open, start);
  await claudeHit(secret, start + 1);
  await hub.tick(new Date(start));
  const reached = channel.sent.find((m) => /raggiunto il limite/.test(m.text))!;
  match(reached.text, /Ripartenza automatica programmata per l’agente fermato\./, "one visible agent, not two");
});

test("R4: the restart reaches the session that stopped, even after the project was rebound", async () => {
  const p = await project("rebound-live");
  const old = p.config.agents[0]!.paseoAgent!;
  const sent: string[] = [];
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "it", timezone: "UTC", limits: { codex: false, claude: true }, notify: { level: "all" } }), channel: new ConsoleChannel(), log: () => undefined,
    exec: async (_f, args) => (args[0] === "ls" ? { stdout: JSON.stringify([{ id: old, status: "idle" }, { id: "replacement", status: "idle" }]) } : (sent.push(args[1]!), { stdout: '{"status":"sent"}' })),
  });
  hub.state.lastStandup = "2026-10-06";
  await claudeHit(p, start, { paseoAgent: old });
  await hub.tick(new Date(start));
  p.config.agents[0]!.paseoAgent = "replacement";
  await saveProject(p.root, p.config);
  await hub.tick(new Date(reset + 61_000));
  deepStrictEqual(sent, [old]);
});

test("R4: an unreachable stopped session gets nothing — not the replacement, not the shared inbox — and the owner is told", async () => {
  const p = await project("gone-session");
  const { hub, channel, sent } = harness([p]);
  await claudeHit(p, start);
  await hub.tick(new Date(start));
  p.config.agents[0]!.paseoAgent = "replacement";
  await saveProject(p.root, p.config);
  await hub.tick(new Date(reset + 61_000));
  strictEqual(sent.length, 0);
  strictEqual((await pending(await loadProject(p.root), "worker")).length, 0, "the inbox is per logical agent: it would reach the new session");
  ok(channel.sent.some((m) => /non è più raggiungibile/.test(m.text) && /Non ho riavviato nessun'altra sessione/.test(m.text)));
});

test("R4: targets armed before sessions were recorded are pinned to today's link on start", async () => {
  const p = await project("legacy-target");
  const { hub } = harness([p]);
  hub.state.resumeTargets.push({ windowId: "claude", product: "Claude Code", projectId: p.id, projectRoot: p.root, agentId: "worker", resumeAt: reset + 60_000, armedAt: new Date(start).toISOString() });
  await saveState(hub.state);
  await hub.start();
  await hub.stop();
  strictEqual(hub.state.resumeTargets[0]!.paseoAgent, "legacy-target-old-session");
});

test("R2: a second agent stopped later is woken with the first, each exactly once", async () => {
  const a = await project("woken-a");
  const b = await project("woken-b");
  const { hub, sent } = harness([a, b]);
  await claudeHit(a, start);
  await hub.tick(new Date(start));
  await claudeHit(b, start + 60_000);
  await hub.tick(new Date(start + 60_000));
  await hub.tick(new Date(reset + 61_000));
  deepStrictEqual(sent.sort(), ["woken-a-old-session", "woken-b-old-session"]);
  await hub.tick(new Date(reset + 120_000));
  await hub.tick(new Date(reset + 180_000));
  strictEqual(sent.length, 2, "a limit that still reads 'reached' never restarts anyone twice");
});

test("R2: a stale 'limit reached' Codex reading never re-arms an agent that has just been restarted", async () => {
  const p = await project("stale-reading", "codex");
  await codexReading(p, false);
  const { hub, sent } = harness([p], undefined, true);
  await hub.tick(new Date(start));
  await hub.tick(new Date(reset + 61_000));
  await hub.tick(new Date(reset + 120_000));
  await hub.tick(new Date(reset + 600_000));
  deepStrictEqual(sent, ["stale-reading-old-session"]);
  strictEqual(hub.state.resumeTargets.length, 0);
});

test("R3: an agent blocked by both windows restarts once, after the last of them", async () => {
  const p = await project("both-windows", "codex");
  await codexReading(p, true);
  const { hub, sent } = harness([p], undefined, true);
  await hub.tick(new Date(start));
  await hub.tick(new Date(reset + 61_000));
  strictEqual(sent.length, 0, "the weekly window still blocks it");
  await hub.tick(new Date(reset + 86_400_000 + 61_000));
  strictEqual(sent.length, 1, "one restart, when everything has lifted");
  await hub.tick(new Date(reset + 86_400_000 + 180_000));
  strictEqual(sent.length, 1);
  strictEqual(hub.state.resumeTargets.length, 0);
});
