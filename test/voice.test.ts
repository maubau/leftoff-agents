import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import type { IncomingMessage } from "../src/channels/channel.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { readSpend, spentThisMonth } from "../src/pm/ledger.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { DeepgramTranscriber } from "../src/voice/deepgram.ts";
import type { Transcriber, Transcript } from "../src/voice/transcriber.ts";
import { tempProject, isolateHost } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-voice-");
});

test("Deepgram: raw bytes, token header, model, language and one keyterm per name", async () => {
  let seen: { url: URL; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url: new URL(url), init };
    return new Response(
      JSON.stringify({
        metadata: { duration: 12 },
        results: { channels: [{ alternatives: [{ transcript: " a che punto siamo con Clipforge? ", confidence: 0.93 }] }] },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const dg = new DeepgramTranscriber({ apiKey: "KEY", model: "nova-3", language: "multi", pricePerMinuteUsd: 0.0052, fetch: fakeFetch });
  const result = await dg.transcribe({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/ogg" }, { keyterms: ["Clipforge", "Storefront Shop", "Clipforge", ""] });

  strictEqual(seen!.url.origin + seen!.url.pathname, "https://api.deepgram.com/v1/listen");
  strictEqual(seen!.url.searchParams.get("model"), "nova-3");
  strictEqual(seen!.url.searchParams.get("language"), "multi");
  deepStrictEqual(seen!.url.searchParams.getAll("keyterm"), ["Clipforge", "Storefront Shop"], "deduplicated, empties dropped");
  const headers = seen!.init.headers as Record<string, string>;
  strictEqual(headers.authorization, "Token KEY");
  strictEqual(headers["content-type"], "audio/ogg");
  strictEqual(result.text, "a che punto siamo con Clipforge?");
  strictEqual(result.confidence, 0.93);
  strictEqual(Number(result.costUsd.toFixed(6)), Number(((12 / 60) * 0.0052).toFixed(6)));
});

test("Deepgram: an API error never leaks the key", async () => {
  const fakeFetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
  const dg = new DeepgramTranscriber({ apiKey: "SECRETKEY", model: "nova-3", language: "it", pricePerMinuteUsd: 0, fetch: fakeFetch });
  await dg.transcribe({ bytes: new Uint8Array(), mime: "audio/ogg" }, { keyterms: [] }).then(
    () => ok(false, "should throw"),
    (error: Error) => {
      match(error.message, /400/);
      ok(!error.message.includes("SECRETKEY"));
    },
  );
});

function setup(transcript: Partial<Transcript> | Error, options: { noTranscriber?: boolean } = {}) {
  const calls: Array<{ keyterms: string[] }> = [];
  const transcriber: Transcriber = {
    id: "fake-stt",
    async transcribe(_audio, opts) {
      calls.push(opts);
      if (transcript instanceof Error) throw transcript;
      return { text: "a che punto siamo con Clipforge", confidence: 0.95, durationSec: 6, costUsd: 0.0005, model: "nova-3", ...transcript };
    },
  };
  const asked: RunRequest[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      asked.push(request);
      return { text: "Clipforge: tutto fermo.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01, steps: 1, toolCalls: [] };
    },
  };
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "it", voice: { maxSeconds: 60, minConfidence: 0.6 } }),
    channel: new ConsoleChannel(),
    provider,
    ...(options.noTranscriber ? {} : { transcriber }),
    log: () => undefined,
  });
  const replies: string[] = [];
  let downloaded = 0;
  const note = (durationSec: number): IncomingMessage => ({
    text: "",
    projectId: null,
    threadKey: "voice-test",
    reply: async (r) => void replies.push(r),
    typing: async () => undefined,
    audio: {
      durationSec,
      download: async () => {
        downloaded++;
        return { bytes: new Uint8Array([0]), mime: "audio/ogg" };
      },
    },
  });
  return { hub, note, replies, asked, calls, downloads: () => downloaded };
}

test("a clear voice note: shown back, then answered, with the PM warned it was dictated", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  await registerProject("clipforge", p.root);
  const t = setup({});
  await t.hub.handle(t.note(6));
  match(t.replies[0]!, /🎙️ «a che punto siamo con Clipforge»/);
  strictEqual(t.replies[1], "Clipforge: tutto fermo.");
  match(t.asked[0]!.prompt, /dictated and transcribed/);
  ok(t.calls[0]!.keyterms.includes("Clipforge"), "project names are passed as keyterms");
});

test("a doubtful transcript is shown but not answered", async () => {
  const t = setup({ confidence: 0.3, text: "a che punto siamo con trauma" });
  await t.hub.handle(t.note(6));
  strictEqual(t.asked.length, 0, "the PM must not answer a possible mishearing");
  match(t.replies[0]!, /Non sono sicuro di aver capito: «a che punto siamo con trauma»/);
});

