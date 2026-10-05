import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configRoot } from "../core/paths.ts";
import { redact } from "../hub/redact.ts";

/**
 * One line of the conversation between the owner and the PM, whichever app it happened in.
 * `pm` is anything the PM said (an alert it pushed, or the answer to a question); `owner` is
 * what the owner wrote. `source` says where it was typed or delivered.
 */
export interface FeedEntry {
  id: string;
  at: string;
  /** The project's thread, or null for the general conversation. */
  projectId: string | null;
  role: "pm" | "owner";
  source: "telegram" | "web" | "console" | "hub";
  /** `push`: the PM spoke first. `reply`: it answered the owner. `log`: something it chose not to send to chat. */
  kind: "push" | "reply" | "ask" | "log";
  text: string;
}

const KEEP = 1500;
const file = () => join(configRoot(), "feed.jsonl");

/**
 * The PM's log, kept on disk so the browser shows exactly what Telegram showed — including what
 * was said while no browser was open. Append-only; trimmed to the newest {@link KEEP} lines.
 */
export class Feed extends EventEmitter<{ entry: [FeedEntry] }> {
  #entries: FeedEntry[] = [];
  #writes = 0;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #path: string;

  constructor(path = file()) {
    super();
    this.#path = path;
  }

  async load(): Promise<void> {
    const raw = await readFile(this.#path, "utf8").catch(() => "");
    const entries: FeedEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as FeedEntry);
      } catch {
        /* a torn line is not worth losing the log for */
      }
    }
    this.#entries = entries.slice(-KEEP);
  }

  /** Record a line. Redacted here too: the feed is a second place secrets could leak from. */
  async append(entry: Omit<FeedEntry, "id" | "at"> & { at?: string }): Promise<FeedEntry> {
    const full: FeedEntry = { id: randomUUID(), at: new Date().toISOString(), ...entry, text: redact(entry.text) };
    this.#entries.push(full);
    if (this.#entries.length > KEEP * 1.5) this.#entries = this.#entries.slice(-KEEP);
    this.emit("entry", full);
    // Writes are chained so lines never interleave; a failed write must not break the hub.
    this.#queue = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, `${JSON.stringify(full)}\n`, "utf8");
      if (++this.#writes % 200 === 0) await writeFile(this.#path, this.#entries.slice(-KEEP).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    }).catch(() => undefined);
    return full;
  }

  /** Settles when everything appended so far is on disk. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  /** Newest `limit` entries that pass `keep`, oldest first. `before` pages backwards. */
  recent(options: { limit?: number; before?: string; keep?: (e: FeedEntry) => boolean } = {}): FeedEntry[] {
    const { limit = 100, before, keep = () => true } = options;
    let pool = this.#entries;
    if (before) {
      const at = pool.findIndex((e) => e.id === before);
      if (at >= 0) pool = pool.slice(0, at);
    }
    return pool.filter(keep).slice(-limit);
  }
}
