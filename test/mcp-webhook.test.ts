import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { configRoot } from "../src/core/paths.ts";
import { registerProject } from "../src/core/registry.ts";
import type { LeftoffEvent } from "../src/hub/events.ts";
import { Hub } from "../src/hub/hub.ts";
import { WebhookSender, signWebhook, webhookBody, type FetchFn } from "../src/mcp/webhook.ts";
import { isolateHost, tempProject } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-webhook-");
});

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
const event: LeftoffEvent = { seq: 7, at: "2026-10-17T10:00:00.000Z", project: "harbor", kind: "needs_input", agent: "ux", text: "Week or month view first?", question: { options: ["Week", "Month"] } };

function receiver(answers: number[] = []) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const status = answers.shift() ?? 200;
    return { ok: status < 300, status };
  };
  return { fetch, calls };
}

const webhookConfig = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({ mcp: { webhook: { enabled: true, url: "http://assistant-server:8644/webhooks/leftoff", ...extra } } }).mcp.webhook;

test("the signature is Standard Webhooks': the specification's own test vector", () => {
  strictEqual(signWebhook(SECRET, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}'), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("one signed POST per event, flat for a receiver's template; a failure is retried with the same id, signed afresh", async () => {
  const r = receiver([503, 200]);
  let now = Date.parse("2026-10-17T10:00:00Z");
  const sender = new WebhookSender({ config: webhookConfig(), secret: SECRET, fetch: r.fetch, delays: [10], now: () => (now += 1000) });
  sender.send(event);
  await new Promise((resolve) => setTimeout(resolve, 60));
  strictEqual(r.calls.length, 2, "retried once, then delivered");
  const [first, second] = r.calls;
  strictEqual(first!.url, "http://assistant-server:8644/webhooks/leftoff");
  deepStrictEqual(JSON.parse(first!.body), { type: "leftoff.needs_input", cursor: "7", at: event.at, project: "harbor", kind: "needs_input", agent: "ux", text: "Week or month view first?", question: { options: ["Week", "Month"] } });
  strictEqual(first!.headers["webhook-id"], "leftoff_7");
  strictEqual(second!.headers["webhook-id"], "leftoff_7", "same id: a receiver drops a repeat");
  ok(second!.headers["webhook-timestamp"] !== first!.headers["webhook-timestamp"], "a fresh timestamp: receivers refuse stale ones");
  for (const c of r.calls) strictEqual(c.headers["webhook-signature"], signWebhook(SECRET, c.headers["webhook-id"]!, Number(c.headers["webhook-timestamp"]), c.body));
});

test("it gives up after its retries and says so; kinds not asked for, and a missing secret or url, send nothing", async () => {
  const lines: string[] = [];
  const r = receiver([500, 500, 500]);
  new WebhookSender({ config: webhookConfig(), secret: SECRET, fetch: r.fetch, delays: [5, 5], log: (l) => void lines.push(l) }).send(event);
  await new Promise((resolve) => setTimeout(resolve, 60));
  strictEqual(r.calls.length, 3);
  match(lines.join(), /event 7 not delivered after 3 tries \(HTTP 500\); it stays in get_events/);

  const quiet = receiver();
  new WebhookSender({ config: webhookConfig({ events: ["done"] }), secret: SECRET, fetch: quiet.fetch }).send(event);
  strictEqual(quiet.calls.length, 0, "only the kinds configured");
  match(new WebhookSender({ config: webhookConfig(), secret: undefined }).problem!, /no LEFTOFF_WEBHOOK_SECRET/);
  match(new WebhookSender({ config: webhookConfig({ url: "ftp://x" }), secret: SECRET }).problem!, /not an http\(s\) address/);
  strictEqual(new WebhookSender({ config: webhookConfig({ enabled: false }), secret: SECRET }).problem, "disabled");
  deepStrictEqual(Object.keys(webhookBody(event)), ["type", "cursor", "at", "project", "kind", "agent", "text", "question"]);
});

test("the hub pushes what it records: an agent's question reaches the receiver; a private project's never does", async () => {
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code" }] });
  await registerProject("harbor", harbor.root);
  const vault = await tempProject({ id: "vault", name: "Vault", visibility: "private", agents: [{ id: "ux", control: "inbox", host: "claude-code" }] });
  await registerProject("vault", vault.root);
  const r = receiver();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const webhook = new WebhookSender({ config: webhookConfig(), secret: SECRET, fetch: r.fetch });
  let now = Date.now();
  const hub = new Hub({ config, channel: new ConsoleChannel(), clock: () => now, log: () => undefined, webhook });
  await hub.tick(new Date(now));
  await report(harbor, { ...base, agent: "ux", status: "needs_input", question: "Week or month view first?", option: ["Week", "Month"] } as never);
  await report(vault, { ...base, agent: "ux", status: "needs_input", question: "Secret?", option: ["A"] } as never);
  await hub.tick(new Date((now += 60_000)));
  await new Promise((resolve) => setTimeout(resolve, 30));
  deepStrictEqual(r.calls.map((c) => JSON.parse(c.body).project), ["harbor"]);
  ok(!r.calls.some((c) => c.body.includes("Secret")));
});

test("leftoff mcp webhook-secret makes a Standard Webhooks secret once, privately, and --rotate replaces it", async () => {
  const run = async (...args: string[]) => (await promisify(execFile)(process.execPath, ["src/cli.ts", "mcp", "webhook-secret", ...args], { env: process.env })).stdout.trim();
  const first = await run();
  ok(/^whsec_[A-Za-z0-9+/]{43}=$/.test(first), "whsec_ and 32 bytes in base64");
  strictEqual(await run(), first);
  ok((await run("--rotate")) !== first);
  const secrets = join(configRoot(), "secrets.env");
  ok((await readFile(secrets, "utf8")).includes("LEFTOFF_WEBHOOK_SECRET=whsec_"));
  strictEqual((await stat(secrets)).mode & 0o777, 0o600);
});
