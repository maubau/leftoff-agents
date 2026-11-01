import { displayName } from "../core/agents.ts";
import type { Config } from "../core/config.ts";
import type { Project } from "../core/project.ts";
import { opsTarget } from "./operational.ts";
import type { OwnerTask } from "./owner-tasks.ts";

/**
 * Who helps in a task's chat (D-070, phase 2). The task's own `helper`, else the project's (`pm.tasks.helpers`), else
 * the operational PM (D-064), else the PM. A choice that no longer holds — an agent retired, a project gone or made
 * private — falls through to the next, so a task's chat always has someone answering.
 */

export type TaskHelper =
  | { kind: "agent"; project: Project; agentId: string; name: string; id: string; why: HelperWhy }
  | { kind: "pm"; name: string; id: "pm"; why: HelperWhy };

/** Where the choice came from: the task, the project's setting, or the default. */
export type HelperWhy = "task" | "project" | "default";

/** An agent named by `<agent>` (in the task's project) or `<project>/<agent>`, when it is still one the chat may know. */
export function agentHelper(value: string, home: string, projects: readonly Project[]): { project: Project; agentId: string } | null {
  const [projectId, agentId] = value.includes("/") ? (value.split("/", 2) as [string, string]) : [home, value];
  const project = projects.find((p) => p.id === projectId);
  if (!project || project.config.visibility === "private") return null;
  const agent = project.config.agents.find((a) => a.id === agentId && !a.retired);
  return agent ? { project, agentId: agent.id } : null;
}

function named(value: string | undefined, home: string, projects: readonly Project[], pmName: string, why: HelperWhy): TaskHelper | null {
  if (!value) return null;
  if (value === "pm") return { kind: "pm", name: pmName, id: "pm", why };
  const found = agentHelper(value, home, projects);
  if (!found) return null;
  const id = found.project.id === home ? found.agentId : `${found.project.id}/${found.agentId}`;
  return { kind: "agent", ...found, name: displayName(found.project, found.agentId), id, why };
}

/** The project's helper when the task names none: its setting, else the operational PM, else the PM. */
export function projectHelper(config: Config, projectId: string, projects: readonly Project[], pmName: string): TaskHelper {
  const set = named(config.pm.tasks.helpers[projectId], projectId, projects, pmName, "project");
  if (set) return set;
  const ops = opsTarget(config, projects);
  if (ops) return { kind: "agent", project: ops.project, agentId: ops.agentId, name: displayName(ops.project, ops.agentId), id: ops.project.id === projectId ? ops.agentId : `${ops.project.id}/${ops.agentId}`, why: "default" };
  return { kind: "pm", name: pmName, id: "pm", why: "default" };
}

export function resolveHelper(config: Config, task: Pick<OwnerTask, "project" | "helper">, projects: readonly Project[], pmName: string): TaskHelper {
  return named(task.helper, task.project, projects, pmName, "task") ?? projectHelper(config, task.project, projects, pmName);
}

/** Whom the owner can choose for a project's tasks: the PM, its own agents, then the operational PM if it is elsewhere. */
export function helperCandidates(config: Config, projectId: string, projects: readonly Project[], pmName: string): Array<{ id: string; name: string }> {
  const project = projects.find((p) => p.id === projectId);
  const own = (project?.config.agents ?? []).filter((a) => !a.retired).map((a) => ({ id: a.id, name: displayName(project!, a.id) }));
  const ops = opsTarget(config, projects);
  const away = ops && ops.project.id !== projectId ? [{ id: `${ops.project.id}/${ops.agentId}`, name: `${displayName(ops.project, ops.agentId)} · ${ops.project.config.name}` }] : [];
  return [{ id: "pm", name: pmName }, ...own, ...away];
}
