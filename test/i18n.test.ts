import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import type { IncomingMessage } from "../src/channels/channel.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { isApproval, isCancellation } from "../src/hub/approval.ts";
import { Hub } from "../src/hub/hub.ts";
import { reportMessage } from "../src/hub/messages.ts";
import { canonicalCommand } from "../src/i18n/commands.ts";
import { LANGUAGES, messages, parseLanguage, type Lang } from "../src/i18n/index.ts";
import { spokenText } from "../src/voice/spoken.ts";
import { CODES, STR, strings } from "../src/web/public/i18n.js";
import { isolateHost, tempProject } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-i18n-");
});

/** Calls every entry of a catalog with plausible arguments, collecting the text it produces. */
function render(node: unknown, path = "", out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof node === "string") out.push([path, node]);
  else if (typeof node === "function") {
    const fn = node as (...args: unknown[]) => unknown;
    const samples: unknown[][] = [["alfa", "beta", "gamma", "delta"].slice(0, fn.length), [3, "beta", "gamma"].slice(0, fn.length), [90, 5].slice(0, fn.length)];
    // Entries with a flag or a mode: exercise every branch the tests below care about.
    if (path.endsWith("alertsStatus")) for (const level of ["critical", "normal", "all"]) out.push([`${path}.${level}`, String(fn(level))]);
    else if (path.endsWith("voiceLabel")) for (const mode of ["mirror", "always", "never"]) out.push([`${path}.${mode}`, String(fn(mode))]);
    else if (path.endsWith("restartAsked")) { out.push([`${path}.queued`, String(fn("X", true))]); out.push([`${path}.direct`, String(fn("X", false))]); }
    else if (path.endsWith("modelDown")) { out.push([`${path}.waiting`, String(fn(true))]); out.push([`${path}.plain`, String(fn(false))]); }
    else if (path.endsWith("unmuted")) { out.push([`${path}.named`, String(fn("Clipforge"))]); out.push([`${path}.anon`, String(fn(null))]); }
    else if (path.endsWith("warn")) { out.push([`${path}.when`, String(fn("Codex", 83, "alle 21:30"))]); out.push([`${path}.nowhen`, String(fn("Codex", 83, null))]); }
    else if (path.endsWith("unreported.head")) { out.push([`${path}.branch`, String(fn(3, "main"))]); out.push([`${path}.one`, String(fn(1, null))]); }
    else if (path.endsWith("idle")) { out.push([`${path}.work`, String(fn("Claude", "il form"))]); out.push([`${path}.nowork`, String(fn("Claude", ""))]); }
    else if (path.endsWith("approveHint")) { out.push([`${path}.min`, String(fn(30))]); out.push([`${path}.hours`, String(fn(120))]); }
    else if (path.endsWith("quietDays") || path.endsWith("reportsLastDay") || path.endsWith("unreportedCommits")) { out.push([`${path}.1`, String(fn(1))]); out.push([`${path}.5`, String(fn(5))]); }
    else if (path.endsWith("handoff.instruction")) {
      const p = { from: "Harbor UX", fromId: "ux", ask: "expose GET /api/bookings", report: ".leftoff/reports/r.md", commits: ["a1b2c3d"] };
      out.push([`${path}.full`, String(fn({ ...p, role: "frontend", branch: "ux-work" }))]);
      out.push([`${path}.bare`, String(fn({ ...p, role: null, branch: null, commits: [] }))]);
    }
    else if (path.endsWith("newAgent.firstPrompt")) {
      out.push([`${path}.full`, String(fn({ name: "Harbor Docs", project: "Harbor", role: "documentation", task: "Write the setup guide." }))]);
      out.push([`${path}.bare`, String(fn({ name: "Harbor Docs", project: "Harbor", role: null, task: null }))]);
    }
    else if (path.endsWith("restartScheduled")) { out.push([`${path}.1`, String(fn(1))]); out.push([`${path}.2`, String(fn(2))]); }
    else {
      // Entries take names or numbers; try the plausible arguments until one fits.
      let text: string | undefined;
      for (const args of samples) {
        try {
          text = String(fn(...args));
          if (!/NaN|undefined/.test(text)) break;
        } catch {
          /* wrong kind of argument: try the next set */
        }
      }
      out.push([path, text ?? "undefined"]);
    }
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) render(value, path ? `${path}.${key}` : key, out);
  }
  return out;
}

