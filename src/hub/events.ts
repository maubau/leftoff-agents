import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configRoot } from "../core/paths.ts";
import type { Project } from "../core/project.ts";
import { redact } from "./redact.ts";

/**
 * What happened, as events with a cursor, for clients that were away (D-061): an agent done, blocked, needing the owner
 * or idle, and commits nobody reported. One append-only file written by the hub, read by `get_events`; summaries only,
 * redacted, and never about a private project.
 */
export const EVENT_KINDS = ["done", "blocked", "needs_input", "idle", "unreported_commits"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface LeftoffEvent {
  /** Increasing, never reused: the cursor. */
  seq: number;
  at: string;
  project: string;
  kind: EventKind;
  agent?: string;
  text: string;
  question?: { options: string[]; recommend?: string };
}

const KEEP_MS = 30 * 86_400_000;
export const eventsFile = () => join(configRoot(), "events.jsonl");

/** Every line, oldest first; a damaged line is skipped, not fatal. */
export async function readAllEvents(): Promise<LeftoffEvent[]> {
  const raw = await readFile(eventsFile(), "utf8").catch(() => "");
  const out: LeftoffEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LeftoffEvent;
      if (typeof e.seq === "number" && typeof e.at === "string") out.push(e);
    } catch {
      /* a half-written last line after a crash */
    }
  }
  return out;
}

/** Writes are chained, so two events of one pass never get the same cursor. */
let queue: Promise<unknown> = Promise.resolve();

export function appendEvent(project: Project, event: Omit<LeftoffEvent, "seq" | "at" | "project">, at: Date): Promise<LeftoffEvent | null> {
  const run = queue.then(async () => {
    if (project.config.visibility === "private") return null;
    const all = await readAllEvents();
    const full: LeftoffEvent = {
      seq: (all.at(-1)?.seq ?? 0) + 1,
      at: at.toISOString(),
      project: project.id,
      ...event,
      text: redact(event.text).slice(0, 500),
    };
    await mkdir(dirname(eventsFile()), { recursive: true });
    const since = at.getTime() - KEEP_MS;
    // Kept thirty days: the file is rewritten without the old ones when the oldest has expired.
    if (all.length && Date.parse(all[0]!.at) < since) {
      const kept = all.filter((e) => Date.parse(e.at) >= since);
      const tmp = `${eventsFile()}.tmp`;
      await writeFile(tmp, [...kept, full].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      await rename(tmp, eventsFile());
    } else {
      await appendFile(eventsFile(), `${JSON.stringify(full)}\n`, "utf8");
    }
    return full;
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Events after `since` (a cursor), oldest first, at most `limit`; with no cursor, those of the last day. `visible`
 * drops projects a caller must not see (made private since, or unknown).
 */
export async function readEvents(options: { since?: number; projects?: ReadonlySet<string>; kinds?: readonly EventKind[]; limit?: number; now?: number } = {}): Promise<{ events: LeftoffEvent[]; next: number | null }> {
  const all = await readAllEvents();
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const dayAgo = (options.now ?? Date.now()) - 86_400_000;
  const picked = all.filter(
    (e) =>
      (options.since === undefined ? Date.parse(e.at) >= dayAgo : e.seq > options.since) &&
      (!options.projects || options.projects.has(e.project)) &&
      (!options.kinds?.length || options.kinds.includes(e.kind)),
  );
  const events = picked.slice(0, limit);
  return { events, next: events.at(-1)?.seq ?? options.since ?? all.at(-1)?.seq ?? null };
}
