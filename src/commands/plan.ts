import { createTask, readTasks, updateTask, type Task } from "../core/backlog.ts";
import { UserError } from "../core/errors.ts";
import { PLAN_STATUSES, PROPOSED, phasesOf, planLabel, planTasks, type Plan } from "../core/plan.ts";
import type { Project } from "../core/project.ts";
import { loadState } from "../hub/state.ts";
import { redact } from "../hub/redact.ts";

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const CRITERIA_MAX = 8;
const TASKS_PER_AGENT = 15;
const TASK_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** The plan this project is collecting, as the hub recorded it; an agent cannot open one by itself. */
async function activePlan(project: Project, planId: string): Promise<Plan> {
  const plan = (await loadState())?.plans?.[project.id];
  if (!plan || plan.id !== planId || plan.status === "approved" || plan.status === "dropped") {
    throw new UserError(`No plan "${planId}" is being prepared for ${project.id}`, "Use the plan id from the project manager's request.");
  }
  return plan;
}

function agentOf(project: Project, id: string) {
  const agent = project.config.agents.find((a) => a.id === id && !a.retired);
  if (!agent) throw new UserError(`No agent "${id}" in ${project.id}`, `Known: ${project.config.agents.filter((a) => !a.retired).map((a) => a.id).join(", ")}.`);
  return agent;
}

const clean = (text: string, max: number) => redact(text).replace(/\s+/g, " ").trim().slice(0, max);

/** An agent's part of the plan: one task, in a phase, with what it waits on and how to know it is done. */
export async function addPlanTask(
  project: Project,
  input: { agent: string; plan: string; phase: string; title: string; description?: string; criteria: string[]; depends: string[]; priority?: string },
): Promise<Task> {
  const plan = await activePlan(project, input.plan);
  agentOf(project, input.agent);
  const title = clean(input.title, TITLE_MAX);
  const phase = clean(input.phase, 60);
  if (!title) throw new UserError("--title is empty");
  if (!phase) throw new UserError("--phase is empty", 'Name the phase, e.g. --phase "1 · Design".');
  const depends = input.depends.flatMap((d) => d.split(",")).map((d) => d.trim()).filter(Boolean);
  const bad = depends.filter((d) => !TASK_ID.test(d));
  if (bad.length) throw new UserError(`Not a task id: ${bad.join(", ")}`, "Dependencies are task ids, e.g. --depends TASK-12 (see `leftoff plan show`).");
  const mine = (await planTasks(project, plan.id)).filter((t) => t.assignee.includes(input.agent));
  if (mine.length >= TASKS_PER_AGENT) throw new UserError(`You already have ${mine.length} tasks in this plan`, "Keep your part to the main steps; the details belong in each task's description.");
  const priority = input.priority === "high" || input.priority === "low" ? input.priority : "medium";
  return createTask(
    project,
    {
      title,
      description: redact(input.description ?? "").trim().slice(0, DESCRIPTION_MAX),
      acceptanceCriteria: input.criteria.map((c) => clean(c, 200)).filter(Boolean).slice(0, CRITERIA_MAX),
      labels: [planLabel(plan.id), PROPOSED],
      priority,
      assignee: [input.agent],
      dependencies: depends,
      milestone: phase,
    },
    new Date(),
    { ledger: false },
  );
}

/** A task moves on the board as the agent works on it: To Do, In Progress, Done. */
export async function setTaskStatus(project: Project, input: { agent: string; task: string; status: string }): Promise<Task> {
  agentOf(project, input.agent);
  const status = PLAN_STATUSES.find((s) => s.toLowerCase().replace(/\s/g, "") === input.status.toLowerCase().replace(/[\s_-]/g, ""));
  if (!status) throw new UserError(`Unknown status "${input.status}"`, `Use one of: ${PLAN_STATUSES.join(", ")}.`);
  const task = await updateTask(project, input.task, { status });
  if (!task) throw new UserError(`No task ${input.task} in ${project.id}`);
  return task;
}

/** The plan as it stands, phase by phase: for agents to see their teammates' tasks and point at them. */
export async function showPlan(project: Project): Promise<string> {
  const plan = (await loadState())?.plans?.[project.id];
  const tasks = plan ? await planTasks(project, plan.id) : (await readTasks(project)).filter((t) => t.labels.some((l) => l.startsWith("plan:")));
  if (tasks.length === 0) return plan ? `Plan ${plan.id} (${plan.status}): «${plan.goal}» — no tasks yet.` : "No plan in this project.";
  const lines = plan ? [`Plan ${plan.id} (${plan.status}): «${plan.goal}»`] : [];
  for (const phase of phasesOf(tasks)) {
    lines.push(`${phase.name}`);
    for (const t of phase.tasks) {
      const deps = t.dependencies.length ? ` ← ${t.dependencies.join(", ")}` : "";
      const proposed = t.labels.includes(PROPOSED) ? " (proposed)" : "";
      lines.push(`  ${t.id} [${t.status}] ${t.assignee.join(", ") || "—"}: ${t.title}${deps}${proposed}`);
    }
  }
  return lines.join("\n");
}