test("every language has every entry, produces clean text, and is really translated", () => {
  const english = render(messages("en"));
  ok(english.length >= 110, `the catalog shrank: ${english.length} entries`);
  for (const lang of LANGUAGES) {
    const rendered = render(messages(lang));
    deepStrictEqual(rendered.map(([k]) => k).sort(), english.map(([k]) => k).sort(), `${lang}: same entries as English`);
    const byKey = new Map(english);
    for (const [key, text] of rendered) {
      ok(text.trim().length > 0, `${lang}.${key} is empty`);
      ok(!/undefined|NaN|\[object|null\b/.test(text), `${lang}.${key}: "${text}"`);
    }
    if (lang === "en") continue;
    // A catalog copied from English and forgotten would pass the compiler: make sure it was translated.
    const same = rendered.filter(([k, text]) => text === byKey.get(k) && !/\.(name|file|link|commit)$/.test(k) && !/^(report\.and)$/.test(k));
    ok(same.length <= 6, `${lang} still has English text: ${same.map(([k]) => k).join(", ")}`);
  }
});

test("the languages are named, found by name in any language, and the default is English", () => {
  deepStrictEqual([...LANGUAGES], ["it", "en", "de", "fr", "es", "pt"]);
  for (const [text, lang] of [["de", "de"], ["Deutsch", "de"], ["tedesco", "de"], ["Français", "fr"], ["french", "fr"], ["español", "es"], ["Spanish", "es"], ["português", "pt"], ["INGLESE", "en"], ["it", "it"]] as const) {
    strictEqual(parseLanguage(text), lang, text);
  }
  strictEqual(parseLanguage("klingon"), undefined);
  strictEqual(ConfigSchema.parse({}).language, "en");
  for (const lang of LANGUAGES) strictEqual(ConfigSchema.parse({ language: lang }).language, lang);
  strictEqual(ConfigSchema.safeParse({ language: "xx" }).success, false);
});

test("a report is told in the owner's language, with the list joined by that language's «and»", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  await registerProject("clipforge", p.root);
  await report(p, { agent: "claude", status: "done", done: ["Form", "Mappa"], doing: [], blocked: [], next: [], option: [] });
  const r = (await import("../src/core/report.ts")).latestReport;
  const latest = (await r(await loadProject(p.root), "claude"))!;
  const first = Object.fromEntries(LANGUAGES.map((lang) => [lang, reportMessage(latest, lang).split("\n")[0]]));
  deepStrictEqual(first, {
    it: "✅ Claude ha finito: Form e Mappa.",
    en: "✅ Claude finished: Form and Mappa.",
    de: "✅ Claude ist fertig: Form und Mappa.",
    fr: "✅ Claude a terminé : Form et Mappa.",
    es: "✅ Claude ha terminado: Form y Mappa.",
    pt: "✅ Claude terminou: Form e Mappa.",
  });
});

test("«yes» and «no» are understood in every language, and nothing else is", () => {
  for (const yes of ["sì", "ok", "yes", "ja", "Ja, bitte", "oui", "Vas-y", "d'accord", "sí", "vale", "adelante", "sim", "pode enviar", "Envia", "perfeito"]) ok(isApproval(yes), yes);
  for (const no of ["no", "annulla", "nein", "abbrechen", "non", "annule", "laisse tomber", "cancela", "déjalo", "não", "deixa", "cancel"]) ok(isCancellation(no), no);
  for (const other of ["ja aber ändere die Datei", "oui mais ajoute des tests", "sí pero cambia el título", "sim mas troque", "nein, mach X", "no, hazlo así"]) {
    ok(!isApproval(other) && !isCancellation(other), `${other} is a request for changes`);
  }
});

