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
export function counts(tasks) {
  return { open: tasks.length, urgent: tasks.filter((x) => x.urgent === true).length };
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
export function withTask(tasks, task) {
  if (!task || typeof task.id !== "string") return tasks;
  const rest = tasks.filter((x) => x.id !== task.id);
  if ((task.status ?? "open") !== "open") return rest;
  return [...rest, task].sort(
    (a, b) => Number(b.urgent === true) - Number(a.urgent === true) || Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""),
  );
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

/** Images only, for now, and no bigger than Telegram can carry (D-071): 20 MB. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const FILE_MAX = 20 * 1024 * 1024;
export function fileProblem(file) {
  if (!file || typeof file.size !== "number") return "type";
  if (!IMAGE_TYPES.includes(file.type)) return "type";
  if (file.size > FILE_MAX) return "size";
  if (file.size === 0) return "empty";
  return null;
}

/** A file's name as the hub stores it: letters, digits, dots and dashes; never a path. */
export function safeName(name, type = "") {
  const base = String(name ?? "").split(/[\\/]/).at(-1).normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 80);
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
