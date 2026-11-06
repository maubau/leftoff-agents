// «Your tasks» (D-070): what the owner has to do, one task each. Plain rules, no DOM, so they are tested in node.

/** Open tasks of every project; the hub orders them, urgent first, then oldest (ordered() in owner-tasks.ts). */
export const TASKS_PATH = "/api/owner-tasks?status=open";

/** A task's own endpoint: `done`, `drop` or `chat`. */
export const taskPath = (id, action) => `/api/owner-tasks/${encodeURIComponent(id)}/${action}`;

/** What the hub listed, as far as it can be shown: open tasks with an id, a project and a title, in the hub's order. */
export function cleanTasks(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x.id === "string" && typeof x.project === "string" && typeof x.title === "string" && (x.status ?? "open") === "open");
}

/** One project's tasks, in the hub's order. */
export const forProject = (tasks, project) => tasks.filter((x) => x.project === project);

/** How many are open, and how many of them are urgent. */
/** How many are open; how many urgent; how many the team waits on. The header's number is red for either of the two. */
export function counts(tasks) {
  return { open: tasks.length, urgent: tasks.filter((x) => x.urgent === true).length, blocking: tasks.filter((x) => x.blocking === true).length };
}

/**
 * The Home's view: one group per project, in the order its first task comes in the hub's list — so a project with an
 * urgent task comes first, then the one waiting longest. `names` maps a project's id to its name.
 */
export function grouped(tasks, names = new Map()) {
  const groups = new Map();
  for (const task of tasks) {
    if (!groups.has(task.project)) groups.set(task.project, { project: task.project, name: names.get(task.project) ?? task.project, tasks: [] });
    groups.get(task.project).tasks.push(task);
  }
  return [...groups.values()];
}

/** Where it came from last: its newest source, or null. */
export function lastSource(task) {
  const sources = Array.isArray(task?.sources) ? task.sources.filter((s) => s && typeof s.kind === "string") : [];
  return sources.length ? sources.at(-1) : null;
}

/** The list after one changed: replaced in place while open, gone once closed, added (urgent first) when new. */
export function withTask(tasks, task, order = "oldest") {
  if (!task || typeof task.id !== "string") return tasks;
  const rest = tasks.filter((x) => x.id !== task.id);
  if ((task.status ?? "open") !== "open") return rest;
  return sortTasks([...rest, task], order);
}

// ---------- the order (D-070): urgent always first, then the newest, the oldest, or by project ----------

export const TASK_ORDERS = ["newest", "oldest", "project"];
/** The order the owner chose, kept in this browser. */
export const ORDER_KEY = "leftoff_tasks_order";
export const readOrder = (raw) => (TASK_ORDERS.includes(raw) ? raw : "newest");
export const tasksPath = (order) => `${TASKS_PATH}&sort=${encodeURIComponent(order)}`;

/**
 * The hub's order (ordered() in owner-tasks.ts): what blocks the team, then urgent, then the order chosen. Kept here too so a live change lands where it belongs and a hub that
 * does not sort yet still shows the chosen order. Age is when the task was made; an unreadable date is the oldest.
 */
export function sortTasks(tasks, order = "newest") {
  const at = (t) => Date.parse(t.createdAt ?? "") || 0;
  const num = (t) => Number(String(t.id).slice(4)) || 0;
  const age = (a, b) => at(a) - at(b) || num(a) - num(b);
  return [...tasks].sort(
    (a, b) =>
      Number(b.blocking === true) - Number(a.blocking === true) ||
      Number(b.urgent === true) - Number(a.urgent === true) ||
      (order === "project" ? String(a.project).localeCompare(String(b.project)) : 0) ||
      (order === "oldest" ? age(a, b) : age(b, a)),
  );
}

/**
 * «By project»: what blocks the team first, then the urgent ones, each kind together (each task still says its project),
 * then one group per project. Each group: `{ blocking: true }`, `{ urgent: true }` or `{ project }`, its tasks in order.
 */
