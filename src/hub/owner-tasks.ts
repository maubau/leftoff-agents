import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configRoot } from "../core/paths.ts";
import { redact } from "./redact.ts";
import { sameWords } from "./loops.ts";

/**
 * «Your tasks» (D-070): what the owner has to do, one task each, across projects. Kept on this machine, outside every
 * repository, written by the hub only (a CLI reading it is fine). Titles and details are redacted before they are kept;
 * a private project never has one.
 */

export type OwnerTaskSource = "next" | "question" | "handoff" | "pm" | "owner" | "guard";

export interface OwnerTask {
  /** `OWN-<n>`, one sequence for all projects, never reused. */
  id: string;
  project: string;
  title: string;
  detail: string;
  sources: Array<{ kind: OwnerTaskSource; agent?: string; report?: string; at: string }>;
  urgent: boolean;
  /** Who helps in its chat, when not the project's default (D-070, phase 2). */
  helper?: string;
  status: "open" | "done" | "dropped";
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  /** `owner`, or the agent that verified it. */
  closedBy?: string;
  /** The project and the title's words, case and punctuation aside: the same thing twice is one task. */
  fingerprint: string;
  /** For a question: the agent, so its answer closes it. */
  questionOf?: string;
  /** The task's own conversation (D-070, phase 2): the owner's words and the helper's answers, redacted, newest last. */
  chat?: TaskChatEntry[];
}

export interface TaskChatEntry {
  /** `owner`, or who answered: an agent's id, `<project>/<agent>`, or `pm`. */
  from: string;
  text: string;
  at: string;
}

interface Store {
  next: number;
  tasks: OwnerTask[];
}

export const TITLE_MAX = 120;
export const DETAIL_MAX = 2000;
const KEEP_CLOSED_MS = 90 * 86_400_000;
const REOPEN_WITHIN_MS = 7 * 86_400_000;
/** A task's chat keeps its last CHAT_KEEP messages, each at most CHAT_TEXT_MAX characters. */
export const CHAT_KEEP = 60;
export const CHAT_TEXT_MAX = 3500;
/** Who helps: an agent of the task's project, `<project>/<agent>` from another one, or `pm`. */
export const HELPER_PATTERN = /^(?:pm|[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})?)$/i;

export const ownerTasksFile = () => join(configRoot(), "owner-tasks.json");

/** A report's `next` item addressed to the owner: «Titolare: …», «Owner: …», in any of the six languages. */
const OWNER_WORDS = ["titolare", "responsabile", "owner", "proprietario", "inhaber", "verantwortlicher", "proprietaire", "responsable", "titular", "dono", "responsavel"];
const OWNER_PREFIX = new RegExp(`^\\s*(?:${OWNER_WORDS.join("|")})\\s*[:\\-–—]\\s*(.+)$`, "i");

/** The task an item is for the owner, or undefined. */
export function ownerItem(text: string): string | undefined {
  const plain = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const m = OWNER_PREFIX.exec(plain);
  // The original text after the prefix, with its accents.
  return m ? text.slice(text.length - m[1]!.length).trim() || undefined : undefined;
}

/** Is a handoff's target the owner? */
export const isOwnerTarget = (to: string) => OWNER_WORDS.includes(sameWords(to));

async function load(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(ownerTasksFile(), "utf8")) as Store;
    if (typeof parsed.next === "number" && Array.isArray(parsed.tasks)) return parsed;
  } catch {
    /* none yet, or damaged: start empty rather than fail */
  }
  return { next: 1, tasks: [] };
}

/** Writes are chained, so two births in one pass never share an id. */
let queue: Promise<unknown> = Promise.resolve();

