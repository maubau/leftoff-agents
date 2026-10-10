import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Channel, IncomingMessage, SendOptions } from "../src/channels/channel.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub, type Contact } from "../src/hub/hub.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { Data } from "../src/web/data.ts";
import { Feed } from "../src/web/feed.ts";
import { WebServer } from "../src/web/server.ts";
import { Settings } from "../src/web/settings.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const MAIN = "6f1d2c3b-0000-4000-8000-00000000main";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
let dir = "";
const servers: WebServer[] = [];

beforeEach(async () => {
  dir = await isolateHost("leftoff-modes-");
});
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

class Rec implements Channel {
  readonly name = "rec";
  readonly sent: Array<{ projectId: string | null; text: string; options?: SendOptions | undefined }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(projectId: string | null, text: string, options?: SendOptions): Promise<void> {
    this.sent.push({ projectId, text, options });
  }
}

/** A pretend `paseo` running the main dev, recording what it is sent. */
function fakePaseo() {
  const sent: string[] = [];
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: MAIN, shortId: "6f1d2c3", status: "idle" }]) };
    if (args[0] === "send") {
      sent.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
      return { stdout: '{"status":"sent"}' };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, sent };
}

/** A model that runs whatever tool calls the test gives for the owner's words, then says one thing. */
function model(script: (prompt: string) => Array<[string, Record<string, unknown>]> = () => []) {
  const outcomes: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request: RunRequest): Promise<RunResult> {
      for (const [name, input] of script(request.prompt)) outcomes.push((await request.execute(name, input)).content);
      return { text: "Noted.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  return { provider, outcomes };
}

const instruct = (prompt: string, flags: { owner_asked?: boolean; irreversible?: boolean } = {}): [string, Record<string, unknown>] => [
  "propose_agent_command",
  { project: "harbor", agent: "main-dev", prompt, summary: prompt, owner_asked: flags.owner_asked ?? true, irreversible: flags.irreversible ?? false },
];

async function team(): Promise<Project> {
  const p = await tempProject({
    id: "harbor",
    name: "Harbor",
    agents: [
      { id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: MAIN, label: "Harbor Main Dev", role: "architect and backend" },
      { id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX", role: "frontend and UX" },
    ],
  });
  await registerProject("harbor", p.root);
  return p;
}

async function setup(provider = model().provider, config: Record<string, unknown> = {}) {
  const p = await team();
  const paseo = fakePaseo();
  const chat = new Rec();
  const contacts: Contact[] = [];
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false }, ...config }),
    channel: chat,
    provider,
    exec: paseo.exec,
    onContact: (c) => contacts.push(c),
    log: () => undefined,
  });
  const t0 = Date.now();
  await hub.tick(new Date(t0));
  const replies: Array<{ text: string; options?: SendOptions | undefined }> = [];
  const say = async (text: string): Promise<string> => {
    await hub.handle({ text, projectId: "harbor", threadKey: "telegram-7", reply: async (r, options) => void replies.push({ text: r, options }), typing: async () => undefined } satisfies IncomingMessage);
    return replies.at(-1)?.text ?? "";
  };
  const at = (minutes: number) => new Date(t0 + minutes * 60_000);
  const decisions = async () => readFile(join(p.root, ".leftoff", "decisions.md"), "utf8").catch(() => "");
  return { p, paseo, chat, hub, say, replies, at, contacts, decisions };
}

test("control is the default: what the owner asks for is a draft, and the PM no longer asks before drafting", async () => {
  const pm = model((prompt) => (prompt.includes("merge") ? [instruct("Merge PR 12 into main once CI is green.")] : []));
  const { paseo, hub, say } = await setup(pm.provider);
  strictEqual(hub.projectMode("harbor"), "control");
  match(await say("tell main-dev to merge PR 12"), /Reply "yes" to send it/);
  deepStrictEqual(paseo.sent, []);
  match(pm.outcomes[0]!, /nothing is sent until they approve/);
});

test("autonomous: what the owner asks for goes out at once, is recorded, and the owner is told", async () => {
  const pm = model((prompt) => (prompt.includes("merge") ? [instruct("Merge PR 12 into main once CI is green.")] : []));
  const { paseo, hub, say, replies, contacts, decisions } = await setup(pm.provider);
  await hub.setProjectMode("harbor", "autonomous", "panel");

  const reply = await say("tell main-dev to merge PR 12");
  deepStrictEqual(paseo.sent, ["Merge PR 12 into main once CI is green."]);
  match(reply, /Sent to Harbor Main Dev/);
  ok(!/Reply "yes"/.test(reply) && replies.at(-1)!.options === undefined, "no draft, no Yes/No buttons");
  deepStrictEqual(hub.state.proposals, {}, "nothing waits for a yes");
  match(pm.outcomes[0]!, /goes to main-dev .* right after your reply/);
  deepStrictEqual(contacts.at(-1), { project: "harbor", agent: "main-dev", kind: "command" });
  strictEqual(hub.state.sent.length, 1, "it counts towards the daily cap");
  match(await decisions(), /autonomous mode: sent without asking for a yes/);
});

