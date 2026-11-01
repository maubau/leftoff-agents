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
