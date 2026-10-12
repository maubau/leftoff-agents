import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import type { ActivityMeta, Channel, IncomingMessage, SendOptions } from "../src/channels/channel.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { enqueue, pending } from "../src/core/inbox.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub, type Contact } from "../src/hub/hub.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const IRIS = "2b3c4d5e-0000-4000-8000-0000000iris";
beforeEach(async () => {
  await isolateHost("leftoff-catchup-");
});

class Rec implements Channel {
  readonly name = "rec";
  readonly sent: Array<{ projectId: string | null; text: string }> = [];
  /** The activity register (D-052). */
  readonly logged: Array<{ projectId: string; text: string; meta: ActivityMeta }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(projectId: string | null, text: string, _options?: SendOptions): Promise<void> {
    this.sent.push({ projectId, text });
  }
  async activity(projectId: string, text: string, meta: ActivityMeta): Promise<void> {
    this.logged.push({ projectId, text, meta });
  }
}

/** A pretend Paseo whose session the test opens and closes; sending to a working session fails the test. */
function fakePaseo() {
  const sent: string[] = [];
  const session = { status: "closed" as "closed" | "idle" | "running" };
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: IRIS, shortId: "2b3c4d5", status: session.status }]) };
    if (args[0] === "send") {
      ok(session.status === "idle", `sent to a ${session.status} session`);
      sent.push(await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
      session.status = "running";
      return { stdout: '{"status":"sent"}' };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, sent, session };
}

function model(script: (prompt: string) => Array<[string, Record<string, unknown>]>) {
  const outcomes: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request: RunRequest): Promise<RunResult> {
      for (const [name, input] of script(request.prompt)) outcomes.push((await request.execute(name, input)).content);
      return { text: "Fatto.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  return { provider, outcomes };
}

const brief = (prompt: string): [string, Record<string, unknown>] => ["propose_agent_command", { project: "lighthouse", agent: "iris", prompt, summary: prompt, owner_asked: true, irreversible: false }];

async function setup(provider: ModelProvider, paseo = fakePaseo()) {
  const p: Project = await tempProject({ id: "lighthouse", name: "Lighthouse", agents: [{ id: "iris", control: "paseo", host: "claude-code", paseoAgent: IRIS, label: "Iris", role: "product marketing" }] });
  await registerProject("lighthouse", p.root);
  const chat = new Rec();
  const contacts: Contact[] = [];
  const hub = new Hub({ config: ConfigSchema.parse({ language: "it", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false }, notify: { quietHours: { enabled: false } } }), channel: chat, provider, exec: paseo.exec, onContact: (c) => contacts.push(c), log: () => undefined });
  const t0 = Date.now();
  await hub.tick(new Date(t0));
  const replies: string[] = [];
  const say = async (text: string) => {
    await hub.handle({ text, projectId: "lighthouse", threadKey: "web-lighthouse", reply: async (r) => void replies.push(r), typing: async () => undefined } satisfies IncomingMessage);
    return replies.at(-1) ?? "";
  };
  return { p, paseo, chat, hub, say, contacts, at: (m: number) => new Date(t0 + m * 60_000) };
}

test("an instruction for a closed session says it waits, and goes out by itself when the session is active again", async () => {
  const pm = model((q) => (q.includes("mercato") ? [brief("Scrivi il report di mercato.")] : []));
  const { p, paseo, chat, hub, say, contacts, at } = await setup(pm.provider);
  match(await say("di' a Iris di fare il report di mercato"), /Reply|Rispondi/);
  const reply = await say("sì");
  match(reply, /^Non ancora inviato: in attesa per Iris \(Lighthouse\)\./, "never «Inviato» for what waits");
  deepStrictEqual(paseo.sent, []);
  deepStrictEqual(contacts, [], "the office does not show a visit that did not happen");

  await hub.tick(at(1));
  deepStrictEqual(paseo.sent, [], "still closed: still waiting");

  paseo.session.status = "idle"; // the owner reopened it in Paseo
  await hub.tick(at(2));
  deepStrictEqual(paseo.sent, ["Scrivi il report di mercato."]);
  strictEqual((await pending(await loadProject(p.root), "iris")).length, 0);
  deepStrictEqual(contacts, [{ project: "lighthouse", agent: "iris", kind: "command" }]);
  ok(!chat.sent.some((m) => /📨/.test(m.text)), "a delivery is a step: no chat (D-052)");
  match(chat.logged.at(-1)!.text, /📨 Consegnato a Iris \(Lighthouse\)/);
  await hub.tick(at(3));
  strictEqual(paseo.sent.length, 1, "delivered once");
});

test("several waiting instructions go out in one message; Leftoff's own reminders and a working session wait", async () => {
  const pm = model(() => []);
  const { p, paseo, hub, at } = await setup(pm.provider);
  await enqueue(p, "iris", "Primo compito.", "user");
  await enqueue(p, "iris", "[leftoff] Scrivi il report del turno precedente.", "pm");
  await enqueue(p, "iris", "Secondo compito.", "user");
  paseo.session.status = "running";
  await hub.tick(at(1));
  deepStrictEqual(paseo.sent, [], "a working session is never interrupted");
  paseo.session.status = "idle";
  await hub.tick(at(2));
  deepStrictEqual(paseo.sent, ["Primo compito.\n\n---\n\nSecondo compito."]);
  deepStrictEqual((await pending(await loadProject(p.root), "iris")).map((m) => m.text), ["[leftoff] Scrivi il report del turno precedente."], "the reminder waits for its next turn");
});

test("autonomous: the PM is told what really happened — waiting in the inbox, not sent", async () => {
  const pm = model((q) => (q.includes("mercato") ? [brief("Scrivi il report di mercato.")] : []));
  const { hub, say } = await setup(pm.provider);
  await hub.setProjectMode("lighthouse", "autonomous", "panel");
  const reply = await say("di' a Iris di fare il report di mercato");
  match(pm.outcomes[0]!, /^Not sent yet: iris cannot be reached now \(la sessione Paseo è chiusa|^Not sent yet: iris cannot be reached now \(the Paseo session is closed/);
  match(reply, /Non ancora inviato: in attesa per Iris/);
});