test("autonomous, yet a destructive instruction waits for a yes — flagged by the PM, or caught in code", async () => {
  const pm = model((prompt) =>
    prompt.includes("staging")
      ? [instruct("Delete the staging environment.", { irreversible: true })]
      : prompt.includes("rebase")
        ? [instruct("Force-push the rebased branch over main.", { irreversible: false })]
        : [],
  );
  const { paseo, hub, say } = await setup(pm.provider);
  await hub.setProjectMode("harbor", "autonomous", "panel");
  match(await say("wipe staging"), /needs your yes: it looks destructive or irreversible[\s\S]*Reply "yes" to send it/);
  delete hub.state.proposals["telegram-7"];
  match(await say("rebase and push"), /needs your yes: it looks destructive/, "the PM said it was harmless; the code did not agree");
  deepStrictEqual(paseo.sent, []);
  strictEqual(hub.state.proposals["telegram-7"]?.hold, "risky");
  match(await say("yes"), /Sent to Harbor Main Dev/);
  deepStrictEqual(paseo.sent, ["Force-push the rebased branch over main."]);
});

test("autonomous, yet the PM's own idea waits for a yes", async () => {
  const pm = model((prompt) => (prompt.includes("where are we") ? [instruct("Add retries to the iCal sync.", { owner_asked: false })] : []));
  const { paseo, hub, say } = await setup(pm.provider);
  await hub.setProjectMode("harbor", "autonomous", "panel");
  match(await say("where are we?"), /my own idea, not something you asked: it needs your yes/);
  deepStrictEqual(paseo.sent, []);
});

test("autonomous: once the daily cap is reached, instructions wait for a yes again", async () => {
  const pm = model((prompt) => (prompt.includes("merge") ? [instruct("Merge PR 12.")] : []));
  const { paseo, hub, say } = await setup(pm.provider, { commands: { maxPerDay: 1 } });
  await hub.setProjectMode("harbor", "autonomous", "panel");
  hub.state.sent.push(new Date().toISOString());
  match(await say("merge it"), /Reply "yes" to send it/);
  deepStrictEqual(paseo.sent, []);
});

test("autonomous: a teammate's handoff is passed on by itself and the owner is told; a destructive one is shown for a yes", async () => {
  const { p, paseo, chat, hub, at, decisions } = await setup();
  await hub.setProjectMode("harbor", "autonomous", "panel");
  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["main-dev: expose GET /api/bookings"], at: at(1).toISOString() });
  await hub.tick(at(2));
  strictEqual(paseo.sent.length, 1);
  match(paseo.sent[0]!, /«expose GET \/api\/bookings»/);
  const told = chat.sent.filter((m) => m.projectId === "harbor").at(-1)!;
  match(told.text, /Passed on automatically \(autonomous mode\): 🎨 Harbor UX → 🛠️ Harbor Main Dev \(Harbor\)\n«expose GET \/api\/bookings»/);
  strictEqual(told.options, undefined, "nothing to approve");
  deepStrictEqual(hub.state.handoffs, []);
  strictEqual(hub.state.handoffReplies["harbor:main-dev"], "ux", "the answer still goes back to the asker");
  match(await decisions(), /Handoff approved: Harbor UX → Harbor Main Dev: expose GET \/api\/bookings/);

  await report(await loadProject(p.root), { ...base, agent: "ux", status: "progress", handoff: ["main-dev: delete the old release branches"], at: at(3).toISOString() });
  await hub.tick(at(4));
  strictEqual(paseo.sent.length, 1, "not forwarded");
  const shown = chat.sent.filter((m) => m.projectId === "harbor").at(-1)!;
  match(shown.text, /needs your yes: it looks destructive[\s\S]*🤝 Handoff/);
  ok(shown.options, "with Yes/No");
});

test("in control mode a handoff is still shown for a yes", async () => {
  const { p, paseo, chat, hub, at } = await setup();
  await report(p, { ...base, agent: "ux", status: "progress", handoff: ["main-dev: expose GET /api/bookings"], at: at(1).toISOString() });
  await hub.tick(at(2));
  deepStrictEqual(paseo.sent, []);
  match(chat.sent.filter((m) => m.projectId === "harbor").at(-1)!.text, /🤝 Handoff/);
});