test("commands work in every language's own words", () => {
  const expect = { resume: ["riparti", "resume", "weiter", "reprendre", "reanudar", "retomar"], voice: ["voce", "voice", "stimme", "voix", "voz"], language: ["lingua", "language", "sprache", "langue", "idioma"], quiet: ["silenzio", "quiet", "ruhe", "silence", "silencio"], alerts: ["avvisi", "alerts", "meldungen", "alertes", "avisos"] } as const;
  for (const [command, names] of Object.entries(expect)) for (const name of names) strictEqual(canonicalCommand(name), command, name);
  strictEqual(canonicalCommand("boh"), undefined);
});

test("spoken text drops the same things in every language", () => {
  for (const lang of LANGUAGES) {
    const out = spokenText("Fatto ✅ in commit b7ca285 vedi https://x.dev/a e /src/web/server.ts, PR #12.", { maxChars: 300, language: lang });
    ok(!/b7ca285|https|server\.ts|✅/.test(out), `${lang}: ${out}`);
    ok(/12/.test(out), `${lang} keeps the PR number: ${out}`);
  }
});

function hub(language: Lang = "it") {
  const channel = new ConsoleChannel();
  const h = new Hub({ config: ConfigSchema.parse({ timezone: "Europe/Rome", language, limits: { enabled: false } }), channel, log: () => undefined });
  const replies: string[] = [];
  const say = (text: string): Promise<void> =>
    h.handle({ text, projectId: null, threadKey: "t", reply: async (r) => void replies.push(r), typing: async () => undefined } satisfies IncomingMessage);
  return { h, say, replies, channel };
}

test("/lingua changes the language of everything the PM says, from that moment, and it survives a restart", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  await registerProject("clipforge", p.root);
  const { h, say, replies } = hub("it");

  await say("/lingua");
  match(replies.at(-1)!, /Lingua: Italiano/);
  await say("/language Deutsch");
  match(replies.at(-1)!, /Sprache: Deutsch/);
  strictEqual(h.state.language, "de");
  await say("/overview");
  match(replies.at(-1)!, /Stand-up/);
  await say("/stimme");
  match(replies.at(-1)!, /nicht verfügbar/);
  await say("/mute clipforge 2");
  match(replies.at(-1)!, /🔕 Clipforge stummgeschaltet bis /);

  await say("/sprache klingon");
  match(replies.at(-1)!, /kenne ich nicht/);
  strictEqual(h.state.language, "de", "an unknown language changes nothing");

  await say("/langue fr");
  match(replies.at(-1)!, /Langue : Français/);
  await h.stop();

  const again = new Hub({ config: ConfigSchema.parse({ timezone: "Europe/Rome", language: "it", limits: { enabled: false } }), channel: new ConsoleChannel(), log: () => undefined });
  await again.start();
  strictEqual(again.state.language, "fr", "the owner's choice outlives the process");
  await again.stop();
});

test("the panel speaks the same six languages, each complete", () => {
  deepStrictEqual(CODES, ["it", "en", "de", "fr", "es", "pt"]);
  const shape = (value: unknown): unknown => (Array.isArray(value) ? value.map(shape) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value);
  for (const code of CODES) {
    deepStrictEqual(shape(STR[code as keyof typeof STR]), shape(STR.en), `${code}: same keys as English`);
    const dict = strings(code) as Record<string, unknown>;
    strictEqual(typeof dict.name, "string");
    for (const [key, value] of Object.entries(dict)) {
      const text = typeof value === "function" ? String((value as (...a: unknown[]) => unknown)("a", "b", "c")) : JSON.stringify(value);
      ok(!/undefined|NaN/.test(text), `${code}.${key}: ${text}`);
    }
    if (code !== "en") notStrictEqual((STR[code as keyof typeof STR] as { needsYou: string }).needsYou, STR.en.needsYou, `${code} is translated`);
  }
  strictEqual((strings("xx") as { needsYou: string }).needsYou, "Needs you", "an unknown language falls back to English");
});
