import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import type { Project } from "./project.ts";

export interface Task {
  id: string;
  title: string;
  status: string;
  assignee: string[];
  labels: string[];
  file: string;
}

interface TaskFrontmatter {
  id?: string;
  title?: string;
  status?: string;
  assignee?: string | string[];
  labels?: string | string[];
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

const DONE = /^(done|completed|closed)$/i;
const DOING = /^(in[ _-]?progress|doing|wip)$/i;

export function isDone(task: Task): boolean {
  return DONE.test(task.status);
}
export function isInProgress(task: Task): boolean {
  return DOING.test(task.status);
}
export function isTodo(task: Task): boolean {
  return !isDone(task) && !isInProgress(task);
}

/**
 * Read Backlog.md tasks straight off disk rather than through its CLI: reading
 * is the only thing M0 needs, and it keeps Leftoff working when the CLI is absent.
 */
export async function readTasks(project: Project): Promise<Task[]> {
  const dir = join(project.paths.backlog, "tasks");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md"));
  const tasks: Task[] = [];
  for (const file of files.sort()) {
    const raw = await readFile(join(dir, file), "utf8").catch(() => null);
    if (raw === null) continue;
    const { data } = parseFrontmatter<TaskFrontmatter>(raw);
    const title = data.title ?? file.replace(/\.md$/, "").replace(/^task-\d+\s*-\s*/, "");
    tasks.push({
      id: String(data.id ?? file.replace(/\.md$/, "")),
      title,
      status: String(data.status ?? "To Do"),
      assignee: toArray(data.assignee),
      labels: toArray(data.labels),
      file: join("backlog", "tasks", file),
    });
  }
  return tasks;
}

export async function hasBacklog(project: Project): Promise<boolean> {
  return (await readdir(project.paths.backlog).catch(() => null)) !== null;
}

/**
 * Writing tasks. The files follow Backlog.md's own layout (`<prefix>-<n> - <Title>.md`, frontmatter,
 * Description and Acceptance Criteria sections), so the project can start using its CLI or web board
 * at any time and find them already there.
 */
export interface NewTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  labels: string[];
  priority: "high" | "medium" | "low";
}

const TASK_FILE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)\b/;

/** `task_prefix` from backlog/config.yml, else whatever the existing tasks use, else "task". */
async function prefixOf(project: Project, files: readonly string[]): Promise<string> {
  const raw = await readFile(join(project.paths.backlog, "config.yml"), "utf8").catch(() => "");
  try {
    const configured = (parseYaml(raw) as { task_prefix?: unknown } | null)?.task_prefix;
    if (typeof configured === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(configured)) return configured.toLowerCase();
  } catch {
    /* an unreadable config is not a reason to refuse a task */
  }
  for (const f of files) {
    const m = TASK_FILE.exec(f);
    if (m) return m[1]!.toLowerCase();
  }
  return "task";
}

const slugTitle = (title: string) =>
  title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/, "") || "task";

const ledger = (project: Project) => join(project.paths.root, "pm-tasks.jsonl");

/** Create one task in `To Do`. Ids continue the project's numbering, whoever made the earlier ones. */
export async function createTask(project: Project, input: NewTask, now = new Date()): Promise<Task> {
  const dir = join(project.paths.backlog, "tasks");
  await mkdir(dir, { recursive: true });
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md"));
  const prefix = await prefixOf(project, files);
  const next = files.reduce((max, f) => {
    const m = TASK_FILE.exec(f);
    return m && m[1]!.toLowerCase() === prefix ? Math.max(max, Number(m[2])) : max;
  }, 0) + 1;
  const id = `${prefix.toUpperCase()}-${next}`;
  const file = `${prefix}-${next} - ${slugTitle(input.title)}.md`;

  const created = now.toISOString().slice(0, 16).replace("T", " ");
  const data = { id, title: input.title, status: "To Do", assignee: [], created_date: created, labels: input.labels, dependencies: [], priority: input.priority };
  const criteria = input.acceptanceCriteria.map((c, i) => `- [ ] #${i + 1} ${c}`).join("\n");
  const body = [
    "## Description",
    "",
    "<!-- SECTION:DESCRIPTION:BEGIN -->",
    input.description.trim(),
    "<!-- SECTION:DESCRIPTION:END -->",
    ...(criteria ? ["", "## Acceptance Criteria", "<!-- AC:BEGIN -->", criteria, "<!-- AC:END -->"] : []),
  ].join("\n");
  await writeFile(join(dir, file), stringifyFrontmatter(data, body), "utf8");
  await mkdir(project.paths.root, { recursive: true });
  await appendFile(ledger(project), `${JSON.stringify({ id, file: join("backlog", "tasks", file), at: now.toISOString() })}\n`, "utf8");
  return { id, title: input.title, status: "To Do", assignee: [], labels: input.labels, file: join("backlog", "tasks", file) };
}

/**
 * Take back tasks the PM created — only those: the ledger is what makes this safe, so a task
 * the owner or an agent wrote can never be deleted by a misheard "annulla".
 */
export async function removeCreatedTasks(project: Project, ids: readonly string[]): Promise<{ removed: string[]; refused: string[] }> {
  const raw = await readFile(ledger(project), "utf8").catch(() => "");
  const mine = new Map<string, string>();
  for (const line of raw.split("\n")) {
    try {
      const entry = JSON.parse(line) as { id: string; file: string };
      mine.set(entry.id.toUpperCase(), entry.file);
    } catch {
      /* skip */
    }
  }
  const removed: string[] = [];
  const refused: string[] = [];
  // The ledger lives inside the repository, so an agent can write it: its paths are untrusted
  // text. Only a Markdown file directly inside backlog/tasks/ may ever be deleted from it.
  const tasksDir = resolve(project.root, "backlog", "tasks");
  const deletable = (file: string | undefined): string | undefined => {
    if (!file) return undefined;
    const target = resolve(project.root, file);
    return dirname(target) === tasksDir && target.endsWith(".md") ? target : undefined;
  };
  for (const id of ids) {
    const target = deletable(mine.get(id.trim().toUpperCase()));
    if (target && (await rm(target).then(() => true, () => false))) removed.push(id.toUpperCase());
    else refused.push(id);
  }
  return { removed, refused };
}
