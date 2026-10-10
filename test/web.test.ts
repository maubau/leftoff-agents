import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get as httpGet, request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { report } from "../src/commands/report.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, saveProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { buildSnapshot } from "../src/core/snapshot.ts";
import { Hub } from "../src/hub/hub.ts";
import type { ModelProvider, RunResult } from "../src/pm/provider.ts";
import { buildBoard } from "../src/web/board.ts";
import { Data, parseDecisions } from "../src/web/data.ts";
import { Feed } from "../src/web/feed.ts";
import { WebServer } from "../src/web/server.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const config = ConfigSchema.parse({ timezone: "Europe/Rome", language: "it" });
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

let dir = "";
beforeEach(async () => {
  dir = await isolateHost("leftoff-web-");
});

async function project(id: string, extra: Record<string, unknown> = {}): Promise<Project> {
  const p = await tempProject({ id, name: id[0]!.toUpperCase() + id.slice(1), ...extra });
  await registerProject(id, p.root);
  return p;
}

test("the board is derived from what agents reported, and a finished item leaves the open columns", async () => {
  const p = await project("clipforge");
  await report(p, { ...base, agent: "claude", status: "progress", done: ["Form prenotazioni"], doing: ["Sync iCal"], next: ["Traduzioni", "Pagina arrivo"] });
  await report(await loadProject(p.root), { ...base, agent: "codex", status: "blocked", blocked: ["Serve l'URL iCal"], question: "Dove lo trovo?", option: ["Airbnb", "Chiedo al cliente"], recommend: "Airbnb" });
  // Claude's next report finishes "Traduzioni": it must not stay in To do.
  await report(await loadProject(p.root), { ...base, agent: "claude", status: "progress", done: ["Traduzioni"], doing: ["Sync iCal"], next: ["Traduzioni", "Pagina arrivo"] });

  const board = buildBoard(await buildSnapshot(await loadProject(p.root)));
  deepStrictEqual(board.todo.map((c) => c.title), ["Pagina arrivo"]);
  deepStrictEqual(board.doing.map((c) => c.title), ["Sync iCal"]);
  deepStrictEqual(board.blocked.map((c) => c.title), ["Serve l'URL iCal"]);
  match(board.blocked[0]!.detail!, /1\. Airbnb[\s\S]*→ Airbnb/);
  deepStrictEqual(board.done.map((c) => c.title).sort(), ["Form prenotazioni", "Traduzioni"]);
  strictEqual(board.done[0]!.agent, "claude");
});

test("Backlog.md tasks fill the board and win over an agent's own wording", async () => {
  const p = await project("backlogged");
  await mkdir(join(p.root, "backlog", "tasks"), { recursive: true });
  const task = (n: number, title: string, status: string) =>
    writeFile(join(p.root, "backlog", "tasks", `task-${n} - ${title}.md`), `---\nid: task-${n}\ntitle: ${title}\nstatus: ${status}\nassignee: [claude]\n---\n`, "utf8");
  await task(1, "Mappa percorsi", "To Do");
  await task(2, "Login", "In Progress");
  await task(3, "Setup", "Done");
  await report(p, { ...base, agent: "claude", status: "progress", next: ["mappa percorsi!"] });

  const board = buildBoard(await buildSnapshot(await loadProject(p.root)));
  deepStrictEqual(board.todo.map((c) => c.title), ["Mappa percorsi"], "one card, from the backlog");
  strictEqual(board.todo[0]!.source, "backlog");
  deepStrictEqual(board.doing.map((c) => c.title), ["Login"]);
  deepStrictEqual(board.done.map((c) => c.title), ["Setup"]);
});

test("decisions.md is parsed into entries, without the indented context", () => {
  const md = "# Decisions\n\n## 2026-10-02 07:03 — agent\n\nUna scelta\n  claude on main — file.md\n\n## 2026-10-02 08:00 — user\n\nUn'altra\n";
  deepStrictEqual(parseDecisions(md), [
    { at: "2026-10-02 07:03", by: "agent", text: "Una scelta" },
    { at: "2026-10-02 08:00", by: "user", text: "Un'altra" },
  ]);
});

