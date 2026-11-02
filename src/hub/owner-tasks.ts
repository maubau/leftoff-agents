import { randomBytes } from "node:crypto";
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
  /** Fingerprints of the tasks merged into this one: the same words again come here (D-070). */
  aliases?: string[];
  /** For a task merged into another: that one. */
  mergedInto?: string;
  /** For a question: the agent, so its answer closes it. */
  questionOf?: string;
  /** The task's own conversation (D-070, phase 2): the owner's words and the helper's answers, redacted, newest last. */
  chat?: TaskChatEntry[];
}

export interface TaskChatEntry {
  /** Stable within the task: the panel keys its lines on it. */
  id?: string;
  /** `owner`, or who answered: an agent's id, `<project>/<agent>`, or `pm`. */
  from: string;
  text: string;
  at: string;
  /** Files sent with it (D-071): their facts; the file itself is in the hub's store. */
  files?: ChatFile[];
}

export interface ChatFile {
  id: string;
  name: string;
  type: string;
  size: number;
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

/** Told of every task that changed, and of the chat line that changed it: the hub passes it on to the panel. */
type Listener = (task: OwnerTask, entry?: TaskChatEntry) => void;
const listeners = new Set<Listener>();
export function watchOwnerTasks(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
function told(tasks: readonly OwnerTask[], entry?: TaskChatEntry): void {
  for (const t of tasks) for (const fn of listeners) {
    try {
      fn(structuredClone(t), entry);
    } catch {
      /* a listener's failure is its own */
    }
  }
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

/** Words too common to tell two tasks apart, in the six languages. */
const STOP = new Set(
  `il lo la i gli le un una uno di del della dello dei degli delle a al allo alla ai agli alle in nel nello nella nei nelle con su sul sulla per tra fra e ed o od che è non si da dal dalla dai mi ti ci vi sì no come dove quando poi anche più oggi domani tuo tua tuoi tue suo sua
the a an of to in on at for and or is are be with by from it this that your you yes
der die das und oder zu im mit von für ist ein eine den dem des ja
le la les un une des de du et ou à au aux en dans pour avec sur est oui
el los las y en con por para es
o os as um uma do da dos das em no na com é sim`
    .split(/\s+/)
    .map(sameWords),
);

/** A title as its root words: common words out, each word cut to five letters (conferma, confermare → confe). */
export function titleStems(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of sameWords(title).split(" ")) {
    if (!w || STOP.has(w) || (w.length < 2 && !/^\d+$/.test(w))) continue;
    out.add(w.length > 5 ? w.slice(0, 5) : w);
  }
  return out;
}

/** How alike two titles are: shared root words over all of them (Jaccard), and over the shorter one's. */
export function titleSimilarity(a: string, b: string): { jaccard: number; containment: number; smaller: number } {
  const A = titleStems(a);
  const B = titleStems(b);
  if (!A.size || !B.size) return { jaccard: 0, containment: 0, smaller: Math.min(A.size, B.size) };
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return { jaccard: shared / (A.size + B.size - shared), containment: shared / Math.min(A.size, B.size), smaller: Math.min(A.size, B.size) };
}

/**
 * The same thing in other words: almost every root word in common. Only then is a new task folded into an open one by
 * itself; «staging key» and «production key» share most words and are two tasks, so anything less is only a hint.
 */
export const SAME_AT = 0.85;
const isSame = (a: string, b: string) => {
  const s = titleSimilarity(a, b);
  return s.smaller >= 3 && s.jaccard >= SAME_AT;
};
/** A likely duplicate, for the operational PM and the owner to merge or not. */
export const isLikely = (a: string, b: string) => {
  const s = titleSimilarity(a, b);
  return s.jaccard >= 0.4 || (s.smaller >= 3 && s.containment >= 0.75);
};

/** The open tasks of the same project that look like this one, most alike first. */
export function likelyDuplicates(task: Pick<OwnerTask, "id" | "project" | "title">, tasks: readonly OwnerTask[]): string[] {
  return tasks
    .filter((t) => t.status === "open" && t.project === task.project && t.id !== task.id && isLikely(task.title, t.title))
    .map((t) => ({ id: t.id, score: titleSimilarity(task.title, t.title).jaccard }))
    .sort((a, b) => b.score - a.score)
    .map((t) => t.id);
}

/**
 * Add a task, or find the one it already is (D-070): an open task with the same fingerprint — or one merged into it, or
 * the same thing in other words (SAME_AT) — gets the new source and moves up; one closed in the last seven days is
 * reopened, or, if it was merged, the task it went into gets it. `created` says whether it is new.
 */
export async function addOwnerTask(input: NewOwnerTask, now = new Date()): Promise<{ task: OwnerTask; created: boolean; reopened: boolean }> {
  const made = await change((store): { task: OwnerTask; created: boolean; reopened: boolean } => {
    const title = redact(input.title).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
    const detail = redact(input.detail ?? "").trim().slice(0, DETAIL_MAX);
    const fingerprint = `${input.project}:${sameWords(title)}`;
    const at = now.toISOString();
    const source = { kind: input.source, ...(input.agent ? { agent: input.agent } : {}), ...(input.report ? { report: input.report } : {}), at };
    const open =
      store.tasks.find((t) => t.status === "open" && (t.fingerprint === fingerprint || t.aliases?.includes(fingerprint))) ??
      store.tasks.find((t) => t.status === "open" && t.project === input.project && isSame(t.title, title));
    if (open) {
      open.sources = [...open.sources, source].slice(-20);
      open.updatedAt = at;
      if (input.urgent) open.urgent = true;
      if (detail && !open.detail) open.detail = detail;
      return { task: open, created: false, reopened: false };
    }
    const recent = store.tasks.find((t) => t.status !== "open" && t.fingerprint === fingerprint && now.getTime() - Date.parse(t.closedAt ?? t.updatedAt) < REOPEN_WITHIN_MS);
    // A merged task is not reopened: the one it went into gets the source, if still open.
    const into = recent?.mergedInto ? store.tasks.find((t) => t.id === recent.mergedInto && t.status === "open") : undefined;
    if (into) {
      into.sources = [...into.sources, source].slice(-20);
      into.updatedAt = at;
      if (input.urgent) into.urgent = true;
      return { task: into, created: false, reopened: false };
    }
    if (recent) {
      delete recent.mergedInto;
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
  told([made.task]);
  return made;
}

/** Close or drop a task. Returns it, or undefined when there is no open task with that id. */
export async function closeOwnerTask(id: string, how: { status: "done" | "dropped"; by: string }, now = new Date()): Promise<OwnerTask | undefined> {
  const closed = await change((store) => {
    const task = store.tasks.find((t) => t.id.toUpperCase() === id.toUpperCase() && t.status === "open");
    if (!task) return undefined;
    task.status = how.status;
    task.closedAt = now.toISOString();
    task.closedBy = how.by;
    task.updatedAt = task.closedAt;
    return task;
  });
  if (closed) told([closed]);
  return closed;
}

/** The open question tasks of an agent: closed when its question is answered or replaced. */
export async function closeQuestions(project: string, agent: string, keep: string | undefined, now = new Date()): Promise<OwnerTask[]> {
  const closed = await change((store) => {
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
  told(closed);
  return closed;
}

/** One task, whatever its status. */
export async function getOwnerTask(id: string): Promise<OwnerTask | undefined> {
  await queue;
  return (await load()).tasks.find((t) => t.id.toUpperCase() === id.toUpperCase());
}

/** A message in a task's chat, redacted before it is kept. Undefined when there is no such task. */
export async function appendTaskChat(id: string, entry: { from: string; text: string; files?: ChatFile[] }, now = new Date()): Promise<{ task: OwnerTask; entry: TaskChatEntry } | undefined> {
  const done = await change((store) => {
    const task = store.tasks.find((t) => t.id.toUpperCase() === id.toUpperCase());
    if (!task) return undefined;
    const kept: TaskChatEntry = {
      id: `c${now.getTime().toString(36)}${randomBytes(2).toString("hex")}`,
      from: entry.from,
      text: redact(entry.text).trim().slice(0, CHAT_TEXT_MAX),
      at: now.toISOString(),
      ...(entry.files?.length ? { files: entry.files.slice(0, 10).map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}),
    };
    task.chat = [...(task.chat ?? []), kept].slice(-CHAT_KEEP);
    task.updatedAt = kept.at;
    return { task, entry: kept };
  });
  if (done) told([done.task], done.entry);
  return done;
}

/** Who helps in one task's chat; null goes back to the project's default. Undefined when there is no such task. */
export async function setTaskHelper(id: string, helper: string | null, now = new Date()): Promise<OwnerTask | undefined> {
  if (helper !== null && !HELPER_PATTERN.test(helper)) throw new Error(`not a helper: ${helper}`);
  const task = await change((store) => {
    const task = store.tasks.find((t) => t.id.toUpperCase() === id.toUpperCase());
    if (!task) return undefined;
    if (helper === null) delete task.helper;
    else task.helper = helper;
    task.updatedAt = now.toISOString();
    return task;
  });
  if (task) told([task]);
  return task;
}

/** A chat line as the panel reads it (D-070): the owner's, or the helper's with who it was. */
export interface TaskChatLine {
  id: string;
  at: string;
  role: "owner" | "helper";
  agent?: string;
  text: string;
  files?: ChatFile[];
}

export function chatLine(e: TaskChatEntry): TaskChatLine {
  return { id: e.id ?? `c${Date.parse(e.at).toString(36)}`, at: e.at, role: e.from === "owner" ? "owner" : "helper", ...(e.from === "owner" ? {} : { agent: e.from }), text: e.text, ...(e.files?.length ? { files: e.files } : {}) };
}

/**
 * Merge duplicates into one task (D-070): their sources, urgency, detail and chat go to `into`, they are closed as
 * dropped with `mergedInto`, and their words become its aliases. All in one project, `into` open. Returns why not.
 */
export async function mergeOwnerTasks(ids: readonly string[], intoId: string, by: string, now = new Date()): Promise<{ into: OwnerTask; merged: OwnerTask[] } | { refused: string }> {
  const done = await change((store): { into: OwnerTask; merged: OwnerTask[] } | { refused: string } => {
    const find = (id: string) => store.tasks.find((t) => t.id.toUpperCase() === id.toUpperCase());
    const into = find(intoId);
    if (!into || into.status !== "open") return { refused: `no open task ${intoId}` };
    const merged: OwnerTask[] = [];
    for (const id of new Set(ids.map((i) => i.toUpperCase()))) {
      if (id === into.id) continue;
      const t = find(id);
      if (!t || t.status !== "open") return { refused: `no open task ${id}` };
      if (t.project !== into.project) return { refused: `${id} is in another project` };
      merged.push(t);
    }
    if (!merged.length) return { refused: "nothing to merge" };
    const at = now.toISOString();
    for (const t of merged) {
      into.sources = [...into.sources, ...t.sources].sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
      into.urgent = into.urgent || t.urgent;
      if (!into.detail && t.detail) into.detail = t.detail;
      if (t.chat?.length) into.chat = [...(into.chat ?? []), ...t.chat].sort((a, b) => a.at.localeCompare(b.at)).slice(-CHAT_KEEP);
      into.aliases = [...new Set([...(into.aliases ?? []), t.fingerprint, ...(t.aliases ?? [])])];
      t.status = "dropped";
      t.closedAt = at;
      t.closedBy = by;
      t.mergedInto = into.id;
      t.updatedAt = at;
    }
    into.updatedAt = at;
    return { into, merged };
  });
  if ("into" in done) told([...done.merged, done.into]);
  return done;
}

/** Open again a task closed by mistake. Undefined when there is no closed task with that id. */
export async function reopenOwnerTask(id: string, now = new Date()): Promise<OwnerTask | undefined> {
  const task = await change((store) => {
    const t = store.tasks.find((x) => x.id.toUpperCase() === id.toUpperCase() && x.status !== "open");
    if (!t) return undefined;
    t.status = "open";
    delete t.closedAt;
    delete t.closedBy;
    delete t.mergedInto;
    t.updatedAt = now.toISOString();
    return t;
  });
  if (task) told([task]);
  return task;
}
