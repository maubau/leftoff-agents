import { agentForWorkspace, ensureAgent, paseoSessions, paseoWorkspaces } from "../core/agents.ts";
import { saveProject, type Project } from "../core/project.ts";
import { resolve } from "node:path";

/** Paseo providers that are Claude Code or Codex, by the provider's own name ("claude-work" extends "claude"). */
function hostOf(provider: string): "claude-code" | "codex" | undefined {
  if (provider.startsWith("codex")) return "codex";
  if (provider.startsWith("claude")) return "claude-code";
  return undefined;
}

/**
 * The agents Paseo already runs in this project's workspaces, registered without waiting for their
 * first report: an agent that has not reported yet still exists, and the owner should see it, ask
 * it for an update and instruct it. Only *missing* agents are added — an existing one keeps its link,
 * which reports maintain — and a closed session is not an agent worth listing.
 * Returns true when project.yaml changed.
 */
export async function discoverAgents(project: Project, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const workspaces = (await paseoWorkspaces(env)).filter((w) => w.repoRoot === resolve(project.root));
  if (workspaces.length === 0) return false;
  const sessions = await paseoSessions(env);
  let changed = false;

  for (const workspace of workspaces) {
    const here = sessions.filter((s) => s.status !== "closed" && (s.workspaceId ? s.workspaceId === workspace.workspaceId : s.cwd === workspace.cwd));
    for (const host of ["claude-code", "codex"] as const) {
      const ofHost = here.filter((s) => hostOf(s.provider) === host);
      if (ofHost.length === 0) continue;
      // Already an agent for this workspace and program: reports keep it up to date.
      if (project.config.agents.some((a) => a.workspace === workspace.cwd && a.host === host)) continue;
      // Several sessions in one workspace: the one working now, else the most recently active.
      const [session] = [...ofHost].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      if (!session) continue;
      const agent = agentForWorkspace(project, host, workspace);
      if (ensureAgent(project, agent.id, host, session.id, { workspace: workspace.cwd, label: workspace.title })) changed = true;
    }
  }
  if (retireSuperseded(project)) changed = true;
  if (changed) await saveProject(project.root, project.config);
  return changed;
}

/**
 * An older host-level agent (no workspace, no live session) whose program now has workspace agents is
 * history: its last report describes a state some workspace agent has since moved on from. It is retired,
 * not deleted — its reports stay — and un-retired the moment it reports again.
 */
export function retireSuperseded(project: Project): boolean {
  const agents = project.config.agents;
  let changed = false;
  for (const legacy of agents) {
    if (legacy.workspace || legacy.paseoAgent || legacy.retired) continue;
    if (agents.some((a) => a.workspace && a.host === legacy.host)) {
      legacy.retired = true;
      changed = true;
    }
  }
  return changed;
}
