import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import type { Channel, IncomingMessage } from "../src/channels/channel.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, saveProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { inQuietHours, standupDue } from "../src/hub/clock.ts";
import { Hub } from "../src/hub/hub.ts";
import { redact } from "../src/hub/redact.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { commit, tempProject, isolateHost } from "./helpers.ts";

const TZ = "Europe/Rome";
const config = ConfigSchema.parse({ timezone: TZ, language: "it", notify: { level: "all", quietHours: { enabled: true, start: "22:00", end: "08:00" }, unreportedAfterMinutes: 30, pollSeconds: 60 } });
const base = { done: [], doing: [], blocked: [], next: [], option: [] };

/** A wall-clock time in Rome on 2026-10-06 (a Tuesday). */
const rome = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00+02:00`);

beforeEach(async () => {
  await isolateHost("leftoff-hub-");
});

async function project(id: string, extra: Record<string, unknown> = {}): Promise<Project> {
  const p = await tempProject({ id, name: id[0]!.toUpperCase() + id.slice(1), ...extra });
  await registerProject(id, p.root);
  return p;
}

function hubWith(provider?: ModelProvider) {
  const channel = new ConsoleChannel();
  const hub = new Hub({ config, channel, ...(provider ? { provider } : {}), log: () => undefined });
  return { hub, channel };
}

test("clock: quiet hours wrap midnight, the stand-up fires once a day", () => {
  ok(inQuietHours(rome("23:30"), TZ, { start: "22:00", end: "08:00" }));
  ok(inQuietHours(rome("07:59"), TZ, { start: "22:00", end: "08:00" }));
  ok(!inQuietHours(rome("08:00"), TZ, { start: "22:00", end: "08:00" }));
  ok(!standupDue(rome("08:59"), TZ, "09:00", undefined));
  ok(standupDue(rome("09:01"), TZ, "09:00", undefined));
  ok(!standupDue(rome("15:00"), TZ, "09:00", "2026-10-06"));
});

test("history is baselined silently; then only reports that matter are pushed", async () => {
  const p = await project("clipforge");
  await report(p, { ...base, agent: "claude", status: "done", done: ["old work"] });
  const { hub, channel } = hubWith();
  await hub.tick(rome("10:00"));
  strictEqual(channel.sent.filter((m) => m.projectId === "clipforge").length, 0, "no replay of history");

  await report(await loadProject(p.root), { ...base, agent: "claude", status: "progress", done: ["step"] });
  await report(await loadProject(p.root), {
    ...base,
    agent: "claude",
    status: "needs_input",
    question: "Committo le specifiche su main?",
    option: ["Sì", "Prima rivedo"],
    recommend: "Sì",
  });
  await hub.tick(rome("10:01"));
  const sent = channel.sent.filter((m) => m.projectId === "clipforge");
  strictEqual(sent.length, 1, "progress is never pushed");
  match(sent[0]!.text, /❓ Claude ha bisogno di te/);
  match(sent[0]!.text, /1\. Sì/);
  match(sent[0]!.text, /Consiglia: Sì/);
});

test("quiet hours hold blockers until morning and drop the rest into the stand-up", async () => {
  const p = await project("harbor");
  const { hub, channel } = hubWith();
  await hub.tick(rome("21:00"));
  await report(p, { ...base, agent: "claude", status: "blocked", blocked: ["serve l'URL iCal"] });
  await report(await loadProject(p.root), { ...base, agent: "codex", status: "done", done: ["test del form"] });
  await hub.tick(rome("23:00"));
  strictEqual(channel.sent.filter((m) => m.projectId).length, 0, "nothing at night");

  await hub.tick(rome("08:05"));
  const morning = channel.sent.filter((m) => m.projectId === "harbor");
  strictEqual(morning.length, 1);
  match(morning[0]!.text, /⛔ Claude è bloccato: serve l'URL iCal/);
});

test("a muted project stays silent", async () => {
  const p = await project("storefront");
  const { hub, channel } = hubWith();
  await hub.tick(rome("10:00"));
  hub.state.mutes.storefront = rome("20:00").toISOString();
  await report(p, { ...base, agent: "claude", status: "blocked", blocked: ["Leaflet o Google Maps?"] });
  await hub.tick(rome("10:05"));
  strictEqual(channel.sent.filter((m) => m.projectId === "storefront").length, 0);
});

test("a transient channel failure retries an event instead of consuming it", async () => {
  const p = await project("retry");
  let fail = false;
  const sent: string[] = [];
  const channel: Channel = {
    name: "flaky",
    start: async () => undefined,
    stop: async () => undefined,
    send: async (_projectId, text) => {
      if (fail) {
        fail = false;
        throw new Error("temporary outage");
      }
      sent.push(text);
    },
  };
  const hub = new Hub({ config, channel, log: () => undefined });
  await hub.tick(rome("08:30"));
  await report(p, { ...base, agent: "claude", status: "done", done: ["important"] });
  fail = true;
  await hub.tick(rome("08:31"));
  strictEqual(sent.length, 0);
  await hub.tick(rome("08:32"));
  strictEqual(sent.filter((text) => /important/.test(text)).length, 1);
});

test("a muted answer closes the wait and a later report is not mislabelled", async () => {
  const p = await project("muted-reply");
  const { hub, channel } = hubWith();
  await hub.tick(rome("10:00"));
  hub.state.awaiting["muted-reply:claude"] = rome("10:01").toISOString();
  hub.state.mutes["muted-reply"] = rome("11:00").toISOString();
  await report(p, { ...base, agent: "claude", status: "progress", done: ["real answer"], at: rome("10:02").toISOString() });
  await hub.tick(rome("10:03"));
  strictEqual(hub.state.awaiting["muted-reply:claude"], undefined);
  delete hub.state.mutes["muted-reply"];
  await report(p, { ...base, agent: "claude", status: "progress", done: ["unrelated"], at: rome("10:04").toISOString() });
  await hub.tick(rome("10:05"));
  strictEqual(channel.sent.filter((m) => m.projectId === "muted-reply").length, 0);
});

test("quiet hours are off by default and /quiet toggles them persistently", async () => {
  await project("quiet-toggle");
  const channel = new ConsoleChannel();
  const hub = new Hub({ config: ConfigSchema.parse({ timezone: TZ, language: "it", notify: { level: "all" } }), channel, log: () => undefined });
  const replies: string[] = [];
  const message = (text: string): IncomingMessage => ({ text, projectId: null, threadKey: "quiet", reply: async (value) => void replies.push(value), typing: async () => undefined });
  strictEqual(hub.state.quietHoursEnabled, undefined);
  await hub.handle(message("/quiet"));
  match(replies.at(-1)!, /disattivate/);
  await hub.handle(message("/quiet on"));
  strictEqual(hub.state.quietHoursEnabled, true);
  await hub.handle(message("/quiet off"));
  strictEqual(hub.state.quietHoursEnabled, false);
});

test("the stand-up goes out once, in General, after 09:00 and not before", async () => {
  const p = await project("clipforge");
  await report(p, { ...base, agent: "claude", status: "needs_input", question: "Committo su main?", option: [] });
  const { hub, channel } = hubWith();
  await hub.tick(rome("08:30"));
  strictEqual(channel.sent.filter((m) => m.projectId === null).length, 0);
  await hub.tick(rome("09:00"));
  await hub.tick(rome("09:30"));
  const standups = channel.sent.filter((m) => m.projectId === null);
  strictEqual(standups.length, 1);
  match(standups[0]!.text, /Stand-up di martedì/);
  match(standups[0]!.text, /Clipforge: .*❓ Claude: Committo su main\?/);
});

test("commits that sit unreported are flagged once", async () => {
  const p = await project("ledger");
  // This test steps the clock forward from the real "now"; with default quiet hours it
  // would pass or fail depending on the hour it runs, so switch quiet hours off here.
  const channel = new ConsoleChannel();
  const hub = new Hub({
    config: ConfigSchema.parse({ timezone: TZ, language: "it", notify: { level: "all", quietHours: { start: "00:00", end: "00:00" } } }),
    channel,
    log: () => undefined,
  });
  await hub.tick(new Date());
  await commit(p.root, "x.ts", "export {};\n", "feat: something nobody reported");
  await hub.tick(new Date(Date.now() + 10 * 60_000));
  strictEqual(channel.sent.filter((m) => m.projectId === "ledger").length, 0, "not before 30 minutes");
  await hub.tick(new Date(Date.now() + 40 * 60_000));
  await hub.tick(new Date(Date.now() + 80 * 60_000));
  // A step, not news (D-052): the register has it once, chat never — not even at «all».
  strictEqual(channel.sent.filter((m) => m.projectId === "ledger").length, 0);
  const flagged = channel.logged.filter((m) => m.projectId === "ledger" && m.meta.type === "commits");
  strictEqual(flagged.length, 1);
  match(flagged[0]!.text, /⚠️ 1 commit .*senza report/);
  match(flagged[0]!.text, /something nobody reported/);
});

test("private projects never reach the chat", async () => {
  const p = await project("secret", { visibility: "private" });
  const { hub, channel } = hubWith();
  await hub.tick(rome("10:00"));
  await report(p, { ...base, agent: "claude", status: "blocked", blocked: ["x"] });
  await hub.tick(rome("10:01"));
  await hub.tick(rome("09:10"));
  ok(!channel.sent.some((m) => m.text.includes("Secret") || m.projectId === "secret"));
});

test("questions go to the PM with the thread's project and memory; /mute works", async () => {
  await project("clipforge");
  const seen: RunRequest[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      seen.push(request);
      if (request.prompt.includes("silenzia")) {
        const out = await request.execute("mute_project", { project: "clipforge", hours: 12 });
        return { text: `Fatto: ${out.content}`, model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
      }
      return { text: "Risposta, con sk-ant-api03-abcdefghijklmnop dentro", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const { hub } = hubWith(provider);
  const replies: string[] = [];
  const msg = (text: string): IncomingMessage => ({
    text,
    projectId: "clipforge",
    threadKey: "test-clipforge",
    reply: async (r) => void replies.push(r),
    typing: async () => undefined,
  });

  await hub.handle(msg("a che punto siamo?"));
  await hub.handle(msg("e il tedesco?"));
  match(seen[0]!.prompt, /project "Clipforge"/);
  strictEqual(seen[1]!.history.length, 2, "the second question carries the first exchange");
  ok(!replies[0]!.includes("abcdefghijklmnop"), "secrets are redacted on the way out");

  await hub.handle(msg("silenzia clipforge per oggi"));
  ok(hub.state.mutes.clipforge, "the PM can mute through its action tool");
  await hub.handle(msg("/unmute clipforge"));
  strictEqual(hub.state.mutes.clipforge, undefined);
});

test("redaction catches the usual suspects", () => {
  const out = redact("key sk-ant-api03-XYZXYZXYZXYZ, token=abc123, ghp_aaaaaaaaaaaaaaaaaaaaaaaa");
  ok(!out.includes("XYZXYZ"));
  ok(!out.includes("abc123"));
  ok(!out.includes("aaaaaaaa"));
  // The .env forms: a prefix joined by underscores.
  const env = redact("SMTP_PASSWORD=hunter2hunter2\nDB_SECRET = s3cr3t\nSTRIPE_API_KEY=k_live_x");
  ok(!/hunter2|s3cr3t|k_live_x/.test(env), env);
  match(env, /SMTP_PASSWORD=\[redacted\]/, "the name stays, so the reader knows what was there");
  ok(!/=abc|=s3/.test(redact("SECRET_KEY=abc\nAWS_SECRET_ACCESS_KEY=s3\nDB_PASS=abc")), "short values right after «=» go too");
  strictEqual(redact("id_token: string;\nuse_secret: true"), "id_token: string;\nuse_secret: true", "code is not a .env file");
});

test("camelCase names, a key in prose and a storage token's own form are caught; code and prose are not (keys in pasted logs)", async () => {
  const token = "4_0021a2b3c4d5e6f0000000001_01a2b3c4_d5e6f7_acct_AbCdEfGhIjKl=";
  for (const text of [
    `{"accountId": "0a1b2c3d4e5f", "authorizationToken": "${token}"}`,
    "accountAuthToken=Xy7kP9mQ2zWq",
    `accountAuthToken: ${token}`,
    `[storage] uploading with ${token}`,
    "[storage] using auth token 9f8e7d6c5b4a39281706_abcdef for the upload",
    'clientSecret: "s3cr3t-value-9"',
  ]) ok(!/Xy7kP9|AbCdEfGh|9f8e7d6c|s3cr3t-value/.test(redact(text)), text);
  for (const text of [
    "const accessToken: string;",
    "nextPageToken: abc",
    "the token we use is the old one",
    "tokenizer: words",
    "idToken: z.string().min(1)",
    "tokenCount: 1234567890",
    "the secret projects/demo-project/secrets/db-pass",
    "api key /etc/demo/api-key-file.json",
    "the token kebab-case-identifier-name",
    "Refresh the token\n  src/hub/session.ts:42",
  ]) strictEqual(redact(text), text, text);
  // A second review's cases: keys by their own form, the cloud SDK and npm shapes.
  for (const text of [
    '"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiEXAMPLE0"',
    "//registry.example.invalid/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "key AIzaSyA1234567890abcdefghijklmnopqrstuv in the page",
    "sk_live_0123456789abcdefghij",
    "glpat-0123456789abcdefghij",
    "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789+/==",
  ]) ok(!/wJalrXUtn|npm_abc|AIzaSyA|sk_live_0|glpat-0|XXXXXXXX|eyJzdWIi|abcdefghijklmnopqrstuvwxyz0123456789\+/.test(redact(text)), text);
  const started = Date.now();
  redact("a.".repeat(150_000));
  ok(Date.now() - started < 2000, "«a.a.a.…» stays linear");
  const { looksLikeKey } = await import("../src/hub/files.ts");
  ok(looksLikeKey(new TextEncoder().encode(`apt log line\n${"Get:1 http://deb.example.invalid stable InRelease\n".repeat(50)}{"authorizationToken": "${token}"}\n`)), "a pasted log with a token asks before it goes");
});

test("redaction hides a value, never a name, an «=», a quote or a reference: commands keep working", () => {
  const same = [
    "grep '^PAYMENTS_TOKEN=' /etc/harbor/staging.env",
    "grep '^PAYMENTS_TOKEN=' /etc/harbor/staging.env && echo 'found it'",
    "```\ngrep -c '^PAYMENTS_TOKEN=' /etc/harbor/staging.env\n```",
    "PAYMENTS_TOKEN=",
    "PAYMENTS_TOKEN= empty",
    "PAYMENTS_TOKEN=''",
    "password=$DB_PASS",
    "API_KEY=<your key>",
    "SMTP_PASSWORD={{ secrets.smtp }}",
    "the token: we decided to rotate it",
    "PAYMENTS_TOKEN= empty",
    "use_secret: true",
    "export X_TOKEN=$(cat /run/secret)",
    'export X_TOKEN="$(cat /run/secret)"',
    'API_KEY="${API_KEY}"',
    "TOKEN=${{ secrets.TOKEN }}",
    "docker run -e API_KEY img",
    "grep '^export PAYMENTS_TOKEN=' /etc/harbor/staging.env",
    "grep -c '^export PAYMENTS_TOKEN=' /etc/harbor/staging.env && echo 'ok'",
    "grep -E '^ *PAYMENTS_TOKEN=' /etc/harbor/staging.env",
    "export X_TOKEN=$(cat /run/secret); echo done",
  ];
  for (const text of same) strictEqual(redact(text), text, text);
  const hidden: Array<[string, string]> = [
    ["PAYMENTS_TOKEN=pk_live_4f9a2c", "PAYMENTS_TOKEN=[redacted]"],
    ["PAYMENTS_TOKEN='pk_live_4f9a2c'", "PAYMENTS_TOKEN='[redacted]'"],
    ['export SMTP_PASSWORD="hunter2hunter2"', 'export SMTP_PASSWORD="[redacted]"'],
    ["SMTP_PASSWORD='a pass phrase with spaces'", "SMTP_PASSWORD='[redacted]'"],
    ["password: correcthorsebatterystaple", "password: [redacted]"],
    ["token=abc123", "token=[redacted]"],
    // What a separate review found leaking: any value right after «=», quotes inside it, JSON, URLs, headers, flags.
    ["DB_PASS=correcthorse", "DB_PASS=[redacted]"],
    ["password=p@ss", "password=[redacted]"],
    ["password = 'short'", "password = '[redacted]'"],
    ['password: "abc"', 'password: "[redacted]"'],
    ["DB_PASSWORD=Xy7'kP9#mQ2z", "DB_PASSWORD=[redacted]"],
    ['PASSWORD="it\'s-a-secret-123"', 'PASSWORD="[redacted]"'],
    ["PASSWORD=$ecretP4ss", "PASSWORD=[redacted]"],
    ["PASSWORD=%Tr0ub4dor", "PASSWORD=[redacted]"],
    ['"password": "hunter2hunter2"', '"password": "[redacted]"'],
    ["postgres://app:s3cretPass@db.example/app", "postgres://app:[redacted]@db.example/app"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x", "Authorization: Bearer [redacted]"],
    ["--password hunter2", "--password [redacted]"],
    ["secret_key: Hunter2Hunter", "secret_key: [redacted]"],
    ["DB_SECRET = s3cr3t", "DB_SECRET = [redacted]"],
    // The second pass: an apostrophe in prose, a reference with more after it, YAML's next line, a docker argument.
    ["It's in the env file: DB_PASSWORD='hunter2hunter2'", "It's in the env file: DB_PASSWORD='[redacted]'"],
    ["Don't paste it: password: 'hunter2hunter2'", "Don't paste it: password: '[redacted]'"],
    ["TOKEN=${X}abc123def", "TOKEN=[redacted]"],
    ["PASSWORD=<Xy7>kP9#mQ2z", "PASSWORD=[redacted]"],
    ["db:\n  password:\n    s3cr3t99\n  host: x", "db:\n  password:\n    [redacted]\n  host: x"],
    ['docker run -e "API_KEY=s3cr3tval" img', 'docker run -e "API_KEY=[redacted]" img'],
    ["password:\r\n  hunter2abc", "password:\r\n  [redacted]"],
    ["PASSWORD=<Xy7>'kP9#mQ2z", "PASSWORD=[redacted]"],
  ];
  for (const [text, expected] of hidden) strictEqual(redact(text), expected, text);
  // Linear on a long line of unclosed openers.
  const started = Date.now();
  redact("TOKEN=< ".repeat(125_000));
  ok(Date.now() - started < 2000, "a megabyte of «TOKEN=<» in well under two seconds");
});
