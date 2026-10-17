import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, originValidationResponse } from "@modelcontextprotocol/server";
import type { Config } from "../core/config.ts";
import { buildMcpServer } from "./server.ts";

/**
 * Leftoff's MCP server over Streamable HTTP (D-061), for an assistant on another machine. Its own listener, apart from
 * the panel's: machine clients with a bearer token, not a browser with a cookie. Loopback unless configured otherwise;
 * the token is always required, Host and Origin are checked (DNS rebinding), and every request is served by a fresh
 * server instance, statelessly, as the SDK's v2 handler does. The tools are the read tools of `leftoff mcp`.
 */

/** The bearer token MCP over HTTP requires, kept in secrets.env and created by `leftoff mcp token`. */
export const MCP_TOKEN_KEY = "LEFTOFF_MCP_TOKEN";

const MAX_BODY = 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface McpHttpOptions {
  config: Config["mcp"]["http"];
  /** `LEFTOFF_MCP_TOKEN`. Without it the server does not start. */
  token: string | undefined;
  log?: (line: string) => void;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class McpHttpServer {
  readonly #o: McpHttpOptions;
  #server: Server | undefined;

  constructor(options: McpHttpOptions) {
    this.#o = options;
  }

  get port(): number {
    return (this.#server?.address() as AddressInfo | null)?.port ?? this.#o.config.port;
  }

  /** The names a request may carry in Host (and Origin): loopback's, the configured address, and `allowedHosts`. */
  #allowed(): string[] {
    const { host, allowedHosts } = this.#o.config;
    const own = host === "0.0.0.0" || host === "::" ? [] : [host];
    return [...new Set([...localhostAllowedHostnames(), ...own, ...allowedHosts.map((h) => h.toLowerCase())])];
  }

  async start(): Promise<void> {
    const { host, port, path } = this.#o.config;
    if (!this.#o.token) throw new Error("no LEFTOFF_MCP_TOKEN in secrets.env: run `leftoff mcp token`, then restart the hub");
    this.#server = createServer((req, res) => void this.#route(req, res));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(port, host, () => resolve());
    });
    const where = LOOPBACK.has(host) ? "loopback only" : `on ${host}: reachable by whoever can reach that address, with the token`;
    this.#o.log?.(`mcp: http://${host.includes(":") ? `[${host}]` : host}:${this.port}${path} (${where})`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://mcp.local");
      if (url.pathname !== this.#o.config.path) return this.#plain(res, 404, "not found");
      const request = await toRequest(req);
      const allowed = this.#allowed();
      const refused = hostHeaderValidationResponse(request, allowed) ?? originValidationResponse(request, allowed);
      if (refused) return await this.#write(res, refused);
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
      if (!bearer || !same(bearer, this.#o.token!)) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="leftoff"', "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "a bearer token is required: Authorization: Bearer <LEFTOFF_MCP_TOKEN>" }));
        return;
      }
      // Who calls, for the audit log only: a short name the client chooses, never trusted for anything else.
      const client = /^[\w.@-]{1,40}$/.exec(String(req.headers["x-leftoff-client"] ?? ""))?.[0];
      const handler = createMcpHandler(() => buildMcpServer({ transport: "http", ...(client ? { client } : {}) }));
      await this.#write(res, await handler.fetch(request));
    } catch (error) {
      this.#o.log?.(`mcp: ${(error as Error).message}`);
      if (!res.headersSent) this.#plain(res, (error as { status?: number }).status ?? 500, (error as { status?: number }).status ? (error as Error).message : "internal error");
      else res.end();
    }
  }

  #plain(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: message }));
  }

  /** A web Response onto node's: status, headers, and the body streamed (a JSON answer, or an event stream). */
  async #write(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => (headers[key] = value));
    res.writeHead(response.status, headers);
    if (!response.body) return void res.end();
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(response.body as never).on("error", reject).pipe(res).on("finish", () => resolve()).on("error", reject);
    });
  }
}

/** node's request as a web Request, its body read whole (at most 1 MB: JSON-RPC messages are small). */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw Object.assign(new Error("request too large"), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method, headers, ...(body ? { body } : {}) });
}
