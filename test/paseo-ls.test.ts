import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { listPaseoAgents, type ExecFn } from "../src/agents/delivery.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { recordTurnEnd, recordTurnStart } from "../src/core/now.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const PASEO = "7a2e4c1d-0000-4000-8000-0000000main1";

beforeEach(async () => {
  await isolateHost("leftoff-paseo-ls-");
});

/** A Paseo whose answers the test controls: how many times `ls` ran, what was sent, and when `ls` answers. */
function fakePaseo(status: "running" | "idle" = "running") {
  const state = { status, ls: 0, sent: [] as string[], hold: undefined as Promise<void> | undefined };
  const exec: ExecFn = async (_cmd, args) => {
    if (args[0] === "ls") {
      state.ls++;
      const answer = JSON.stringify([{ id: PASEO, status: state.status }]);
      if (state.hold) await state.hold;
      return { stdout: answer };
    }
    if (args[0] === "send") {
      // `paseo send <id> --prompt-file <file> …`: the text is in the file, read before Leftoff removes it.
      state.sent.push(await readFile(String(args[args.indexOf("--prompt-file") + 1]), "utf8"));
      return { stdout: JSON.stringify({ status: "sent" }) };
    }
    return { stdout: "{}" };
  };
  return { state, exec };
}

test("callers asking at the same time share one paseo ls; each gets its own copy", async () => {
  const { state, exec } = fakePaseo("idle");
  const [a, b, c] = await Promise.all([listPaseoAgents(exec), listPaseoAgents(exec), listPaseoAgents(exec)]);
  strictEqual(state.ls, 1);
  a![0]!.status = "running"; // the hub marks an agent it has just written to
  strictEqual(b![0]!.status, "idle", "one caller's change never reaches another");
  strictEqual(c!.length, 1);
  await listPaseoAgents(exec);
  strictEqual(state.ls, 2, "no cache in time: once it has answered, the next caller asks again");
});

test("a delivery only trusts a paseo ls that started after it asked; the views take the one in flight", async () => {
  const { state, exec } = fakePaseo("running");
  let release!: () => void;
  state.hold = new Promise<void>((r) => (release = r));
  const view = listPaseoAgents(exec); // in flight: Paseo saw the agent working
  state.status = "idle"; // …and it finished its turn while that call was running
  const delivery = listPaseoAgents(exec, { fresh: true });
  const another = listPaseoAgents(exec, { fresh: true });
  const alsoView = listPaseoAgents(exec);
  state.hold = undefined;
  release();
  strictEqual((await view)[0]!.status, "running");
  strictEqual((await alsoView)[0]!.status, "running", "a view joins the call in flight");
  strictEqual((await delivery)[0]!.status, "idle", "a delivery waits for a call that started after it asked");
  strictEqual((await another)[0]!.status, "idle");
  strictEqual(state.ls, 2, "the fresh askers share the one call that starts next");
});

async function harbor(host: "claude-code" | "codex" = "claude-code"): Promise<{ p: Project; agent: string }> {
  const agent = host === "codex" ? "codex" : "claude";
  const p = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: agent, control: "paseo", host, paseoAgent: PASEO }] });
  await registerProject("harbor", p.root);
  return { p, agent };
}

function hubWith(exec: ExecFn, agent: string, queuedAt: Date): Hub {
  const hub = new Hub({ config: ConfigSchema.parse({ language: "en", limits: { enabled: false }, statusChecks: { enabled: false } }), channel: new ConsoleChannel(), exec, log: () => undefined });
  hub.state.deliveryQueue.push({ id: "q1", projectId: "harbor", agentId: agent, paseoAgent: PASEO, text: "Run the tests.", kind: "command", queuedAt: queuedAt.toISOString() });
  return hub;
}

/** The 15-second flushes between two passes: they ask Paseo only on a hook's word. */
const between = async (hub: Hub) => {
  for (let i = 0; i < 4; i++) await hub.flushDeliveries(new Date(), { whenTurnEnded: true });
};

test("with the queue full and the agent working, the flushes between passes never start paseo ls", async () => {
  const { p, agent } = await harbor();
  await recordTurnStart(p, agent, "claude-code", { prompt: "A long task" }, new Date(Date.now() - 60_000));
  const paseo = fakePaseo("running");
  const hub = hubWith(paseo.exec, agent, new Date(Date.now() - 30_000));
  await between(hub);
  strictEqual(paseo.state.ls, 0);
  strictEqual(hub.state.deliveryQueue.length, 1);
});

test("when the hook says the turn ended, the next flush asks Paseo once and sends — only on a fresh «idle»", async () => {
  const { p, agent } = await harbor();
  const queuedAt = new Date(Date.now() - 30_000);
  await recordTurnStart(p, agent, "claude-code", { prompt: "A long task" }, new Date(Date.now() - 60_000));
  const paseo = fakePaseo("running");
  const hub = hubWith(paseo.exec, agent, queuedAt);
  await recordTurnEnd(await loadProject(p.root), agent);
  // The hook spoke, but Paseo still lists it working (it ended and started again): nothing is sent.
  await hub.flushDeliveries(new Date(), { whenTurnEnded: true });
  strictEqual(paseo.state.ls, 1);
  deepStrictEqual(paseo.state.sent, []);
  paseo.state.status = "idle";
  await hub.flushDeliveries(new Date(), { whenTurnEnded: true });
  strictEqual(paseo.state.ls, 2);
  deepStrictEqual(paseo.state.sent, ["Run the tests."]);
  strictEqual(hub.state.deliveryQueue.length, 0);
});

test("a hook that never fired costs at most one pass: every pass asks Paseo for every agent", async () => {
  const { agent } = await harbor();
  const paseo = fakePaseo("running");
  const hub = hubWith(paseo.exec, agent, new Date(Date.now() - 30_000));
  paseo.state.status = "idle"; // the turn ended, and no hook said so
  await between(hub);
  deepStrictEqual(paseo.state.sent, [], "between passes nothing asked");
  await hub.tick(new Date());
  deepStrictEqual(paseo.state.sent, ["Run the tests."], "the pass asked, saw it idle, and sent");
});

/** Run the real CLI as Codex would run its hooks, in the isolated home. */
async function codexHook(cwd: string, args: string[], stdin = ""): Promise<void> {
  const child = spawn(process.execPath, [CLI, "hook", "codex", ...args], { cwd, env: { ...process.env } });
  child.stdin.end(stdin);
  const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? 0)));
  strictEqual(code, 0, "a hook always exits 0");
}

test("Codex's notify is a turn end like Claude Code's Stop", async () => {
  const { p, agent } = await harbor("codex");
  const paseo = fakePaseo("running");
  const hub = hubWith(paseo.exec, agent, new Date(Date.now() - 30_000));
  await codexHook(p.root, ["user-prompt-submit"], JSON.stringify({ cwd: p.root, prompt: "A long task" }));
  await between(hub);
  strictEqual(paseo.state.ls, 0, "working: no hook has spoken yet");
  await codexHook(p.root, ["notify", JSON.stringify({ type: "agent-turn-complete", cwd: p.root })]);
  paseo.state.status = "idle";
  await hub.flushDeliveries(new Date(), { whenTurnEnded: true });
  ok(paseo.state.ls >= 1);
  deepStrictEqual(paseo.state.sent, ["Run the tests."]);
});