test("the feed redacts, survives a restart and pages backwards", async () => {
  const file = join(dir, "feed.jsonl");
  const feed = new Feed(file);
  await feed.load();
  const first = await feed.append({ projectId: "a", role: "pm", source: "hub", kind: "push", text: "chiave sk-ant-api03-abcdefghijklmnop qui" });
  await feed.append({ projectId: null, role: "owner", source: "web", kind: "ask", text: "ciao" });
  await feed.flush();
  ok(!first.text.includes("abcdefghijklmnop"));
  ok(!(await readFile(file, "utf8")).includes("abcdefghijklmnop"), "never on disk either");

  const again = new Feed(file);
  await again.load();
  strictEqual(again.recent().length, 2);
  deepStrictEqual(again.recent({ keep: (e) => e.projectId === "a" }).map((e) => e.id), [first.id]);
  deepStrictEqual(again.recent({ before: again.recent()[1]!.id }).map((e) => e.id), [first.id]);
});

interface Rig {
  hub: Hub;
  web: WebServer;
  feed: Feed;
  mirror: MirrorChannel;
  inner: ConsoleChannel;
  url: string;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
}

const servers: WebServer[] = [];
const hubs: Hub[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});

async function rig(options: { provider?: ModelProvider; token?: string } = {}): Promise<Rig> {
  const inner = new ConsoleChannel();
  const feed = new Feed(join(dir, "feed.jsonl"));
  await feed.load();
  const mirror = new MirrorChannel(inner, feed);
  const hub = new Hub({ config, channel: mirror, ...(options.provider ? { provider: options.provider } : {}), log: () => undefined });
  await hub.start();
  hubs.push(hub);
  const web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0 }, data: new Data({ config, state: () => hub.state }), feed, mirror, token: options.token, log: () => undefined });
  await web.start();
  servers.push(web);
  const url = `http://127.0.0.1:${web.port}`;
  return {
    hub, web, feed, mirror, inner, url,
    get: (path, headers) => fetch(url + path, { headers }),
    post: (path, body, headers) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("overview lists projects with agents, counts and who needs the owner; private projects are absent", async () => {
  const p = await project("clipforge", { purpose: "Sito prenotazioni" });
  await project("segreto", { visibility: "private" });
  await report(p, { ...base, agent: "claude", status: "needs_input", question: "Leaflet o Google Maps?", option: ["Leaflet", "Google"], recommend: "Leaflet", doing: ["Mappa"] });
  const r = await rig();

  const overview = (await (await r.get("/api/overview")).json()) as any;
  deepStrictEqual(overview.projects.map((x: any) => x.id), ["clipforge"]);
  const clipforge = overview.projects[0];
  strictEqual(clipforge.headline, "needs_input");
  strictEqual(clipforge.agents[0].id, "claude");
  strictEqual(clipforge.counts.doing, 1);
  strictEqual(overview.asks[0].text, "Leaflet o Google Maps?");
  deepStrictEqual(overview.asks[0].options, ["Leaflet", "Google"]);

  strictEqual((await r.get("/api/projects/segreto")).status, 404);
  const detail = (await (await r.get("/api/projects/clipforge")).json()) as any;
  strictEqual(detail.project.name, "Clipforge");
  strictEqual(detail.reports.length, 1);
  strictEqual((await r.get("/")).status, 200);
  strictEqual((await r.get("/app.js")).headers.get("content-type")?.startsWith("text/javascript"), true);
});

test("what the hub says on its own reaches the feed, as it reaches the chat", async () => {
  const p = await project("clipforge");
  const r = await rig();
  await r.hub.tick(new Date("2026-10-06T10:00:00+02:00"));
  await report(p, { ...base, agent: "claude", status: "blocked", blocked: ["serve l'URL"] });
  await r.hub.tick(new Date("2026-10-06T10:05:00+02:00"));

  ok(r.inner.sent.some((m) => /bloccato/.test(m.text)), "sent to the chat");
  const feed = ((await (await r.get("/api/feed?project=clipforge")).json()) as any).entries;
  strictEqual(feed.length, 1);
  strictEqual(feed[0].kind, "push");
  strictEqual(feed[0].role, "pm");
  match(feed[0].text, /⛔ Claude è bloccato: serve l'URL/);
  const general = ((await (await r.get("/api/feed?project=general")).json()) as any).entries;
  ok(!general.some((e: any) => /bloccato/.test(e.text)), "a project's message is not in the general thread");
});

test("a question typed in the panel is answered by the same PM, in its own thread", async () => {
  await project("clipforge");
  const seen: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      seen.push(request.prompt);
      return { text: "Siamo a metà.", model: "fake", usage, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const r = await rig({ provider });
  const res = await r.post("/api/chat", { project: "clipforge", text: "a che punto siamo?" });
  strictEqual(res.status, 202);
  const clipforge = () => r.feed.recent({ keep: (e) => e.projectId === "clipforge" });
  await until(() => clipforge().some((e) => e.role === "pm"));

  const entries = clipforge();
  deepStrictEqual(entries.map((e) => [e.role, e.source, e.projectId]), [["owner", "web", "clipforge"], ["pm", "web", "clipforge"]]);
  strictEqual(entries[1]!.text, "Siamo a metà.");
  match(seen[0]!, /project "Clipforge"/);
  ok(!r.inner.sent.some((m) => m.text === "Siamo a metà."), "the panel's conversation does not leak into Telegram");
});

test("a draft made in the panel is shown with its approval, and only «sì» sends it", async () => {
  const p = await project("clipforge", { agents: [{ id: "claude", control: "inbox", host: "claude-code" }] });
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      if (request.prompt.includes("controlla")) {
        await request.execute("propose_agent_command", { project: "clipforge", agent: "claude", prompt: "Controlla le date nel form.", summary: "Controllo date" });
      }
      return { text: "Preparo la bozza.", model: "fake", usage, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const r = await rig({ provider });
  await r.post("/api/chat", { project: "clipforge", text: "dì a claude di controllare le date" });
  // The draft becomes approvable only after the reply that shows it has gone out.
  await until(() => r.hub.state.proposals["web-clipforge"] !== undefined);
  const feed = (await (await r.get("/api/feed?project=clipforge")).json()) as any;
  ok(feed.draft, "the panel is told a draft waits");
  strictEqual(feed.draft.agent, "Claude");
  match(feed.draft.prompt, /Controlla le date/);
  strictEqual((await loadProject(p.root)).config.agents.length, 1);

  // The PM is still "answering" until the hub finishes the turn; a second message waits for it.
  for (let i = 0; i < 100 && ((await (await r.get("/api/feed?project=clipforge")).json()) as any).busy.length; i++) await new Promise((x) => setTimeout(x, 10));
  await r.post("/api/chat", { project: "clipforge", text: "sì" });
  const clipforge = () => r.feed.recent({ keep: (e) => e.projectId === "clipforge" });
  await until(() => clipforge().filter((e) => e.role === "pm").length >= 2);
  const after = (await (await r.get("/api/feed?project=clipforge")).json()) as any;
  strictEqual(after.draft, null);
  match(clipforge().at(-1)!.text, /Claude|coda|inbox|inviat/i);
});

test("telegram traffic is mirrored: the owner's message and the PM's reply", async () => {
  await project("clipforge");
  const inner: ConsoleChannel & { fire?: (m: any) => Promise<void> } = new ConsoleChannel();
  const feed = new Feed(join(dir, "feed2.jsonl"));
  const mirror = new MirrorChannel(Object.assign(inner, { name: "telegram" as const }) as any, feed);
  let handler!: (m: any) => Promise<void>;
  inner.start = async (onMessage) => void (handler = onMessage);
  await mirror.start(async (message) => message.reply("Tutto bene."));
  const replies: string[] = [];
  await handler({ text: "come va?", projectId: "clipforge", threadKey: "telegram-1", reply: async (t: string) => void replies.push(t), typing: async () => undefined });
  deepStrictEqual(replies, ["Tutto bene."], "Telegram still gets its reply");
  deepStrictEqual(feed.recent().map((e) => [e.role, e.source, e.kind, e.text]), [["owner", "telegram", "ask", "come va?"], ["pm", "telegram", "reply", "Tutto bene."]]);
});

test("the panel only talks to its own page: foreign hosts, foreign origins and bad bodies are refused", async () => {
  await project("clipforge");
  const r = await rig();
  // fetch() will not let a script set Host, so speak raw HTTP like a rebinding page's browser would.
  const status = await new Promise<number>((resolve, reject) =>
    request(`${r.url}/api/overview`, { headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", reject).end());
  strictEqual(status, 403, "DNS rebinding");
  strictEqual((await r.post("/api/chat", { project: null, text: "x" }, { origin: "http://evil.example" })).status, 403);
  strictEqual((await fetch(`${r.url}/api/chat`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  strictEqual((await r.post("/api/chat", { project: "nope", text: "x" })).status, 404);
  strictEqual((await r.post("/api/chat", { project: null, text: "  " })).status, 400);
  strictEqual((await fetch(`${r.url}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
});

test("a password protects the panel, and a public address cannot run without one", async () => {
  await project("clipforge");
  const r = await rig({ token: "s3cret-token" });
  strictEqual((await r.get("/api/overview")).status, 401);
  strictEqual((await r.get("/api/overview", { authorization: "Bearer wrong" })).status, 401);
  strictEqual((await r.get("/api/overview", { authorization: "Bearer s3cret-token" })).status, 200);
  const login = await fetch(`${r.url}/?token=s3cret-token`, { redirect: "manual" });
  strictEqual(login.status, 302);
  const cookie = login.headers.get("set-cookie")!;
  match(cookie, /HttpOnly; SameSite=Strict/);
  strictEqual((await r.get("/api/overview", { cookie: cookie.split(";")[0]! })).status, 200);

  const open = new WebServer({ config: { enabled: true, host: "0.0.0.0", port: 0 }, data: new Data({ config, state: () => r.hub.state }), feed: r.feed, mirror: r.mirror, log: () => undefined });
  await rejects(open.start(), /no password/);
});

test("review 1: every response forbids framing and foreign scripts, and the page needs no inline code", async () => {
  await project("clipforge");
  const r = await rig();
  for (const path of ["/", "/app.js", "/i18n.js", "/office.js", "/building.js", "/home.js", "/pixeltext.js", "/art.js", "/style.css", "/api/overview"]) {
    const res = await r.get(path);
    const csp = res.headers.get("content-security-policy") ?? "";
    match(csp, /default-src 'none'/, path);
    match(csp, /script-src 'self'/, path);
    match(csp, /frame-ancestors 'none'/, path);
    strictEqual(res.headers.get("x-frame-options"), "DENY", path);
  }
  // A policy that forbids inline code is only livable if the page uses none.
  const html = await (await r.get("/")).text();
  ok(!/<style|\sstyle\s*=|\son\w+\s*=|<script(?![^>]*\ssrc=)/i.test(html), "index.html has inline code");
  for (const file of ["app.js", "i18n.js", "building.js", "home.js", "pixeltext.js", "art.js"]) {
    const source = await readFile(new URL(`../src/web/public/${file}`, import.meta.url), "utf8");
    ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(source), `${file} builds markup from strings`);
    ok(!/setAttribute\(\s*["']style["']/.test(source), `${file} sets a style attribute, which the policy blocks`);
  }
});

test("review 2: an Origin that is not a URL is cross-origin, not a server error", async () => {
  await project("clipforge");
  const r = await rig();
  for (const origin of ["null", "not a url", "://", "http://"]) {
    strictEqual((await r.post("/api/chat", { project: null, text: "x" }, { origin })).status, 403, origin);
  }
});

test("review 3: a malformed project id is a 400, not a 500", async () => {
  await project("clipforge");
  const r = await rig();
  strictEqual((await r.get("/api/projects/%E0%A4%A")).status, 400);
  strictEqual((await r.get("/api/projects/%")).status, 400);
  strictEqual((await r.get("/api/projects/clipforge")).status, 200);
});

test("review 4: a project that turns private while the panel is open stops appearing in the live feed", async () => {
  const p = await project("clipforge");
  const r = await rig();
  let received = "";
  const stream = await new Promise<import("node:http").IncomingMessage>((resolve) => {
    httpGet(`${r.url}/api/events`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (received += chunk));
      resolve(res);
    });
  });
  await until(() => received.includes("retry"));

  await r.feed.append({ projectId: "clipforge", role: "pm", source: "hub", kind: "push", text: "visible: still public" });
  await until(() => received.includes("still public"));

  const loaded = await loadProject(p.root);
  await saveProject(p.root, { ...loaded.config, visibility: "private" });
  await r.feed.append({ projectId: "clipforge", role: "pm", source: "hub", kind: "push", text: "secret: now private" });
  await r.feed.append({ projectId: null, role: "pm", source: "hub", kind: "push", text: "marker: general" });
  await until(() => received.includes("marker: general"));
  ok(!received.includes("now private"), "a private project's line was pushed to the browser");
  stream.destroy();
});

test("review 5: secrets an agent pasted never reach the browser, in any view", async () => {
  const p = await project("clipforge");
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuv";
  await report(p, { ...base, agent: "claude", status: "needs_input", done: [`Configurato con ${secret}`], doing: [`Prova ${secret}`], next: [`Ruota ${secret}`], question: `Uso ${secret}?`, option: [`Sì, ${secret}`], body: `Nota: password: hunter2hunter2 e ${secret}` });
  await recordDecision(await loadProject(p.root), { at: new Date().toISOString(), by: "agent", text: `Chiave ${secret} nel deploy`, why: "x" });
  const r = await rig();
  const now = Date.now();
  r.hub.state.proposals["web-clipforge"] = { id: "d1", projectId: "clipforge", agentId: "claude", prompt: `Usa ${secret} per il deploy`, summary: `Con ${secret}`, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString() };

  for (const path of ["/api/overview", "/api/projects/clipforge", "/api/feed?project=clipforge"]) {
    const text = await (await r.get(path)).text();
    ok(!text.includes("abcdefghijklmnopqrstuv") && !text.includes("hunter2hunter2"), `${path} leaks a secret`);
  }
  const detail = (await (await r.get("/api/projects/clipforge")).json()) as any;
  match(detail.draft.prompt, /sk-ant-…\[redacted\]/, "the draft is redacted, and still says what it is");
  strictEqual(detail.reports.length, 1, "redaction does not drop data");
});

test("what the PM keeps from the chat stays in the panel's log, marked as not sent, and the level is shown", async () => {
  const p = await project("clipforge");
  const r = await rig();
  await r.hub.tick(new Date("2026-10-06T10:00:00+02:00"));
  await report(p, { ...base, agent: "claude", status: "done", done: ["Pagina tour"] });
  await r.hub.tick(new Date("2026-10-06T10:05:00+02:00"));

  ok(!r.inner.sent.some((m) => /Pagina tour/.test(m.text)), "not sent to the chat at the default level");
  const feed = ((await (await r.get("/api/feed?project=clipforge")).json()) as any).entries;
  strictEqual(feed.length, 1);
  deepStrictEqual([feed[0].kind, feed[0].role, feed[0].source], ["log", "pm", "hub"]);
  match(feed[0].text, /Pagina tour/);
  strictEqual(((await (await r.get("/api/overview")).json()) as any).notifyLevel, "critical");
});

test("behind a forwarder the panel answers to its allowed names only, and only with the password", async () => {
  await project("clipforge");
  const base0 = await rig({ token: "s3cret" });
  const open = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0, allowedHosts: ["Host.Tail1234.ts.net"] }, data: new Data({ config, state: () => base0.hub.state }), feed: base0.feed, mirror: base0.mirror, token: "s3cret", log: () => undefined });
  await open.start();
  servers.push(open);
  const raw = (host: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; cookie: string }>((resolve, reject) =>
      request(`http://127.0.0.1:${open.port}/api/overview`, { headers: { host, ...headers } }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, cookie: String(res.headers["set-cookie"] ?? "") }); }).on("error", reject).end());

  strictEqual((await raw("host.tail1234.ts.net", { authorization: "Bearer s3cret" })).status, 200, "the named host, with the password");
  strictEqual((await raw("host.tail1234.ts.net")).status, 401, "…and not without it");
  strictEqual((await raw("evil.example", { authorization: "Bearer s3cret" })).status, 403, "a name nobody listed");

  const login = await new Promise<string>((resolve, reject) =>
    request(`http://127.0.0.1:${open.port}/?token=s3cret`, { headers: { host: "host.tail1234.ts.net", "x-forwarded-proto": "https" } }, (res) => { res.resume(); resolve(String(res.headers["set-cookie"] ?? "")); }).on("error", reject).end());
  match(login, /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/, "over HTTPS the cookie is Secure");

  const noPassword = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0, allowedHosts: ["host.tail1234.ts.net"] }, data: new Data({ config, state: () => base0.hub.state }), feed: base0.feed, mirror: base0.mirror, log: () => undefined });
  await rejects(noPassword.start(), /LEFTOFF_WEB_TOKEN/);
});

test("the PM writing to an agent reaches the panel as a contact, never for a private project", async () => {
  await project("clipforge");
  await project("segreto", { visibility: "private" });
  const r = await rig();
  let received = "";
  const stream = await new Promise<import("node:http").IncomingMessage>((resolve) => {
    httpGet(`${r.url}/api/events`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (received += chunk));
      resolve(res);
    });
  });
  await until(() => received.includes("retry"));

  await r.web.contact({ project: "segreto", agent: "claude", kind: "command" });
  await r.web.contact({ project: "clipforge", agent: "claude", kind: "status" });
  await until(() => received.includes("event: contact"));
  match(received, /event: contact\ndata: \{"project":"clipforge","agent":"claude","kind":"status"\}/);
  ok(!received.includes("segreto"), "a private project's contact was pushed to the browser");
  stream.destroy();
});
