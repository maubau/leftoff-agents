import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { readFile as read } from "node:fs/promises";
import type { IncomingMessage } from "../src/channels/channel.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { pending } from "../src/core/inbox.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { isApproval, isCancellation } from "../src/hub/approval.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import type { Transcriber } from "../src/voice/transcriber.ts";
import { tempProject, isolateHost } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-cmd-");
});

const PASEO_ID = "0d8b831c-70bd-4ef5-add9-e5e1931b60a8";
const DRAFT = "Aggiungi la validazione delle date al form di prenotazione.\nContesto: il form esiste già.\nAssunzione: formato GG/MM/AAAA.\nFinito quando i test del form passano.";
const REVISED = `${DRAFT}\nIncludi anche i test per le date nel passato.`;

async function clipforge(extra: Record<string, unknown> = {}): Promise<Project> {
  const p = await tempProject({
    id: "clipforge",
    name: "Clipforge",
    agents: [{ id: "claude", control: "paseo", host: "claude-code", paseoAgent: PASEO_ID }],
    ...extra,
  });
  await registerProject("clipforge", p.root);
  return p;
}

/** A pretend `paseo`: lists one agent in the given state and records what is sent. */
function fakePaseo(status: "running" | "idle" | "closed" = "idle", options: { failSend?: boolean } = {}) {
  const sent: string[] = [];
  /** What Paseo says the agent is doing; a test can let it finish its turn. */
  const agent = { status };
  const exec = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    strictEqual(file, "paseo");
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: PASEO_ID, shortId: "0d8b831", status: agent.status }]) };
    if (args[0] === "send") {
      if (options.failSend) throw new Error("daemon down");
      ok(agent.status !== "running", "never sent to a working agent: Paseo would interrupt its turn");
      strictEqual(args[1], PASEO_ID);
      strictEqual(args.includes("--no-wait"), true, "never block waiting for the agent");
      sent.push(await read(args[args.indexOf("--prompt-file") + 1]!, "utf8"));
      return { stdout: JSON.stringify({ agentId: PASEO_ID, status: "sent" }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, sent, agent };
}

type Script = (request: RunRequest) => Promise<string>;
function scripted(...steps: Script[]) {
  const seen: RunRequest[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      seen.push(request);
      const text = await steps.shift()!(request);
      return { text, model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  return { provider, seen };
}

const proposing = (prompt: string, agent = "claude", project = "clipforge"): Script => async (request) => {
  const outcome = await request.execute("propose_agent_command", { project, agent, prompt, summary: "Aggiungere la validazione delle date" });
  if (outcome.isError) return `Errore: ${outcome.content}`;
  return "Dico a Claude di validare le date nel form. Assumo il formato italiano.";
};

function chat(hub: Hub, threadKey = "t1") {
  const replies: string[] = [];
  const text = (t: string): IncomingMessage => ({
    text: t,
    projectId: "clipforge",
    threadKey,
    reply: async (r) => void replies.push(r),
    typing: async () => undefined,
  });
  return { replies, text, last: () => replies.at(-1)! };
}

function makeHub(provider: ModelProvider, paseo: ReturnType<typeof fakePaseo>, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const channel = new ConsoleChannel();
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "it", timezone: "Europe/Rome", ...config }),
    channel,
    provider,
    exec: paseo.exec,
    log: () => undefined,
    ...extra,
  });
  return { hub, channel };
}

test("the words that approve are a fixed list, and 'yes, but…' is not one of them", () => {
  for (const yes of ["Sì", "sì!", "Si.", "va bene", "Va bene, mandalo", "ok", "OK mandalo", "Sì, vai", "perfetto grazie", "manda", "invialo", "Confermo", "yes", "d'accordo"]) {
    ok(isApproval(yes), yes);
  }
  for (const no of ["ok ma aggiungi i test", "sì ma solo su Harbor", "non va bene", "forse", "no", "va bene, però fallo dopo pranzo", "sì e poi cancella il branch", "", "1", "leaflet"]) {
    ok(!isApproval(no), no);
  }
  for (const cancel of ["no", "No grazie", "annulla", "Lascia stare", "stop", "non mandarlo", "cancella"]) ok(isCancellation(cancel), cancel);
  for (const keep of ["no, cambia la data", "annulla la parte dei test", "no ma aggiungi", "ok"]) ok(!isCancellation(keep), keep);
});

test("a request becomes a draft shown word for word — and nothing is sent", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider } = scripted(proposing(DRAFT));
  const { hub } = makeHub(provider, paseo);
  const c = chat(hub);
  await hub.handle(c.text("dì a Claude di controllare le date nel form"));

  const reply = c.last();
  match(reply, /Dico a Claude di validare le date/, "the PM's own short summary comes first");
  match(reply, /📨 Bozza per Claude — Clipforge/);
  ok(reply.includes(DRAFT), "the draft is shown exactly as stored");
  match(reply, /Rispondi «sì» per inviarla/);
  match(reply, /💤 È fermo/);
  strictEqual(paseo.sent.length, 0, "nothing leaves before the owner says yes");
  strictEqual(hub.state.proposals["t1"]!.prompt, DRAFT);
});

