import { match, ok, strictEqual } from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { recordTurnEnd, recordTurnStart } from "../src/core/now.ts";
import type { Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { isolateHost, tempProject } from "./helpers.ts";

/** An agent that stops without a report and waits (D-065): the owner hears it at once, once per turn. Invented names. */
beforeEach(async () => {
  await isolateHost("leftoff-stuck-");
});

const UX = "33333333-3333-4333-8333-333333333333";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

function paseo(status: "idle" | "running" | "closed" = "idle") {
  const live = { status };
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: UX, status: live.status }]) };
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, live };
}

async function setup(status: "idle" | "running" | "closed" = "idle") {
  const harbor: Project = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX, label: "Harbor UX" }] });
  await registerProject("harbor", harbor.root);
  const p = paseo(status);
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const hub = new Hub({ config, channel, exec: p.exec, log: () => undefined });
  return { harbor, hub, channel, paseo: p };
}

const told = (channel: ConsoleChannel) => channel.sent.filter((m) => m.text.startsWith("⏸️"));

test("an agent whose turn ended on a question, with no report, is told to the owner once, after ten minutes", async () => {
  const { harbor, hub, channel } = await setup();
  const t0 = Date.now() - 30 * 60_000;
  await recordTurnStart(harbor, "ux", "claude-code", { prompt: "Wire the booking form" }, new Date(t0));
  await recordTurnEnd(harbor, "ux", new Date(t0 + 60_000));
  // No transcript, so no last words: Leftoff had sent it the request.
  hub.state.awaiting["harbor:ux"] = new Date(t0).toISOString();
  await hub.tick(new Date(t0 + 5 * 60_000));
  strictEqual(told(channel).length, 0, "not before ten minutes: its report may still come");
  await hub.tick(new Date(t0 + 12 * 60_000));
  strictEqual(told(channel).length, 1);
  match(told(channel)[0]!.text, /Harbor UX \(Harbor\) stopped at .* without a report\. It was doing: «Wire the booking form»\. It is probably waiting for you/);
  await hub.tick(new Date(t0 + 20 * 60_000));
  strictEqual(told(channel).length, 1, "once per turn");
});

test("an error that ended the turn is said; a report, a running session, or a turn nobody waits on say nothing", async () => {
  const a = await setup();
  const t0 = Date.now() - 30 * 60_000;
  await recordTurnStart(a.harbor, "ux", "claude-code", { prompt: "Deploy the preview" }, new Date(t0));
  await recordTurnEnd(a.harbor, "ux", new Date(t0 + 60_000), "authentication_failed");
  await a.hub.tick(new Date(t0 + 15 * 60_000));
  match(told(a.channel)[0]!.text, /on an error: authentication_failed/);

  // Reported after the turn began: nothing to tell.
  await isolateHost("leftoff-stuck-2-");
  const b = await setup();
  await recordTurnStart(b.harbor, "ux", "claude-code", { prompt: "Wire the form" }, new Date(t0));
  b.hub.state.awaiting["harbor:ux"] = new Date(t0).toISOString();
  await report(b.harbor, { ...base, agent: "ux", status: "done", done: ["Form wired"] } as never);
  await recordTurnEnd(b.harbor, "ux", new Date(t0 + 60_000));
  await b.hub.tick(new Date(t0 + 15 * 60_000));
  ok(!told(b.channel).length);

  // Still working in Paseo, or a turn nobody waits on (no request from Leftoff, no question, no error): nothing.
  await isolateHost("leftoff-stuck-3-");
  const c = await setup("running");
  await recordTurnStart(c.harbor, "ux", "claude-code", { prompt: "Wire the form" }, new Date(t0));
  await recordTurnEnd(c.harbor, "ux", new Date(t0 + 60_000));
  c.hub.state.awaiting["harbor:ux"] = new Date(t0).toISOString();
  await c.hub.tick(new Date(t0 + 15 * 60_000));
  ok(!told(c.channel).length, "running");
  c.paseo.live.status = "idle";
  delete c.hub.state.awaiting["harbor:ux"];
  await c.hub.tick(new Date(t0 + 16 * 60_000));
  ok(!told(c.channel).length, "nobody waits on it");
});