test("too long is refused before anything is downloaded; no transcriber is said plainly", async () => {
  const long = setup({});
  await long.hub.handle(long.note(500));
  strictEqual(long.downloads(), 0);
  match(long.replies[0]!, /troppo lungo/);

  const none = setup({}, { noTranscriber: true });
  await none.hub.handle(none.note(5));
  match(none.replies[0]!, /solo il testo/);
  strictEqual(none.asked.length, 0);
});

test("a transcription failure is reported, not swallowed", async () => {
  const t = setup(new Error("Deepgram answered 402"));
  await t.hub.handle(t.note(5));
  match(t.replies[0]!, /Non sono riuscito a trascrivere/);
  strictEqual(t.asked.length, 0);
});

test("voice cost is recorded but does not count against the PM's cap", async () => {
  const t = setup({ costUsd: 0.5 });
  await t.hub.handle(t.note(6));
  ok((await readSpend()).some((e) => e.purpose === "voice" && e.costUsd === 0.5));
  ok((await spentThisMonth()) < 0.5, "the cap is about the model, not about speech to text");
});

// ---------- spoken replies ----------
import { DeepgramSynthesizer } from "../src/voice/deepgram-speak.ts";
import { spokenText } from "../src/voice/spoken.ts";
import type { Synthesizer } from "../src/voice/synthesizer.ts";

test("spoken text drops what sounds absurd aloud and keeps the gist", () => {
  const out = spokenText(
    "⛔ Claude è bloccato: serve l'URL iCal.\n• la modifica a1b2c3d è dentro\n• vedi https://example.com/x/y\n**Prossimo**: i test",
    { maxChars: 900, language: "it" },
  );
  ok(!/[⛔•*]/u.test(out), out);
  ok(!out.includes("a1b2c3d") && !out.includes("https://"), out);
  match(out, /Claude è bloccato/);
  match(out, /un commit/);
  match(out, /un link/);
});

test("snake_case reads as words, and 'commit <hash>' loses the hash without a stutter", () => {
  const out = spokenText("stato: needs_input. Ultimo commit: b7ca285.", { maxChars: 900, language: "it" });
  match(out, /needs input/);
  ok(!/commit\.?\s*un commit|un commit\.$/.test(out), out);
  match(out, /Ultimo commit\./);
});

test("voice summarizes pull requests and code instead of spelling technical literals", () => {
  const out = spokenText(
    "PR #184 aggiornata in `src/really_long_internal_adapter.ts`. ```ts\nconst internal_token = abc;\n``` Dettagli nel testo.",
    { maxChars: 600, language: "it" },
  );
  match(out, /pull request numero 184/);
  match(out, /un riferimento tecnico|un file/);
  match(out, /dettaglio di codice è disponibile nel testo/i);
  ok(!out.includes("internal_token"));
  ok(!out.includes("really_long_internal_adapter"));
});

