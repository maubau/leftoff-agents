import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MirrorChannel } from "../channels/mirror.ts";
import type { Config } from "../core/config.ts";
import type { Contact } from "../hub/hub.ts";
import type { Data } from "./data.ts";
import type { Feed, FeedEntry } from "./feed.ts";
import { SettingsError, type Settings } from "./settings.ts";

const COOKIE = "leftoff_web";
const MAX_BODY = 64 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/**
 * Nothing but this origin may run, load or frame the panel. The frame rule matters most: with no
 * password on loopback, a page that framed the panel could make the owner click «Sì, invia».
 */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/i18n.js": { file: "i18n.js", type: "text/javascript; charset=utf-8" },
  "/office.js": { file: "office.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

export interface WebOptions {
  config: Omit<Config["web"], "allowedHosts"> & { allowedHosts?: string[] };
  data: Data;
  feed: Feed;
  mirror: MirrorChannel;
  /** Model and effort of the PM and of the agents; without it those endpoints do not exist. */
  settings?: Settings;
  /** The shared secret, from LEFTOFF_WEB_TOKEN. Required unless the panel listens on loopback only. */
  token?: string | undefined;
  log?: (line: string) => void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The control panel's HTTP side. Read endpoints build the same snapshot the PM reads; the one
 * write endpoint hands the owner's words to the hub exactly as Telegram does, so the approval
 * rule for instructions to agents is the hub's, not something this file could weaken.
 */
export class WebServer {
  readonly #o: WebOptions;
  readonly #log: (line: string) => void;
  #server: Server | undefined;
  readonly #clients = new Set<ServerResponse>();
  readonly #busy = new Set<string>();
  #heartbeat: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: WebOptions) {
    this.#o = options;
    this.#log = options.log ?? ((line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  }

  get port(): number {
    return (this.#server?.address() as AddressInfo | null)?.port ?? 0;
  }

  async start(): Promise<void> {
    const { host, port } = this.#o.config;
    if (!LOOPBACK.has(host) && !this.#o.token) {
      throw new Error(`the control panel would listen on ${host} with no password: set LEFTOFF_WEB_TOKEN in secrets.env, or use host 127.0.0.1`);
    }
    // A forwarder (tailscale serve, a reverse proxy) reaches a loopback panel as "localhost" whoever is
    // behind it, so a name the panel is reachable by from outside is a name that needs the password.
    if (this.#allowedHosts().size > 0 && !this.#o.token) {
      throw new Error("web.allowedHosts makes the control panel reachable from outside: set LEFTOFF_WEB_TOKEN in secrets.env first");
    }
    const server = createServer((req, res) => void this.#route(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.#server = server;
    // A project can turn private while the panel is open: look again at the moment of sending.
    const onEntry = (entry: FeedEntry) => void this.#broadcastFeed(entry);
    this.#o.feed.on("entry", onEntry);
    this.#unsubscribe = () => this.#o.feed.off("entry", onEntry);
    this.#heartbeat = setInterval(() => this.#clients.forEach((c) => c.write(": ping\n\n")), 25_000);
    this.#heartbeat.unref();
    this.#log(`control panel: http://${host === "0.0.0.0" ? "localhost" : host}:${this.port}${this.#o.token ? "/?token=…" : ""}`);
  }

  async stop(): Promise<void> {
    clearInterval(this.#heartbeat);
    this.#unsubscribe?.();
    this.#clients.forEach((c) => c.end());
    this.#clients.clear();
    const server = this.#server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #broadcastFeed(entry: FeedEntry): Promise<void> {
    if (!this.#clients.size) return;
    try {
      if (!(await this.#visible())(entry)) return;
    } catch {
      return; // when in doubt, say nothing
    }
    this.#broadcast("feed", entry);
  }

  /** The PM wrote to an agent: the office walks it over. Only for a project the panel may show, looked at now. */
  async contact(contact: Contact): Promise<void> {
    if (!this.#clients.size) return;
    try {
      const ids = new Set((await this.#o.data.projects()).map((p) => p.id));
      if (!ids.has(contact.project)) return;
    } catch {
      return; // when in doubt, say nothing
    }
    this.#broadcast("contact", { project: contact.project, agent: contact.agent, kind: contact.kind });
  }

  #broadcast(event: string, data: unknown): void {
    if (!this.#clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.#clients) client.write(frame);
  }

  /** The browser must be talking to us by our own name, and (for writes) from our own page. */
  #hostOk(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    return LOOPBACK.has(this.#o.config.host) ? LOOPBACK.has(host) || this.#allowedHosts().has(host) : true;
  }

  #allowedHosts(): Set<string> {
    return new Set((this.#o.config.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  }

  #cookieToken(req: IncomingMessage): string {
    const raw = req.headers.cookie ?? "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return decodeURIComponent(v.join("="));
    }
    return "";
  }

  #authed(req: IncomingMessage): boolean {
    const token = this.#o.token;
    if (!token) return true;
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    return same(this.#cookieToken(req), token) || same(bearer, token);
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.#hostOk(req)) throw new HttpError(403, "unknown host");
      const url = new URL(req.url ?? "/", "http://panel.local");
      const method = req.method ?? "GET";

      // First visit with the password in the link: keep it in a cookie, then drop it from the address bar.
      const given = url.searchParams.get("token");
      if (this.#o.token && given !== null && same(given, this.#o.token)) {
        // Behind an HTTPS forwarder the cookie must not travel over anything else.
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.writeHead(302, { "set-cookie": `${COOKIE}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`, location: "/" });
        res.end();
        return;
      }
      if (!this.#authed(req)) throw new HttpError(401, "Open the link with ?token=… (LEFTOFF_WEB_TOKEN) once.");

      if (method === "GET" && ASSETS[url.pathname]) return await this.#asset(res, ASSETS[url.pathname]!);
      if (url.pathname.startsWith("/api/")) return await this.#api(req, res, url, method);
      throw new HttpError(404, "not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) this.#log(`web: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: status === 500 ? "internal error" : (error as Error).message }));
    }
  }

  async #asset(res: ServerResponse, asset: { file: string; type: string }): Promise<void> {
    const body = await readFile(new URL(`./public/${asset.file}`, import.meta.url)).catch(() => null);
    if (!body) throw new HttpError(404, "not found");
    res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache", ...SECURITY_HEADERS });
    res.end(body);
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  }

  /** The feed entries the owner may see: a project that has turned private has no voice here. */
  async #visible(): Promise<(e: FeedEntry) => boolean> {
    const ids = new Set((await this.#o.data.projects()).map((p) => p.id));
    return (e) => e.projectId === null || ids.has(e.projectId);
  }

  async #api(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const { data, feed } = this.#o;

    if (method === "GET" && url.pathname === "/api/overview") return this.#json(res, 200, await data.overview());

    const detail = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && detail) {
      let id: string;
      try {
        id = decodeURIComponent(detail[1]!);
      } catch {
        throw new HttpError(400, "malformed project id");
      }
      const found = await data.detail(id);
      if (!found) throw new HttpError(404, "no such project");
      return this.#json(res, 200, found);
    }

    if (method === "GET" && url.pathname === "/api/feed") {
      const project = url.searchParams.get("project");
      const visible = await this.#visible();
      const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      const before = url.searchParams.get("before") ?? undefined;
      // `project` absent: everything (the general log); a project id: that thread; `general`: only the general thread.
      const keep = (e: FeedEntry) => visible(e) && (project === null || (project === "general" ? e.projectId === null : e.projectId === project));
      return this.#json(res, 200, { entries: feed.recent({ limit, ...(before ? { before } : {}), keep }), draft: data.draft(project && project !== "general" ? project : null), busy: [...this.#busy] });
    }

    if (method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no", ...SECURITY_HEADERS });
      res.write("retry: 3000\n\n");
      this.#clients.add(res);
      req.on("close", () => this.#clients.delete(res));
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      const body = await jsonBody<{ project?: unknown; text?: unknown }>(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 4000) throw new HttpError(400, "the message is empty or too long");
      const project = typeof body.project === "string" && body.project !== "general" ? body.project : null;
      if (project && !(await data.project(project))) throw new HttpError(404, "no such project");

      const thread = project ?? "general";
      if (this.#busy.has(thread)) throw new HttpError(429, "the PM is still answering the last message");
      const entry = await this.#o.mirror.recordOwner(project, text);
      this.#busy.add(thread);
      this.#broadcast("typing", { project: thread, on: true });
      void this.#o.mirror
        .fromWeb(project, text)
        .catch((error: Error) => this.#log(`web chat failed: ${error.message}`))
        .finally(() => {
          this.#busy.delete(thread);
          this.#broadcast("typing", { project: thread, on: false });
          this.#broadcast("refresh", {});
        });
      return this.#json(res, 202, { entry });
    }

    const settings = this.#o.settings;
    if (settings && url.pathname === "/api/settings/pm") {
      if (method === "GET") return this.#json(res, 200, settings.pm());
      if (method === "POST") {
        const body = await jsonBody<{ model?: unknown; effort?: unknown }>(req);
        const pm = await settled(settings.setPm(body));
        this.#broadcast("refresh", {});
        return this.#json(res, 200, pm);
      }
    }
    const agentSettings = /^\/api\/settings\/projects\/([^/]+)\/agents(?:\/([^/]+))?$/.exec(url.pathname);
    if (settings && agentSettings) {
      let id: string;
      let agentId: string | undefined;
      try {
        id = decodeURIComponent(agentSettings[1]!);
        agentId = agentSettings[2] === undefined ? undefined : decodeURIComponent(agentSettings[2]);
      } catch {
        throw new HttpError(400, "malformed id");
      }
      const project = await data.project(id);
      if (!project) throw new HttpError(404, "no such project");
      if (method === "GET" && agentId === undefined) return this.#json(res, 200, { agents: await settings.agents(project) });
      if (method === "POST" && agentId !== undefined) {
        const body = await jsonBody<{ model?: unknown; thinking?: unknown }>(req);
        const changed = await settled(settings.setAgent(project, agentId, body));
        this.#broadcast("refresh", {});
        return this.#json(res, 200, changed);
      }
    }

    throw new HttpError(404, "not found");
  }
}

/** A refused setting is the owner's to read, with the status it deserves; anything else stays a 500. */
async function settled<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw error instanceof SettingsError ? new HttpError(error.status, error.message) : error;
  }
}

/** The body of a write: only from the panel's own page, only JSON. */
async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  const origin = req.headers.origin;
  if (origin !== undefined && originHost(origin) !== req.headers.host) throw new HttpError(403, "cross-origin request");
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send JSON");
  try {
    const parsed = JSON.parse((await readBody(req)) || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "send a JSON object");
    return parsed as T;
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(400, "not valid JSON");
  }
}

/** The host of an Origin header, or null when it is not a URL at all ("null" is what sandboxed pages send). */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