test("'sì' sends exactly the shown text, records it, and the model is not asked", async () => {
  const p = await clipforge();
  const paseo = fakePaseo("running");
  const { provider, seen } = scripted(proposing(DRAFT));
  const { hub } = makeHub(provider, paseo);
  const c = chat(hub);
  await hub.handle(c.text("dì a Claude di controllare le date"));
  await hub.handle(c.text("Sì."));

  deepStrictEqual(paseo.sent, [], "it is working: nothing interrupts it");
  match(c.last(), /✅ Inviato a Claude \(Clipforge\)\. Sta lavorando: glielo consegno quando finisce il turno in corso, senza interromperlo/);
  strictEqual(seen.length, 1, "approving costs no model call");
  strictEqual(hub.state.proposals["t1"], undefined);
  strictEqual(hub.state.deliveryQueue.length, 1);
  await hub.flushDeliveries();
  deepStrictEqual(paseo.sent, [], "still working: still waiting");
  paseo.agent.status = "idle";
  await hub.flushDeliveries();
  deepStrictEqual(paseo.sent, [DRAFT], "byte for byte what was shown, once its turn ended");
  deepStrictEqual(hub.state.deliveryQueue, []);
  ok(hub.state.awaiting["clipforge:claude"]);
  const decisions = await readFile(join((await loadProject(p.root)).root, ".leftoff", "decisions.md"), "utf8");
  match(decisions, /Istruzione a Claude: Aggiungere la validazione delle date/);
  ok(decisions.includes("Assunzione: formato GG/MM/AAAA"));
});

test("'ok ma aggiungi i test' is a request for changes: the PM revises, the new draft replaces the old", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider, seen } = scripted(proposing(DRAFT), proposing(REVISED));
  const { hub } = makeHub(provider, paseo);
  const c = chat(hub);
  await hub.handle(c.text("dì a Claude di controllare le date"));
  await hub.handle(c.text("ok ma aggiungi i test per le date nel passato"));

  strictEqual(paseo.sent.length, 0, "a qualified yes is not a yes");
  match(seen[1]!.prompt, /A draft for Claude \(clipforge\) is waiting/);
  ok(c.last().includes("Includi anche i test per le date nel passato"));
  await hub.handle(c.text("va bene"));
  deepStrictEqual(paseo.sent, [REVISED], "only the revised text is ever sent");
});

test("'no' drops the draft, and a later 'sì' means nothing", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider, seen } = scripted(proposing(DRAFT), async () => "Ok, di cosa parliamo?");
  const { hub } = makeHub(provider, paseo);
  const c = chat(hub);
  await hub.handle(c.text("dì a Claude di controllare le date"));
  await hub.handle(c.text("no"));
  match(c.last(), /Annullata, non ho mandato niente/);
  await hub.handle(c.text("sì"));
  strictEqual(paseo.sent.length, 0);
  strictEqual(seen.length, 2, "a stray 'sì' with no draft is just a message for the PM");
});

test("a draft nobody answered expires, so a late 'ok' cannot send it", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider } = scripted(proposing(DRAFT), async () => "Dimmi pure.");
  const { hub } = makeHub(provider, paseo);
  const c = chat(hub);
  await hub.handle(c.text("dì a Claude di controllare le date"));
  hub.state.proposals["t1"]!.expiresAt = new Date(Date.now() - 1000).toISOString();
  await hub.handle(c.text("ok"));
  strictEqual(paseo.sent.length, 0);
});

test("drafts are per thread: a 'sì' in another topic cannot approve this one", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider } = scripted(proposing(DRAFT), async () => "Dimmi pure.");
  const { hub } = makeHub(provider, paseo);
  await hub.handle(chat(hub, "topic-a").text("dì a Claude di controllare le date"));
  await hub.handle(chat(hub, "topic-b").text("sì"));
  strictEqual(paseo.sent.length, 0);
  ok(hub.state.proposals["topic-a"], "still waiting in its own thread");
});

test("the model has no way to send: it only gets the draft tool", async () => {
  await clipforge();
  const { provider, seen } = scripted(async () => "Ok.");
  const { hub } = makeHub(provider, fakePaseo());
  await hub.handle(chat(hub).text("ciao"));
  const names = seen[0]!.tools.map((t) => t.name);
  ok(names.includes("propose_agent_command"));
  ok(!names.some((n) => /send|deliver|approve|confirm/.test(n)), names.join(", "));
});

test("an unknown agent is refused to the PM, not drafted", async () => {
  await clipforge();
  const { provider } = scripted(proposing(DRAFT, "codex"));
  const { hub } = makeHub(provider, fakePaseo());
  const c = chat(hub);
  await hub.handle(c.text("dì a Codex di controllare"));
  match(c.last(), /No agent "codex" in clipforge\. Known: claude/);
  strictEqual(hub.state.proposals["t1"], undefined);
  ok(!c.last().includes("📨"));
});