test("a long answer is cut at a sentence and points to the text", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Frase numero ${i}.`).join(" ");
  const out = spokenText(long, { maxChars: 200, language: "it" });
  ok(out.length <= 200, String(out.length));
  match(out, /Il resto lo trovi nel testo\.$/);
  ok(!/Frase numero \d+$/.test(out.replace(" Il resto lo trovi nel testo.", "")), "cut on a sentence, not mid-phrase");
});

test("Deepgram speak: Ogg/Opus request, JSON text, cost by characters", async () => {
  let seen: { url: URL; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url: new URL(url), init };
    return new Response(new Uint8Array([79, 103, 103, 83]), { status: 200 });
  }) as typeof fetch;
  const tts = new DeepgramSynthesizer({ apiKey: "KEY", model: "aura-2-livia-it", bitRate: 32000, pricePer1kCharsUsd: 0.03, fetch: fakeFetch });
  const audio = await tts.synthesize("Ciao, tutto fermo.");
  strictEqual(seen!.url.pathname, "/v1/speak");
  strictEqual(seen!.url.searchParams.get("model"), "aura-2-livia-it");
  strictEqual(seen!.url.searchParams.get("encoding"), "opus");
  strictEqual(seen!.url.searchParams.get("container"), "ogg");
  strictEqual(seen!.url.searchParams.get("bit_rate"), "32000");
  deepStrictEqual(JSON.parse(String(seen!.init.body)), { text: "Ciao, tutto fermo." });
  strictEqual((seen!.init.headers as Record<string, string>).authorization, "Token KEY");
  strictEqual(audio.mime, "audio/ogg");
  strictEqual(Number(audio.costUsd.toFixed(6)), Number(((18 / 1000) * 0.03).toFixed(6)));
});

function speaking(mode?: "mirror" | "always" | "never", opts: { fail?: boolean } = {}) {
  const spoken: string[] = [];
  const synthesizer: Synthesizer = {
    id: "fake-tts",
    async synthesize(text) {
      spoken.push(text);
      if (opts.fail) throw new Error("tts down");
      return { bytes: new Uint8Array([1, 2]), mime: "audio/ogg", characters: text.length, costUsd: 0.002, model: "aura-2-livia-it" };
    },
  };
  const transcriber: Transcriber = {
    id: "fake-stt",
    async transcribe() {
      return { text: "a che punto siamo", confidence: 0.95, durationSec: 4, costUsd: 0.0003, model: "nova-3" };
    },
  };
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(): Promise<RunResult> {
      return { text: "✅ Claude ha finito: il form. Prossimo: i test.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01, steps: 1, toolCalls: [] };
    },
  };
  const hub = new Hub({
    config: ConfigSchema.parse({ language: "it", ...(mode ? { voice: { speak: { mode } } } : {}) }),
    channel: new ConsoleChannel(),
    provider,
    transcriber,
    synthesizer,
    log: () => undefined,
  });
  const out: string[] = [];
  const voices: number[] = [];
  const base = {
    projectId: null,
    threadKey: `speak-${mode}-${Math.random()}`,
    reply: async (r: string) => void out.push(r),
    replyVoice: async (a: { bytes: Uint8Array }) => void voices.push(a.bytes.length),
    typing: async () => undefined,
  };
  const text = (t: string): IncomingMessage => ({ ...base, text: t });
  const voice = (): IncomingMessage => ({
    ...base,
    text: "",
    audio: { durationSec: 4, download: async () => ({ bytes: new Uint8Array([0]), mime: "audio/ogg" }) },
  });
  return { hub, text, voice, out, voices, spoken };
}

test("mirror (the default): a voice note gets text and a voice back; typed text gets text only", async () => {
  const t = speaking();
  await t.hub.handle(t.text("a che punto siamo?"));
  strictEqual(t.voices.length, 0);
  await t.hub.handle(t.voice());
  strictEqual(t.voices.length, 1);
  ok(t.out.some((r) => r.includes("Claude ha finito")), "the full text always goes out too");
  ok(!/[✅]/u.test(t.spoken[0]!), "emoji are not read aloud");
});

test("/voce on makes every reply speak, /voce off silences it, /voce auto restores mirroring", async () => {
  const t = speaking();
  await t.hub.handle(t.text("/voce on"));
  match(t.out.at(-1)!, /sempre/);
  await t.hub.handle(t.text("a che punto siamo?"));
  strictEqual(t.voices.length, 1, "typed question, spoken answer");

  await t.hub.handle(t.text("/voce off"));
  await t.hub.handle(t.voice());
  strictEqual(t.voices.length, 1, "off means off, even for a voice note");

  await t.hub.handle(t.text("/voce auto"));
  match(t.out.at(-1)!, /automatico/);
});

test("when speech synthesis fails the text answer has already arrived", async () => {
  const t = speaking("always", { fail: true });
  await t.hub.handle(t.text("a che punto siamo?"));
  ok(t.out.some((r) => r.includes("Claude ha finito")));
  strictEqual(t.voices.length, 0);
});

test("the voice stand-up goes out only in always mode", async () => {
  const project = await tempProject({ id: "clipforge", name: "Clipforge" });
  await registerProject("clipforge", project.root);
  for (const [mode, expected] of [["mirror", 0], ["always", 1]] as const) {
    await isolateHost("leftoff-voice-");
    await registerProject("clipforge", project.root);
    const channel = new ConsoleChannel();
    const synthesizer: Synthesizer = {
      id: "fake",
      async synthesize(text) {
        return { bytes: new Uint8Array([1]), mime: "audio/ogg", characters: text.length, costUsd: 0, model: "m" };
      },
    };
    const hub = new Hub({ config: ConfigSchema.parse({ timezone: "Europe/Rome", voice: { speak: { mode } } }), channel, synthesizer, log: () => undefined });
    await hub.tick(new Date("2026-10-06T07:00:00+02:00"));
    await hub.tick(new Date("2026-10-06T09:05:00+02:00"));
    strictEqual(channel.voices.length, expected, mode);
  }
});

test("the spoken voice follows the interface language, and Portuguese gets none", async () => {
  const { createSpeech, defaultVoice } = await import("../src/voice/factory.ts");
  strictEqual(defaultVoice("en"), "aura-2-thalia-en");
  strictEqual(defaultVoice("it"), "aura-2-livia-it");
  strictEqual(defaultVoice("pt"), undefined);
  process.env.DEEPGRAM_API_KEY = "k";
  const voice = ConfigSchema.parse({}).voice;
  ok(createSpeech(voice, "en").synthesizer, "English has a voice");
  strictEqual(createSpeech(voice, "pt").synthesizer, undefined, "no Portuguese voice: text only");
  ok(createSpeech({ ...voice, speak: { ...voice.speak, model: "aura-2-apollo-en" } }, "pt").synthesizer, "an explicit voice always wins");
  delete process.env.DEEPGRAM_API_KEY;
});