function change<T>(fn: (store: Store) => T): Promise<T> {
  const run = queue.then(async () => {
    const store = await load();
    const result = fn(store);
    const cutoff = Date.now() - KEEP_CLOSED_MS;
    store.tasks = store.tasks.filter((t) => t.status === "open" || Date.parse(t.closedAt ?? t.updatedAt) > cutoff);
    await mkdir(dirname(ownerTasksFile()), { recursive: true, mode: 0o700 });
    const tmp = `${ownerTasksFile()}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 1), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, ownerTasksFile());
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function listOwnerTasks(filter: { project?: string; status?: OwnerTask["status"] } = {}): Promise<OwnerTask[]> {
  await queue;
  return (await load()).tasks.filter((t) => (!filter.project || t.project === filter.project) && (!filter.status || t.status === filter.status));
}

/** Urgent first, then oldest: what the owner sees first. */
export function ordered(tasks: readonly OwnerTask[]): OwnerTask[] {
  return [...tasks].sort((a, b) => Number(b.urgent) - Number(a.urgent) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export interface NewOwnerTask {
  project: string;
  title: string;
  detail?: string;
  source: OwnerTaskSource;
  agent?: string;
  report?: string;
  urgent?: boolean;
  questionOf?: string;
}

/**
 * Add a task, or find the one it already is (D-070): an open task with the same fingerprint gets the new source and
 * moves up; one closed in the last seven days is reopened. `created` says whether it is new.
 */
export function addOwnerTask(input: NewOwnerTask, now = new Date()): Promise<{ task: OwnerTask; created: boolean; reopened: boolean }> {
  return change((store) => {
    const title = redact(input.title).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
    const detail = redact(input.detail ?? "").trim().slice(0, DETAIL_MAX);
    const fingerprint = `${input.project}:${sameWords(title)}`;
    const at = now.toISOString();
    const source = { kind: input.source, ...(input.agent ? { agent: input.agent } : {}), ...(input.report ? { report: input.report } : {}), at };
    const open = store.tasks.find((t) => t.status === "open" && t.fingerprint === fingerprint);
    if (open) {
      open.sources = [...open.sources, source].slice(-20);
      open.updatedAt = at;
      if (input.urgent) open.urgent = true;
      if (detail && !open.detail) open.detail = detail;
      return { task: open, created: false, reopened: false };
    }
    const recent = store.tasks.find((t) => t.status !== "open" && t.fingerprint === fingerprint && now.getTime() - Date.parse(t.closedAt ?? t.updatedAt) < REOPEN_WITHIN_MS);
    if (recent) {
      recent.status = "open";
      delete recent.closedAt;
      delete recent.closedBy;
      recent.sources = [...recent.sources, source].slice(-20);
      recent.updatedAt = at;
      recent.urgent = recent.urgent || input.urgent === true;
      return { task: recent, created: false, reopened: true };
    }
    const task: OwnerTask = {
      id: `OWN-${store.next++}`,
      project: input.project,
      title,
      detail,
      sources: [source],
      urgent: input.urgent === true,
      status: "open",
      createdAt: at,
      updatedAt: at,
      fingerprint,
      ...(input.questionOf ? { questionOf: input.questionOf } : {}),
    };
    store.tasks.push(task);
    return { task, created: true, reopened: false };
  });
}

/** Close or drop a task. Returns it, or undefined when there is no open task with that id. */
export function closeOwnerTask(id: string, how: { status: "done" | "dropped"; by: string }, now = new Date()): Promise<OwnerTask | undefined> {
  return change((store) => {
    const task = store.tasks.find((t) => t.id.toUpperCase() === id.toUpperCase() && t.status === "open");
    if (!task) return undefined;
    task.status = how.status;
    task.closedAt = now.toISOString();
    task.closedBy = how.by;
    task.updatedAt = task.closedAt;
    return task;
  });
}

/** The open question tasks of an agent: closed when its question is answered or replaced. */
export function closeQuestions(project: string, agent: string, keep: string | undefined, now = new Date()): Promise<OwnerTask[]> {
  return change((store) => {
    const closed: OwnerTask[] = [];
    for (const t of store.tasks) {
      if (t.status !== "open" || t.project !== project || t.questionOf !== agent) continue;
      if (keep !== undefined && t.fingerprint === `${project}:${sameWords(keep)}`) continue;
      t.status = "done";
      t.closedAt = now.toISOString();
      t.closedBy = agent;
      t.updatedAt = t.closedAt;
      closed.push(t);
    }
    return closed;
  });
}

/** One task, whatever its status. */
export async function getOwnerTask(id: string): Promise<OwnerTask | undefined> {
  await queue;
  return (await load()).tasks.find((t) => t.id.toUpperCase() === id.toUpperCase());
}

/** A message in a task's chat, redacted before it is kept. Undefined when there is no such task. */
export function appendTaskChat(id: string, entry: { from: string; text: string }, now = new Date()): Promise<{ task: OwnerTask; entry: TaskChatEntry } | undefined> {
  return change((store) => {
    const task = store.tasks.find((t) => t.id.toUpperCase() === id.toUpperCase());
    if (!task) return undefined;
    const kept: TaskChatEntry = { from: entry.from, text: redact(entry.text).trim().slice(0, CHAT_TEXT_MAX), at: now.toISOString() };
    task.chat = [...(task.chat ?? []), kept].slice(-CHAT_KEEP);
    task.updatedAt = kept.at;
    return { task, entry: kept };
  });
}

/** Who helps in one task's chat; null goes back to the project's default. Undefined when there is no such task. */
export function setTaskHelper(id: string, helper: string | null, now = new Date()): Promise<OwnerTask | undefined> {
  if (helper !== null && !HELPER_PATTERN.test(helper)) return Promise.reject(new Error(`not a helper: ${helper}`));
  return change((store) => {
    const task = store.tasks.find((t) => t.id.toUpperCase() === id.toUpperCase());
    if (!task) return undefined;
    if (helper === null) delete task.helper;
    else task.helper = helper;
    task.updatedAt = now.toISOString();
    return task;
  });
}