export function orderGroups(tasks) {
  const groups = [];
  for (const task of tasks) {
    const kind = task.blocking === true ? "blocking" : task.urgent === true ? "urgent" : null;
    const key = kind ? `!${kind}` : task.project;
    const last = groups.at(-1);
    if (last && last.key === key) last.tasks.push(task);
    else groups.push({ key, ...(kind ? { [kind]: true } : { project: task.project }), tasks: [task] });
  }
  return groups;
}

// ---------- the tasks page (D-070, redone 2026-11-02) ----------

/** Where the tasks page is: `#/tasks`, `#/tasks/OWN-7`, either with `?project=<id>` to show one project's. */
export function tasksRoute(hash) {
  const m = /^#\/tasks(?:\/(OWN-\d{1,9}))?(?:\?project=([^&]+))?$/i.exec(hash ?? "");
  if (!m) return null;
  let project = null;
  try {
    project = m[2] ? decodeURIComponent(m[2]) : null;
  } catch {
    project = null;
  }
  return { task: m[1] ? m[1].toUpperCase() : null, project };
}

export const tasksHash = ({ task = null, project = null } = {}) => `#/tasks${task ? `/${encodeURIComponent(task)}` : ""}${project ? `?project=${encodeURIComponent(project)}` : ""}`;

/** The list on the page: one project's, or all, in the hub's order (urgent first, then oldest). */
export const filtered = (tasks, project) => (project ? tasks.filter((x) => x.project === project) : tasks);

/** The Home's and a project's summary: the first `n` (the hub already put the urgent and oldest first). */
export const firstOnes = (tasks, n = 3) => tasks.slice(0, n);

/**
 * What whoever helps is doing (task.helperState): working on an answer, or the owner waits for one. Idle, unknown, or a
 * state with no name to say it with: nothing to show.
 */
export function helperStatus(task) {
  const state = task?.helperState?.state;
  const name = task?.helperNow?.name;
  if (!name || (state !== "working" && state !== "waiting")) return null;
  return { state, name, since: task.helperState.since ?? null };
}

/** Images, and a long text pasted as Markdown (below), no bigger than Telegram can carry (D-071): 20 MB. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const FILE_TYPES = [...IMAGE_TYPES, "text/markdown"];
export const FILE_MAX = 20 * 1024 * 1024;
export function fileProblem(file) {
  if (!file || typeof file.size !== "number") return "type";
  if (!FILE_TYPES.includes(file.type)) return "type";
  if (file.size > FILE_MAX) return "size";
  if (file.size === 0) return "empty";
  return null;
}

/** A file's name as the hub stores it: letters, digits, dots and dashes; never a path. */
export function safeName(name, type = "") {
  const base = String(name ?? "").split(/[\\/]/).at(-1).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 80);
  if (base) return base;
  return `image.${({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" })[type] ?? "bin"}`;
}

export const uploadPath = (id, name) => `/api/owner-tasks/${encodeURIComponent(id)}/files?name=${encodeURIComponent(name)}`;
export const fileUrl = (project, fileId) => `/api/files/${encodeURIComponent(project)}/${encodeURIComponent(fileId)}`;

/** A chat line's files, as far as they can be shown. */
export function filesOf(entry) {
  return (Array.isArray(entry?.files) ? entry.files : []).filter((f) => f && typeof f.id === "string" && typeof f.name === "string");
}

export const isImage = (file) => IMAGE_TYPES.includes(file?.type);

/** «1.4 MB», «820 KB». */
export function sizeText(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Near the bottom of a scrolled list, within a line or so: then a new line keeps it at the bottom, otherwise not. */
export const atBottom = (el, slack = 40) => !el || el.scrollHeight - el.scrollTop - el.clientHeight <= slack;

// ---------- closed tasks, and duplicates (D-070) ----------

/** The closed ones, newest first: what «Reopen» can bring back. */
export function closedTasks(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.id === "string" && typeof x.project === "string" && typeof x.title === "string" && (x.status === "done" || x.status === "dropped"))
    .sort((a, b) => String(b.closedAt ?? b.updatedAt ?? "").localeCompare(String(a.closedAt ?? a.updatedAt ?? "")));
}

/** The open tasks the hub thinks are the same thing as this one (`similar`), as far as they are still open. */
export function similarTasks(task, open) {
  const ids = Array.isArray(task?.similar) ? task.similar.filter((id) => typeof id === "string") : [];
  return ids.map((id) => open.find((x) => x.id === id)).filter((x) => x && x.id !== task.id);
}

