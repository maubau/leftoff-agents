import { createTask, removeCreatedTasks, type NewTask } from "../core/backlog.ts";
import { recordDecision } from "../core/decisions.ts";
import type { Project } from "../core/project.ts";
import { redact } from "../hub/redact.ts";
import { messages, type Lang } from "../i18n/index.ts";
import type { ToolOutcome } from "./provider.ts";

/** A batch is a plan for one request, not a dump: past this the PM should ask what matters. */
export const MAX_TASKS_PER_CALL = 12;

export interface CreateTasksInput {
  project: string;
  /** One sentence, in the owner's language, of the request these tasks answer. */
  summary: string;
  tasks: Array<{ title: string; description: string; acceptance_criteria: string[]; priority: string; labels: string[] }>;
}

function find(projects: readonly Project[], wanted: string): Project | undefined {
  const w = wanted.trim().toLowerCase();
  return (
    projects.find((p) => p.id === w || p.config.name.toLowerCase() === w) ??
    projects.find((p) => p.id.includes(w) || p.config.name.toLowerCase().includes(w))
  );
}

const unknownProject = (projects: readonly Project[], wanted: string): ToolOutcome => ({
  content: `No project "${wanted}". Known: ${projects.map((p) => p.id).join(", ") || "(none)"}`,
  isError: true,
});

const clean = (text: string, max: number) => redact(text.replace(/\s+/g, " ").trim()).slice(0, max);

/**
 * The owner described something loosely; the PM turned it into tasks. They go straight into the
 * project's To Do list — the owner's request is the approval, and nothing here touches an agent —
 * and are logged in decisions.md so "why is this task here?" has an answer later.
 */
export async function createTasksAction(
  projects: readonly Project[],
  input: CreateTasksInput,
  options: { language: Lang; now?: Date },
): Promise<ToolOutcome> {
  const project = find(projects, input.project);
  if (!project) return unknownProject(projects, input.project);
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) return { content: "No tasks given.", isError: true };
  if (input.tasks.length > MAX_TASKS_PER_CALL) {
    return { content: `Too many tasks at once (${input.tasks.length}; at most ${MAX_TASKS_PER_CALL}). Group the work into fewer tasks, or ask the owner which parts matter first.`, isError: true };
  }
  const now = options.now ?? new Date();
  const drafts: NewTask[] = [];
  for (const t of input.tasks) {
    const title = clean(String(t.title ?? ""), 120);
    const description = redact(String(t.description ?? "").trim()).slice(0, 2500);
    if (!title || !description) return { content: "Every task needs a title and a description; nothing was created.", isError: true };
    drafts.push({
      title,
      description,
      acceptanceCriteria: (t.acceptance_criteria ?? []).map((c) => clean(String(c), 300)).filter(Boolean).slice(0, 8),
      labels: (t.labels ?? []).map((l) => clean(String(l), 30)).filter(Boolean).slice(0, 5),
      priority: t.priority === "high" || t.priority === "low" ? t.priority : "medium",
    });
  }
  // Validated whole, then written: a bad entry never leaves half a plan behind.
  const created = [];
  for (const draft of drafts) created.push(await createTask(project, draft, now));
  const t = messages(options.language).tasks;
  await recordDecision(project, {
    at: now.toISOString(),
    by: "pm",
    text: `${t.addedDecision}: ${created.map((c) => `${c.id} ${c.title}`).join("; ")}`,
    why: `${t.requestWhy}: ${clean(input.summary, 300)}`,
  }).catch(() => undefined);
  return {
    content:
      `Created ${created.length} task(s) in ${project.config.name}, status To Do:\n` +
      created.map((c) => `- ${c.id}: ${c.title}`).join("\n") +
      "\nThey are on the project's board now. Tell the owner briefly what you added (the titles), and that you can take them back if they ask. Do not claim an agent has been told: nothing was sent to any agent.",
  };
}

/** Undo: only tasks this PM created, by id. */
export async function removeTasksAction(projects: readonly Project[], input: { project: string; ids: string[] }): Promise<ToolOutcome> {
  const project = find(projects, input.project);
  if (!project) return unknownProject(projects, input.project);
  const { removed, refused } = await removeCreatedTasks(project, input.ids ?? []);
  if (removed.length === 0) return { content: `Nothing removed: ${refused.join(", ") || "no ids given"} are not tasks the PM created in ${project.config.name}.`, isError: true };
  return {
    content: `Removed ${removed.join(", ")}.${refused.length ? ` Not removed (not created by the PM, or already gone): ${refused.join(", ")}.` : ""}`,
  };
}
