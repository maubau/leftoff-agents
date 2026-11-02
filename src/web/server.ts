import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MirrorChannel } from "../channels/mirror.ts";
import type { Config } from "../core/config.ts";
import { NewProjectError } from "../commands/new-project.ts";
import { TaskSayRefused, type Contact, type FileView, type OwnerTaskView } from "../hub/hub.ts";
import { FILE_MAX, FileRefused, isText, type StoredFile } from "../hub/files.ts";
import { CHAT_TEXT_MAX, DETAIL_MAX, TITLE_MAX, type OwnerTask, type TaskChatLine } from "../hub/owner-tasks.ts";
import type { ProjectJobs } from "../hub/project-jobs.ts";
import type { ProjectJob } from "../hub/state.ts";
import type { Data } from "./data.ts";
import type { Feed, FeedEntry } from "./feed.ts";
import { SettingsError, type Settings } from "./settings.ts";
import type { LoginLinks } from "./login-links.ts";

const COOKIE = "leftoff_web";
/**
 * What the owner may write to the PM in one message: long enough to paste a brief, a spec or a log (was 4000).
 * About 10-13k tokens, a small part of the PM model's context; the cost of a long message is the owner's choice.
 */
export const CHAT_MAX = 40_000;
/** Room for CHAT_MAX characters even at four bytes each, plus JSON escaping. */
const MAX_BODY = 256 * 1024;
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
  "/building.js": { file: "building.js", type: "text/javascript; charset=utf-8" },
  "/home.js": { file: "home.js", type: "text/javascript; charset=utf-8" },
  "/art.js": { file: "art.js", type: "text/javascript; charset=utf-8" },
  "/jobs.js": { file: "jobs.js", type: "text/javascript; charset=utf-8" },
  "/ownertasks.js": { file: "ownertasks.js", type: "text/javascript; charset=utf-8" },
  "/choices.js": { file: "choices.js", type: "text/javascript; charset=utf-8" },
  "/codeblocks.js": { file: "codeblocks.js", type: "text/javascript; charset=utf-8" },
  "/pixeltext.js": { file: "pixeltext.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

export interface WebOptions {
  config: Omit<Config["web"], "allowedHosts"> & { allowedHosts?: string[] };
  data: Data;
  feed: Feed;
  /** The activity register (D-052): steps between the PM and the agents, apart from the conversation. */
  activity?: Feed;
  mirror: MirrorChannel;
  /** Model and effort of the PM and of the agents; without it those endpoints do not exist. */
  settings?: Settings;
  /** New projects made from the panel (D-056); without it those endpoints do not exist. */
  projects?: ProjectJobs;
  /** The shared secret, from LEFTOFF_WEB_TOKEN. Required unless the panel listens on loopback only. */
  token?: string | undefined;
  /** One-time links from /panel (D-073): each sets the password's cookie, once. */
  logins?: LoginLinks;
  /** «Your tasks» (D-070), kept by the hub; without it those endpoints do not exist. */
  tasks?: OwnerTasksApi;
  log?: (line: string) => void;
}

/** The hub's side of «Your tasks» (D-070, phase 2): it keeps them, routes each task's chat, and hides private projects. */
export interface OwnerTasksApi {
  taskList(filter: { project?: string; status?: OwnerTask["status"] }): Promise<OwnerTaskView[]>;
  taskGet(id: string): Promise<OwnerTaskView | undefined>;
  taskAdd(input: { project: string; title: string; detail?: string; urgent?: boolean }): Promise<{ task: OwnerTaskView; created: boolean } | undefined>;
  taskClose(id: string, status: "done" | "dropped"): Promise<OwnerTaskView | undefined>;
  taskChat(id: string): Promise<TaskChatLine[] | undefined>;
  taskSay(id: string, text: string, options?: { files?: string[]; anyway?: boolean }): Promise<{ entry: TaskChatLine; answered: Promise<void> } | undefined>;
  taskUpload(id: string, name: string, bytes: Uint8Array): Promise<FileView | undefined>;
  fileFor(projectId: string, fileId: string): Promise<StoredFile | undefined>;
  fileList(projectId: string): Promise<FileView[] | undefined>;
  setTaskHelperOf(id: string, helper: string | null): Promise<OwnerTaskView | "not-found" | "not-offered">;
  taskHelpers(projectId: string): Promise<{ current: { id: string; name: string; why: string }; default: { id: string; name: string }; candidates: Array<{ id: string; name: string }> } | undefined>;
  setProjectTaskHelper(projectId: string, helper: string | null): Promise<"ok" | "no-project" | "not-offered">;
}

/** What a task's title may be when the owner types it: one line, something in it. */
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
    const onActivity = (entry: FeedEntry) => void this.#broadcastFeed(entry, "activity");
    this.#o.feed.on("entry", onEntry);
    this.#o.activity?.on("entry", onActivity);
    this.#unsubscribe = () => {
      this.#o.feed.off("entry", onEntry);
      this.#o.activity?.off("entry", onActivity);
    };
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

  async #broadcastFeed(entry: FeedEntry, event: "feed" | "activity" = "feed"): Promise<void> {
    if (!this.#clients.size) return;
    try {
      if (!(await this.#visible())(entry)) return;
    } catch {
      return; // when in doubt, say nothing
    }
    this.#broadcast(event, entry);
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
      // Or a one-time link from /panel in Telegram (D-073): the same cookie, and the password never travelled.
      const login = url.searchParams.get("login");
      if (this.#o.token && login !== null && this.#o.logins?.consume(login)) {
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.writeHead(302, { "set-cookie": `${COOKIE}=${encodeURIComponent(this.#o.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`, location: "/" });
        res.end();
        return;
      }
      if (this.#o.token && given !== null && same(given, this.#o.token)) {
        // Behind an HTTPS forwarder the cookie must not travel over anything else.
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.writeHead(302, { "set-cookie": `${COOKIE}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`, location: "/" });
        res.end();
        return;
      }
      if (!this.#authed(req)) throw new HttpError(401, "Not signed in on this browser. Send /panel (/pannello) to the Leftoff bot in Telegram for a one-time link, or open the link from `leftoff web link` once.");

      if (method === "GET" && ASSETS[url.pathname]) return await this.#asset(res, ASSETS[url.pathname]!);
      if (url.pathname.startsWith("/api/")) return await this.#api(req, res, url, method);
      throw new HttpError(404, "not found");
    } catch (error) {
      // A refused name or step: its type and the rest let the panel say it in the owner's language.
      if (error instanceof NewProjectError) {
        if (!res.headersSent) res.writeHead(error.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
        res.end(JSON.stringify(error.toJSON()));
        return;
      }
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

  /** A new project's creation (D-056): the form's options and check, the jobs, and a retry. */
  async #newProject(req: IncomingMessage, res: ServerResponse, url: URL, method: string, jobs: ProjectJobs): Promise<void> {
    if (method === "GET" && url.pathname === "/api/projects/options") return this.#json(res, 200, await jobs.options());
    if (method === "POST" && url.pathname === "/api/projects/check") {
      const body = await jsonBody<{ name?: unknown }>(req);
      return this.#json(res, 200, await jobs.check(body.name));
    }
    const visible = await this.#jobVisible();
    if (method === "GET" && url.pathname === "/api/projects/jobs") return this.#json(res, 200, { jobs: jobs.list().filter(visible) });
    const one = /^\/api\/projects\/jobs\/([^/]+)(\/retry)?$/.exec(url.pathname);
    if (one) {
      const job = jobs.get(decodeURIComponent(one[1]!));
      if (!job || !visible(job)) throw new HttpError(404, "no such creation");
      if (method === "GET" && !one[2]) return this.#json(res, 200, { job });
      if (method === "POST" && one[2]) {
        await jsonBody(req);
        return this.#json(res, 200, { job: await jobs.retry(job.id) });
      }
    }
    throw new HttpError(404, "not found");
  }

  /**
   * A task changed (D-070): the SSE event `owner-task` `{task}` to every open panel, and `owner-task-chat`
   * `{taskId, entry}` when a line of its chat changed it. The hub never says a private project's.
   */
  ownerTask(change: { task: OwnerTaskView; entry?: TaskChatLine }): void {
    this.#broadcast("owner-task", { task: change.task });
    if (change.entry) this.#broadcast("owner-task-chat", { taskId: change.task.id, entry: change.entry });
  }

  /** «Your tasks» (D-070, phase 2): list, add, close, who helps, and each task's chat. */
  async #ownerTasks(req: IncomingMessage, res: ServerResponse, url: URL, method: string, tasks: OwnerTasksApi): Promise<void> {
    if (url.pathname === "/api/owner-tasks") {
      if (method === "GET") {
        const project = url.searchParams.get("project") ?? undefined;
        const status = url.searchParams.get("status") ?? "open";
        if (!["open", "done", "dropped", "all"].includes(status)) throw new HttpError(400, "status must be open, done, dropped or all");
        const list = await tasks.taskList({ ...(project ? { project } : {}), ...(status === "all" ? {} : { status: status as OwnerTask["status"] }) });
        return this.#json(res, 200, { tasks: list });
      }
      if (method === "POST") {
        const body = await jsonBody<{ project?: unknown; title?: unknown; detail?: unknown; urgent?: unknown }>(req);
        const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
        if (!/[\p{L}\p{N}]/u.test(title) || title.length > TITLE_MAX) throw new HttpError(400, `the task needs a title, up to ${TITLE_MAX} characters`);
        if (typeof body.project !== "string") throw new HttpError(400, "say which project");
        if (body.detail !== undefined && (typeof body.detail !== "string" || body.detail.length > DETAIL_MAX)) throw new HttpError(400, `the detail must be text, up to ${DETAIL_MAX} characters`);
        if (body.urgent !== undefined && typeof body.urgent !== "boolean") throw new HttpError(400, "urgent must be true or false");
        const made = await tasks.taskAdd({ project: body.project, title, ...(body.detail ? { detail: body.detail as string } : {}), ...(body.urgent ? { urgent: true } : {}) });
        if (!made) throw new HttpError(404, "no such project");
        return this.#json(res, made.created ? 201 : 200, made);
      }
    }
    const one = /^\/api\/owner-tasks\/(OWN-\d{1,9})(?:\/(done|drop|chat|helper|files))?$/i.exec(url.pathname);
    if (one) {
      const id = one[1]!.toUpperCase();
      const action = one[2]?.toLowerCase();
      if (method === "GET" && !action) {
        const task = await tasks.taskGet(id);
        if (!task) throw new HttpError(404, "no such task");
        return this.#json(res, 200, { task });
      }
      if (method === "POST" && (action === "done" || action === "drop")) {
        await jsonBody(req);
        const task = await tasks.taskClose(id, action === "done" ? "done" : "dropped");
        if (!task) throw new HttpError(404, "no open task with that id");
        return this.#json(res, 200, { task });
      }
      if (method === "POST" && action === "helper") {
        const body = await jsonBody<{ helper?: unknown }>(req);
        if (body.helper !== null && typeof body.helper !== "string") throw new HttpError(400, "helper must be one of those offered, or null");
        const task = await tasks.setTaskHelperOf(id, (body.helper as string | null) || null);
        if (task === "not-found") throw new HttpError(404, "no such task");
        if (task === "not-offered") throw new HttpError(400, "not one of the helpers offered for this project");
        return this.#json(res, 200, { task });
      }
      if (method === "GET" && action === "chat") {
        const entries = await tasks.taskChat(id);
        if (!entries) throw new HttpError(404, "no such task");
        return this.#json(res, 200, { entries });
      }
      // A file for the task's chat (D-071): the bytes as they are, sent with the owner's next words.
      if (method === "PUT" && action === "files") {
        const name = url.searchParams.get("name") ?? "";
        if (!name.trim()) throw new HttpError(400, "say the file's name: ?name=…");
        const bytes = await uploadBody(req);
        try {
          const file = await tasks.taskUpload(id, name, bytes);
          if (!file) throw new HttpError(404, "no such task");
          return this.#json(res, 201, { file });
        } catch (error) {
          if (error instanceof FileRefused) throw new HttpError(error.status, error.message);
          throw error;
        }
      }
      if (method === "POST" && action === "chat") {
        const body = await jsonBody<{ text?: unknown; files?: unknown; anyway?: unknown }>(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const files = body.files === undefined ? [] : body.files;
        if (!Array.isArray(files) || files.length > 10 || !files.every((f) => typeof f === "string" && /^f[a-z0-9]{1,40}$/.test(f))) throw new HttpError(400, "files must be up to 10 file ids");
        if (body.anyway !== undefined && typeof body.anyway !== "boolean") throw new HttpError(400, "anyway must be true or false");
        if (!text && !files.length) throw new HttpError(400, "the message is empty");
        if (text.length > CHAT_TEXT_MAX) throw new HttpError(400, `the message is too long (${text.length} characters, at most ${CHAT_TEXT_MAX})`);
        const thread = `task:${id}`;
        if (this.#busy.has(thread)) throw new HttpError(429, "the last message is still on its way");
        let said: Awaited<ReturnType<OwnerTasksApi["taskSay"]>>;
        try {
          said = await tasks.taskSay(id, text, { files: files as string[], ...(body.anyway === true ? { anyway: true } : {}) });
        } catch (error) {
          if (!(error instanceof TaskSayRefused)) throw error;
          // A key: the panel asks «send it anyway?» and sends again with anyway: true.
          if (error.reason === "key") return this.#json(res, 409, { error: error.message, keyIn: error.names });
          throw new HttpError(400, error.message);
        }
        if (!said) throw new HttpError(404, "no such task");
        this.#busy.add(thread);
        this.#broadcast("typing", { project: thread, on: true });
        void said.answered.finally(() => {
          this.#busy.delete(thread);
          this.#broadcast("typing", { project: thread, on: false });
        });
        return this.#json(res, 202, { entry: said.entry });
      }
    }
    throw new HttpError(404, "not found");
  }

  /** A creation is shown unless its project has since been made private. */
  async #jobVisible(): Promise<(job: ProjectJob) => boolean> {
    const hidden = new Set((await this.#o.data.privateIds()));
    return (job) => !hidden.has(job.projectId);
  }

  /** Every change of a creation, to every open panel (the SSE event `project`). */
  async projectJob(job: ProjectJob): Promise<void> {
    if ((await this.#jobVisible())(job)) this.#broadcast("project", job);
    if (job.status === "done") this.#broadcast("refresh", {});
  }

  /** The feed entries the owner may see: a project that has turned private has no voice here. */
  async #visible(): Promise<(e: FeedEntry) => boolean> {
    const ids = new Set((await this.#o.data.projects()).map((p) => p.id));
    return (e) => e.projectId === null || ids.has(e.projectId);
  }

  async #api(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const { data, feed } = this.#o;

    if (method === "GET" && url.pathname === "/api/overview") return this.#json(res, 200, await data.overview());

    const jobs = this.#o.projects;
    if (jobs && url.pathname.startsWith("/api/projects/") && (url.pathname === "/api/projects/options" || url.pathname === "/api/projects/check" || url.pathname.startsWith("/api/projects/jobs"))) {
      return await this.#newProject(req, res, url, method, jobs);
    }
    if (jobs && method === "POST" && url.pathname === "/api/projects") {
      const body = await jsonBody<{ name?: unknown; purpose?: unknown }>(req);
      // Never private (D-056): a private project never reaches the panel, so it is not made from here.
      return this.#json(res, 202, { job: await jobs.start({ name: body.name, purpose: body.purpose }, "web") });
    }

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

    if (method === "GET" && url.pathname === "/api/activity") {
      // The register (D-052): same paging as the feed; `project` absent is every project, `agent` keeps one agent's steps.
      const project = url.searchParams.get("project");
      const agent = url.searchParams.get("agent");
      const visible = await this.#visible();
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      const before = url.searchParams.get("before") ?? undefined;
      const keep = (e: FeedEntry) =>
        visible(e) && (project === null || e.projectId === project) && (agent === null || e.activity?.agent === agent || e.activity?.to === agent);
      return this.#json(res, 200, { entries: this.#o.activity?.recent({ limit, ...(before ? { before } : {}), keep }) ?? [] });
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
      if (!text) throw new HttpError(400, "the message is empty");
      if (text.length > CHAT_MAX) throw new HttpError(400, `the message is too long (${text.length} characters, at most ${CHAT_MAX})`);
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

    const tasks = this.#o.tasks;
    if (tasks && (url.pathname === "/api/owner-tasks" || url.pathname.startsWith("/api/owner-tasks/"))) return await this.#ownerTasks(req, res, url, method, tasks);
    // Kept files (D-071): a project's list, and one file — an image shown, anything else downloaded, never a web page.
    if (tasks && method === "GET" && url.pathname === "/api/files") {
      const list = await tasks.fileList(url.searchParams.get("project") ?? "");
      if (!list) throw new HttpError(404, "no such project");
      return this.#json(res, 200, { files: list });
    }
    const fileRoute = /^\/api\/files\/([A-Za-z0-9._-]{1,80})\/(f[a-z0-9]{1,40})$/.exec(url.pathname);
    if (tasks && method === "GET" && fileRoute) {
      const file = await tasks.fileFor(fileRoute[1]!, fileRoute[2]!);
      if (!file) throw new HttpError(404, "no such file");
      const bytes = await readFile(file.path).catch(() => null);
      if (!bytes) throw new HttpError(404, "no such file");
      const image = file.type.startsWith("image/");
      res.writeHead(200, {
        "content-type": isText(file.type) ? `${file.type}; charset=utf-8` : file.type,
        "content-length": String(bytes.length),
        "content-disposition": `${image ? "inline" : "attachment"}; filename="${file.name}"`,
        // Not kept by the browser: a file deleted here is gone there too.
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
        // Only the panel's own pages may embed it.
        "cross-origin-resource-policy": "same-origin",
        // Whatever it holds, it runs nothing here.
        "content-security-policy": "default-src 'none'; sandbox",
      });
      res.end(bytes);
      return;
    }
    // Who helps a project's tasks (D-070): `pm.tasks.helpers`, or the default with null.
    const taskHelper = /^\/api\/settings\/projects\/([^/]+)\/task-helper$/.exec(url.pathname);
    if (tasks && taskHelper) {
      let id: string;
      try {
        id = decodeURIComponent(taskHelper[1]!);
      } catch {
        throw new HttpError(400, "malformed id");
      }
      if (method === "GET") {
        const helpers = await tasks.taskHelpers(id);
        if (!helpers) throw new HttpError(404, "no such project");
        return this.#json(res, 200, helpers);
      }
      if (method === "POST") {
        const body = await jsonBody<{ helper?: unknown }>(req);
        if (body.helper !== null && typeof body.helper !== "string") throw new HttpError(400, "helper must be one of those offered, or null");
        const done = await tasks.setProjectTaskHelper(id, (body.helper as string | null) || null);
        if (done === "no-project") throw new HttpError(404, "no such project");
        if (done === "not-offered") throw new HttpError(400, "not one of the helpers offered for this project");
        this.#broadcast("refresh", {});
        return this.#json(res, 200, await tasks.taskHelpers(id));
      }
    }

    const settings = this.#o.settings;
    if (settings && url.pathname === "/api/settings/pm") {
      if (method === "GET") return this.#json(res, 200, await settings.pm());
      if (method === "POST") {
        const body = await jsonBody<{ model?: unknown; effort?: unknown; operational?: unknown }>(req);
        const pm = await settled(settings.setPm(body));
        this.#broadcast("refresh", {});
        return this.#json(res, 200, pm);
      }
    }
    // /agents (list), /agents/:agent (model, thinking), /agents/:agent/profile (name, role), /new-agent (options, create), /mode, /delegate
    const projectSettings = /^\/api\/settings\/projects\/([^/]+)\/(agents|new-agent|mode|delegate)(?:\/([^/]+)(\/profile)?)?$/.exec(url.pathname);
    if (settings && projectSettings) {
      const [, rawId, kind, rawAgent, profile] = projectSettings;
      let id: string;
      let agentId: string | undefined;
      try {
        id = decodeURIComponent(rawId!);
        agentId = rawAgent === undefined ? undefined : decodeURIComponent(rawAgent);
      } catch {
        throw new HttpError(400, "malformed id");
      }
      const project = await data.project(id);
      if (!project) throw new HttpError(404, "no such project");
      if (kind === "new-agent" && agentId === undefined) {
        if (method === "GET") return this.#json(res, 200, await settings.newAgentOptions());
        if (method === "POST") {
          const body = await jsonBody<Record<string, unknown>>(req);
          const created = await settled(settings.createAgent(project, body));
          this.#broadcast("refresh", {});
          return this.#json(res, 201, created);
        }
      }
      if (kind === "delegate" && method === "POST" && agentId === undefined) {
        const body = await jsonBody<{ on?: unknown }>(req);
        const changed = await settled(settings.setDelegation(project, body));
        this.#broadcast("refresh", {});
        return this.#json(res, 200, changed);
      }
      if (kind === "mode" && method === "POST" && agentId === undefined) {
        const body = await jsonBody<{ mode?: unknown }>(req);
        const changed = await settled(settings.setMode(project, body));
        this.#broadcast("refresh", {});
        return this.#json(res, 200, changed);
      }
      if (kind === "agents" && method === "GET" && agentId === undefined) return this.#json(res, 200, { agents: await settings.agents(project) });
      if (kind === "agents" && method === "POST" && agentId !== undefined) {
        const body = await jsonBody<Record<string, unknown>>(req);
        const changed = profile ? await settled(settings.setProfile(project, agentId, body)) : await settled(settings.setAgent(project, agentId, body));
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

/**
 * An upload (D-071): only from the panel's own page — the same origin, and a header a form or an image tag cannot send,
 * so another site cannot post one — at most FILE_MAX bytes.
 */
async function uploadBody(req: IncomingMessage): Promise<Uint8Array> {
  const origin = req.headers.origin;
  if (origin !== undefined && originHost(origin) !== req.headers.host) throw new HttpError(403, "cross-origin request");
  if (req.headers["x-leftoff-upload"] !== "1") throw new HttpError(403, "uploads come from the panel");
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > FILE_MAX) throw new HttpError(413, `the file is over ${FILE_MAX / 1024 / 1024} MB`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > FILE_MAX) throw new HttpError(413, `the file is over ${FILE_MAX / 1024 / 1024} MB`);
    chunks.push(chunk as Buffer);
  }
  // A Buffer is a Uint8Array: no second copy of up to 20 MB.
  return Buffer.concat(chunks);
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