/** Where a task can be merged: its likely duplicates first, then the project's other open tasks. */
export function mergeTargets(task, open) {
  const similar = similarTasks(task, open);
  const others = open.filter((x) => x.project === task.project && x.id !== task.id && !similar.includes(x));
  return { similar, others };
}

// ---------- long text (D-071) ----------

/** A chat line holds this much; past it, the hub keeps the text whole as a Markdown file of the task, with a preview. */
export const CHAT_TEXT_MAX = 3500;
/** The most a task's chat takes in one message: beyond, the hub refuses it (400). */
export const TASK_TEXT_MAX = 80000;

/** What the box says under it: nothing, «it will become an attachment», or «that is the most it takes». */
export function textLength(length) {
  if (!Number.isFinite(length) || length <= CHAT_TEXT_MAX) return null;
  return length >= TASK_TEXT_MAX ? "max" : "file";
}

// ---------- a long text pasted (OWN-126) ----------

/**
 * What a paste into a task's chat becomes. Up to a chat line's length it goes into the box as text. Longer, it never
 * enters the box (a box cut at its limit loses the rest without a word): it becomes a Markdown file of its own, sent
 * like an image. Over 20 MB in UTF-8 bytes it is refused whole, and nothing is pasted half.
 */
export function pasteKind(text) {
  if (typeof text !== "string" || text.length <= CHAT_TEXT_MAX) return "box";
  return utf8Bytes(text) > FILE_MAX ? "too-big" : "file";
}

/** Bytes as the file will have them: what the 20 MB limit counts. */
export const utf8Bytes = (text) => new TextEncoder().encode(String(text ?? "")).length;

/** «incollato-20261106-2203.md»: the prefix in the owner's language, the local date and time of the paste. */
export function pastedName(date = new Date(), prefix = "incollato") {
  const two = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
  const safe = String(prefix).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "pasted";
  return `${safe}-${stamp}.md`;
}

/** The chip's preview: the first lines with something in them, each cut to a readable length. */
export function previewLines(text, lines = 3, width = 90) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, lines)
    .map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
}

/** «12.4 MB», for the refusal; one decimal, the owner's own separator added by the caller if wanted. */
export const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// ---------- where the owner's words went (D-070, #138) ----------

/** After this long with no answer, the owner is offered «Ask again» and «Pass it to someone else». */
export const NUDGE_AFTER = 3 * 60 * 1000;
/** While an answer is awaited, the task and its chat are asked for this often, so «working» shows at once. */
export const POLL_WAITING = 5000;

/** The owner's last words still without an answer: no helper's line after them (Leftoff's own notes answer nothing). */
export function awaiting(entries) {
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;
    if (e.role === "owner") return e;
    if (e.agent !== "leftoff") return null;
  }
  return null;
}

/** A line again (its delivery changed): replaced where it is; a new one goes at the end. */
export function withLine(entries, entry) {
  if (!entry || typeof entry.id !== "string") return entries;
  const at = entries.findIndex((e) => e.id === entry.id);
  return at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? { ...e, ...entry } : e));
}

/**
 * What the line under the owner's words says. For words already answered, where they went. For the words awaiting an
 * answer: sent, delivered / queued / the PM answers, then «working» when the helper is on it, and «late» once
 * NUDGE_AFTER has passed since they went (or since the last «ask again») with no answer.
 */
export function lineState(line, task, { now = Date.now(), waiting = false } = {}) {
  const d = line?.delivery;
  const to = d?.to ?? task?.helperNow?.id ?? null;
  const base = d && ["delivered", "queued", "pm"].includes(d.state) ? { kind: d.state, to } : { kind: "sent", to };
  if (!waiting) return base;
  if (task?.helperState?.state === "working") return { kind: "working", to: task.helperNow?.id ?? to };
  const since = Date.parse(d?.nudgedAt ?? d?.at ?? line?.at ?? "") || now;
  if (now - since >= NUDGE_AFTER) return { kind: "late", to, nudged: Boolean(d?.nudgedAt) };
  return base;
}