test("from chat: autonomy is asked once with Yes/No and recorded; back to control is immediate", async () => {
  const pm = model((prompt) =>
    prompt.includes("on your own") ? [["set_project_mode", { project: "harbor", mode: "autonomous" }]] : prompt.includes("always ask") ? [["set_project_mode", { project: "harbor", mode: "control" }]] : [],
  );
  const { hub, say, replies, decisions } = await setup(pm.provider);
  match(await say("go ahead on your own on Harbor"), /Turn on autonomous mode for Harbor\?/);
  ok(replies.at(-1)!.options, "Yes/No buttons");
  strictEqual(hub.projectMode("harbor"), "control", "not before the owner's yes");
  match(await say("yes"), /Harbor: autonomous mode/);
  strictEqual(hub.projectMode("harbor"), "autonomous");
  match(await decisions(), /Project manager mode: autonomous\n[\s\S]*chat/);

  await say("always ask me first on Harbor");
  strictEqual(hub.projectMode("harbor"), "control", "no question to turn autonomy off");
  match(pm.outcomes.at(-1)!, /control mode now/);
});

test("a «no» drops the autonomy question; it is never asked while a draft waits in the thread", async () => {
  const pm = model((prompt) =>
    prompt.includes("on your own") ? [["set_project_mode", { project: "harbor", mode: "autonomous" }]] : prompt.includes("merge") ? [instruct("Merge PR 12.")] : [],
  );
  const { hub, say } = await setup(pm.provider);
  await say("go ahead on your own");
  await say("no");
  deepStrictEqual(hub.state.modeRequests, {});
  strictEqual(hub.projectMode("harbor"), "control");

  await say("merge it");
  ok(hub.state.proposals["telegram-7"], "a draft waits");
  await say("ok but go ahead on your own from now");
  match(pm.outcomes.at(-1)!, /must decide it before autonomy can be asked/);
  deepStrictEqual(hub.state.modeRequests, {});
});

test("the panel switches the mode at once, says so in the project's thread, and shows it", async () => {
  await team();
  const chat = new Rec();
  const feed = new Feed(join(dir, "feed.jsonl"));
  await feed.load();
  const mirror = new MirrorChannel(chat, feed);
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false } });
  const hub = new Hub({ config, channel: mirror, exec: fakePaseo().exec, log: () => undefined });
  const web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0 }, data: new Data({ config, state: () => hub.state, exec: fakePaseo().exec }), feed, mirror, settings: new Settings({ config, modes: hub }), log: () => undefined });
  await web.start();
  servers.push(web);
  const url = `http://127.0.0.1:${web.port}`;
  const post = (body: unknown) => fetch(`${url}/api/settings/projects/harbor/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  strictEqual(((await (await fetch(`${url}/api/overview`)).json()) as any).projects[0].mode, "control");
  const res = await post({ mode: "autonomous" });
  strictEqual(res.status, 200);
  deepStrictEqual(await res.json(), { mode: "autonomous" });
  strictEqual(hub.projectMode("harbor"), "autonomous");
  match(chat.sent.at(-1)!.text, /🤖 Harbor: autonomous mode/);
  strictEqual(((await (await fetch(`${url}/api/projects/harbor`)).json()) as any).project.mode, "autonomous");
  strictEqual((await post({ mode: "reckless" })).status, 400);
  strictEqual((await post({ mode: "control" })).status, 200);
  strictEqual(hub.projectMode("harbor"), "control");
});

test("a repository cannot make its project autonomous: the mode lives in the hub's state, not in project.yaml", async () => {
  const pm = model((prompt) => (prompt.includes("merge") ? [instruct("Merge PR 12.")] : []));
  const { p, paseo, hub, say } = await setup(pm.provider);
  const file = join(p.root, ".leftoff", "project.yaml");
  await writeFile(file, `${await readFile(file, "utf8")}mode: autonomous\n`, "utf8");
  strictEqual(hub.projectMode("harbor"), "control");
  match(await say("merge it"), /Reply "yes" to send it/);
  deepStrictEqual(paseo.sent, []);
});

test("autonomous: two instructions in one answer both go out, each told", async () => {
  const pm = model((prompt) => (prompt.includes("both") ? [instruct("Merge PR 12."), ["propose_agent_command", { project: "harbor", agent: "ux", prompt: "Update the changelog.", summary: "changelog", owner_asked: true, irreversible: false }]] : []));
  const { paseo, hub, say } = await setup(pm.provider);
  await hub.setProjectMode("harbor", "autonomous", "panel");
  const reply = await say("both, please");
  deepStrictEqual(paseo.sent, ["Merge PR 12."], "main-dev through Paseo");
  match(reply, /Sent to Harbor Main Dev[\s\S]*Harbor UX/, "and ux through its inbox, both told");
  strictEqual(hub.state.sent.length, 2);
});
