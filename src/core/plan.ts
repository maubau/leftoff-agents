import { readTasks, type Task } from "./backlog.ts";
import type { Project } from "./project.ts";

/**
 * A macro plan (D-051): before development starts, the PM asks each agent of the team for its plan, the
 * agents write it as backlog tasks (a phase, dependencies, criteria), the PM consolidates them, and the owner
 * approves once. The record of a plan lives in the hub's state, on the owner's machine; its tasks live in the
 * project's backlog, where the board and the panel already read them — nothing is kept twice.
 */
export interface Plan {
  id: string;
  projectId: string;
  /** What the owner wants, in their words: what each agent plans for. */
  goal: string;
  askedAt: string;
  /** The agents asked for their part. */
  agents: string[];
  /** collecting → (every plan in, or the wait is over) → shown to the owner → approved; or dropped. */
  status: "collecting" | "shown" | "approved" | "dropped";
  /** The owner was told the plans are in (or that some are missing). */
  noticedAt?: string;
  /** Shown for approval in this thread, approvable until expiresAt. */
  threadKey?: string;
  shownAt?: string;
  expiresAt?: string;
  approvedAt?: string;
  /** The PM's summary of the consolidated plan, as shown to the owner. */
  summary?: string;
}

export const PLAN_STATUSES = ["To Do", "In Progress", "Done"] as const;
export const planLabel = (id: string) => `plan:${id}`;
/** A task an agent proposed and the owner has not approved yet. */
export const PROPOSED = "proposed";
/** A task Leftoff opened for an instruction that had none, so nothing starts without showing on the board. */
export const AUTO = "auto";

export function newPlanId(now = new Date()): string {
  return `${now.toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function planTasks(project: Project, planId: string): Promise<Task[]> {
  return (await readTasks(project)).filter((t) => t.labels.includes(planLabel(planId)));
}

export interface Phase {
  name: string;
  tasks: Task[];
}

/** Phases in order: a leading number orders them ("1 · Design", "2 · Build"), else the order they first appear in. */
export function phasesOf(tasks: readonly Task[]): Phase[] {
  const phases = new Map<string, Task[]>();
  for (const t of tasks) {
    const name = t.milestone ?? "—";
    phases.set(name, [...(phases.get(name) ?? []), t]);
  }
  const lead = (name: string) => Number(/^\s*(\d+)/.exec(name)?.[1] ?? Number.POSITIVE_INFINITY);
  const first = [...phases.keys()];
  return [...phases.entries()]
    .sort(([a], [b]) => lead(a) - lead(b) || first.indexOf(a) - first.indexOf(b))
    .map(([name, list]) => ({ name, tasks: list }));
}

/** Who was asked and has written nothing yet. */
export function missing(plan: Plan, tasks: readonly Task[]): string[] {
  return plan.agents.filter((a) => !tasks.some((t) => t.assignee.includes(a)));
}
