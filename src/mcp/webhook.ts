import { createHmac, randomBytes } from "node:crypto";
import type { Config } from "../core/config.ts";
import type { LeftoffEvent } from "../hub/events.ts";

/**
 * Leftoff's events pushed to an assistant (D-061, MCP-3): one POST per event, signed with the Standard Webhooks
 * scheme, which Hermes and other receivers verify as is. The body is the event as `get_events` gives it, so a missed
 * delivery loses nothing: the cursor still has it.
 */

/** The shared secret, kept in secrets.env and created by `leftoff mcp webhook-secret`. */
export const WEBHOOK_SECRET_KEY = "LEFTOFF_WEBHOOK_SECRET";

/** A Standard Webhooks secret: `whsec_` and 32 random bytes in base64 (the key is those bytes). */
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

/** `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`. A `whsec_` secret's key is its decoded bytes; any other is its text. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** What is POSTed: flat, so a receiver's template reads {project}, {kind}, {text} directly. */
export function webhookBody(event: LeftoffEvent): Record<string, unknown> {
  const { seq, ...rest } = event;
  return { type: `leftoff.${event.kind}`, cursor: String(seq), ...rest };
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface WebhookOptions {
  config: Config["mcp"]["webhook"];
  secret: string | undefined;
  fetch?: FetchFn;
  log?: (line: string) => void;
  /** Waits before each retry; three by default, up to five minutes. */
  delays?: number[];
  now?: () => number;
}

export class WebhookSender {
  readonly #o: WebhookOptions;
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor(options: WebhookOptions) {
    this.#o = options;
  }

  /** Why it cannot send, or null when it can: enabled, an http(s) URL, a secret. */
  get problem(): string | null {
    const { enabled, url } = this.#o.config;
    if (!enabled) return "disabled";
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return "mcp.webhook.url is not an http(s) address";
    if (!this.#o.secret) return `no ${WEBHOOK_SECRET_KEY} in secrets.env: run \`leftoff mcp webhook-secret\``;
    return null;
  }

  /** Send one event, in the background; failures are retried, then left to `get_events`. */
  send(event: LeftoffEvent): void {
    if (this.problem || !this.#o.config.events.includes(event.kind)) return;
    void this.#attempt(event, 0);
  }

  async #attempt(event: LeftoffEvent, tries: number): Promise<void> {
    const delays = this.#o.delays ?? [10_000, 60_000, 300_000];
    const body = JSON.stringify(webhookBody(event));
    // Signed afresh at each try, with the same id: receivers refuse stale timestamps and drop repeated ids.
    const id = `leftoff_${event.seq}`;
    const timestamp = Math.floor((this.#o.now ?? Date.now)() / 1000);
    let failure: string;
    try {
      const response = await (this.#o.fetch ?? (fetch as unknown as FetchFn))(this.#o.config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "leftoff-webhook",
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signWebhook(this.#o.secret!, id, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = (error as Error).message;
    }
    if (tries < delays.length) {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        void this.#attempt(event, tries + 1);
      }, delays[tries]);
      this.#timers.add(timer);
      return;
    }
    this.#o.log?.(`webhook: event ${event.seq} not delivered after ${tries + 1} tries (${failure}); it stays in get_events`);
  }

  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}