test("a closed or unreachable agent gets the message in its inbox, and the owner is told", async () => {
  const p = await clipforge();
  for (const paseo of [fakePaseo("closed"), fakePaseo("idle", { failSend: true })]) {
    const { provider } = scripted(proposing(DRAFT));
    const { hub } = makeHub(provider, paseo);
    const c = chat(hub, `t-${Math.random()}`);
    await hub.handle(c.text("dì a Claude di controllare"));
    await hub.handle(c.text("sì"));
    match(c.last(), /📥/);
    match(c.last(), /in coda/);
  }
  const queued = await pending(await loadProject(p.root), "claude");
  strictEqual(queued.length, 2, "the instruction is never lost");
  strictEqual(queued[0]!.text, DRAFT);
});

test("secrets in a draft are redacted before it is shown, so shown equals sent", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider } = scripted(proposing("Usa la chiave sk-ant-api03-ABCDEFGHIJKLMNOP per il test."));
  const { hub } = makeHub(provider, paseo);
  const c = chat(hub);
  await hub.handle(c.text("dì a Claude"));
  ok(!c.last().includes("ABCDEFGHIJKLMNOP"));
  await hub.handle(c.text("sì"));
  ok(!paseo.sent[0]!.includes("ABCDEFGHIJKLMNOP"));
});

test("a daily ceiling stops a loop", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider } = scripted(proposing("Primo."), proposing("Secondo."));
  const { hub } = makeHub(provider, paseo, { commands: { maxPerDay: 1 } });
  const c = chat(hub);
  await hub.handle(c.text("uno"));
  await hub.handle(c.text("sì"));
  await hub.handle(c.text("due"));
  await hub.handle(c.text("sì"));
  strictEqual(paseo.sent.length, 1);
  match(c.last(), /Non mando altro/);
});

test("by voice: 'sì' approves; a doubtful transcript does not", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider } = scripted(proposing(DRAFT));
  let confidence = 0.95;
  const transcriber: Transcriber = {
    id: "stt",
    async transcribe() {
      return { text: "Sì", confidence, durationSec: 1, costUsd: 0, model: "nova-3" };
    },
  };
  const { hub } = makeHub(provider, paseo, {}, { transcriber });
  const c = chat(hub);
  await hub.handle(c.text("dì a Claude di controllare le date"));
  const voice: IncomingMessage = { ...c.text(""), audio: { durationSec: 1, download: async () => ({ bytes: new Uint8Array([0]), mime: "audio/ogg" }) } };

  confidence = 0.3;
  await hub.handle(voice);
  strictEqual(paseo.sent.length, 0, "a mumbled 'sì' must not send anything");
  ok(hub.state.proposals["t1"], "and the draft is still waiting");

  confidence = 0.95;
  await hub.handle(voice);
  deepStrictEqual(paseo.sent, [DRAFT]);
});

test("the agent's next report comes back as the answer, whatever its status, once", async () => {
  const p = await clipforge();
  const paseo = fakePaseo("idle");
  const { provider } = scripted(proposing(DRAFT));
  const { hub, channel } = makeHub(provider, paseo);
  await hub.tick(new Date("2026-10-06T10:00:00+02:00"));
  const c = chat(hub);
  await hub.handle(c.text("dì a Claude di controllare le date"));
  await hub.handle(c.text("sì"));

  const sentAt = Date.parse(hub.state.awaiting["clipforge:claude"]!);
  await report(await loadProject(p.root), { done: ["Validazione date nel form"], doing: [], blocked: [], next: [], option: [], agent: "claude", status: "progress", at: new Date(sentAt + 1000).toISOString() });
  await hub.tick(new Date(sentAt + 2000));
  const answers = channel.sent.filter((m) => m.projectId === "clipforge");
  strictEqual(answers.length, 1, "even a plain progress report is pushed — it answers the instruction");
  match(answers[0]!.text, /↩️ Risposta di Claude alla tua istruzione/);
  match(answers[0]!.text, /Validazione date nel form/);

  await report(await loadProject(p.root), { done: ["Altro"], doing: [], blocked: [], next: [], option: [], agent: "claude", status: "progress", at: new Date(sentAt + 3000).toISOString() });
  await hub.tick(new Date(sentAt + 4000));
  strictEqual(channel.sent.filter((m) => m.projectId === "clipforge").length, 1, "later progress reports are quiet again");
});

test("/riparti wakes a reachable agent directly, without a model round-trip", async () => {
  await clipforge();
  const paseo = fakePaseo("idle");
  const { provider, seen } = scripted();
  const { hub } = makeHub(provider, paseo);
  const c = chat(hub);
  await hub.handle(c.text("/riparti clipforge claude"));
  strictEqual(paseo.sent.length, 1);
  match(paseo.sent[0]!, /Riprendi ora l’attività/);
  match(c.last(), /ho chiesto di ripartire ora/);
  strictEqual(seen.length, 0);
});
