import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HostId } from "../hosts/types.ts";
import { slugify, type Agent, type Project } from "./project.ts";

/**
 * Which host is running us, from the environment it gives its tool subprocesses.
 * Agents rarely pass `--host`, and should not have to.
 */
export function detectHost(env: NodeJS.ProcessEnv = process.env): HostId | "other" {
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED || env.CODEX_THREAD_ID) return "codex";
  return "other";
}

/** Default agent id per host, used when project.yaml does not name one. */
const DEFAULT_ID: Record<HostId | "other", string> = {
  "claude-code": "claude",
  codex: "codex",
  other: "agent",
};

/** Paseo's own record of a workspace: the name the owner gave it and where it lives. */
export interface PaseoWorkspace {
  cwd: string;
  title: string;
  workspaceId?: string;
  /** The repository this workspace is a worktree of (or its own directory, for a local checkout). */
  repoRoot?: string;
}

/** One Paseo session, as Paseo itself records it. */
export interface PaseoSession {
  id: string;
  cwd: string;
  provider: string;
  workspaceId?: string;
  status?: string;
  updatedAt?: string;
}

const paseoHome = (env: NodeJS.ProcessEnv) => env.PASEO_HOME || join(homedir(), ".paseo");

/**
 * Every live workspace in Paseo's registry. Absent, unreadable or archived entries are simply not
 * workspaces: Paseo's files are not ours, and a callers falls back to the host-level identity.
 */
export async function paseoWorkspaces(env: NodeJS.ProcessEnv = process.env): Promise<PaseoWorkspace[]> {
  const raw = await readFile(join(paseoHome(env), "projects", "workspaces.json"), "utf8").catch(() => null);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<Record<string, unknown>>;
    const out: PaseoWorkspace[] = [];
    for (const w of Array.isArray(list) ? list : []) {
      if (typeof w.cwd !== "string" || typeof w.title !== "string" || !w.title.trim() || w.archivedAt) continue;
      const repoRoot = typeof w.mainRepoRoot === "string" ? w.mainRepoRoot : w.kind === "local_checkout" ? w.cwd : undefined;
      out.push({
        cwd: resolve(w.cwd),
        title: w.title.trim(),
        ...(typeof w.workspaceId === "string" ? { workspaceId: w.workspaceId } : {}),
        ...(repoRoot ? { repoRoot: resolve(repoRoot) } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** The Paseo workspace whose directory is `cwd` — "Clipforge-UX-UI-Claude", not the random worktree name. */
export async function paseoWorkspace(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<PaseoWorkspace | undefined> {
  const target = resolve(cwd);
  return (await paseoWorkspaces(env)).find((w) => w.cwd === target);
}

/** Paseo's records of its sessions: one JSON file per session under `agents/<directory>/`. */
export async function paseoSessions(env: NodeJS.ProcessEnv = process.env): Promise<PaseoSession[]> {
  const root = join(paseoHome(env), "agents");
  const sessions: PaseoSession[] = [];
  for (const dir of await readdir(root).catch(() => [] as string[])) {
    for (const file of await readdir(join(root, dir)).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      try {
        const d = JSON.parse(await readFile(join(root, dir, file), "utf8")) as Record<string, unknown>;
        if (typeof d.id !== "string" || typeof d.cwd !== "string" || typeof d.provider !== "string" || d.archivedAt) continue;
        sessions.push({
          id: d.id,
          cwd: resolve(d.cwd),
          provider: d.provider,
          ...(typeof d.workspaceId === "string" ? { workspaceId: d.workspaceId } : {}),
          ...(typeof d.lastStatus === "string" ? { status: d.lastStatus } : {}),
          ...(typeof d.updatedAt === "string" ? { updatedAt: d.updatedAt } : {}),
        });
      } catch {
        /* one unreadable record is not a reason to miss the others */
      }
    }
  }
  return sessions;
}

/**
 * The workspace a session belongs to, from Paseo's own records — not from where the agent happens to
 * have its shell: an agent assigned to one workspace often works in a sibling worktree of the repo.
 * Only a workspace of this project counts; a session wandering into another repo is not its agent.
 */
async function workspaceOfSession(project: Pick<Project, "root">, sessionId: string, env: NodeJS.ProcessEnv): Promise<PaseoWorkspace | undefined> {
  const [session] = (await paseoSessions(env)).filter((s) => s.id === sessionId);
  if (!session) return undefined;
  const mine = (await paseoWorkspaces(env)).filter((w) => w.repoRoot === resolve(project.root));
  return mine.find((w) => session.workspaceId && w.workspaceId === session.workspaceId) ?? mine.find((w) => w.cwd === session.cwd);
}

/** "Clipforge-UX-UI-Claude" in project "clipforge" → "ux-ui-claude": the project's own name is noise inside it. */
export function agentIdFromTitle(title: string, project: Pick<Project, "id" | "config">): string {
  // slugify() answers "project" for a name with nothing to slug; a title like that is not a project.
  if (!/[\p{L}\p{N}]/u.test(title)) return "agent";
  let slug = slugify(title).replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  // The longest first: "leftoff-agents-web-dev" must lose "leftoff-agents", not just "leftoff".
  for (const prefix of [...new Set([project.id, slugify(project.config.name)])].sort((a, b) => b.length - a.length)) {
    if (prefix && slug.startsWith(`${prefix}-`) && slug.length > prefix.length + 1) {
      slug = slug.slice(prefix.length + 1);
      break;
    }
  }
  return slug.slice(0, 40).replace(/-+$/, "") || "agent";
}

export interface ResolvedAgent {
  id: string;
  /** Learned from Paseo; only for an agent identified by its workspace. */
  label?: string;
  workspace?: string;
}

/** The agent a workspace is, for one host: the one already recorded for it, else one named after its title. */
export function agentForWorkspace(project: Pick<Project, "id" | "config">, host: HostId, workspace: PaseoWorkspace): ResolvedAgent {
  const known = project.config.agents.find((a) => a.workspace === workspace.cwd && a.host === host);
  if (known) return { id: known.id, label: workspace.title, workspace: workspace.cwd };
  let id = agentIdFromTitle(workspace.title, project);
  // Two workspaces can end up with the same name, or one name can host two programs. An agent with this
  // very id that never had a workspace (it reported under that name, or is an older host-level agent) is
  // this workspace's agent, not a different one: adopt it rather than duplicate it.
  const taken = (candidate: string) =>
    project.config.agents.some((a) => a.id === candidate && !(a.workspace === workspace.cwd && a.host === host) && !(!a.workspace && a.host === host));
  if (taken(id)) id = `${id}-${host === "claude-code" ? "claude" : host}`;
  for (let n = 2; taken(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
  return { id, label: workspace.title, workspace: workspace.cwd };
}

/**
 * Work out which agent a hook is speaking for, most specific first:
 *  1. LEFTOFF_AGENT, set by whoever runs the agent;
 *  2. the Paseo workspace it works in — each workspace is its own agent, named as the owner named
 *     it, and stays the same agent when its session is replaced or the workspace is renamed;
 *  3. the host's default id ("claude", "codex"), for work outside Paseo.
 * Before this, rule 2 did not exist and every Claude session of a project was the one "claude".
 */
export async function resolveAgent(project: Project, host: HostId | "other", env: NodeJS.ProcessEnv = process.env): Promise<ResolvedAgent> {
  const explicit = env.LEFTOFF_AGENT?.trim();
  if (explicit) return { id: explicit };

  const sessionId = env.PASEO_AGENT_ID?.trim();
  const workspace =
    host === "other"
      ? undefined
      : ((sessionId ? await workspaceOfSession(project, sessionId, env) : undefined) ?? (await paseoWorkspace(project.workRoot, env)));
  if (workspace) return agentForWorkspace(project, host as HostId, workspace);

  const declared = project.config.agents.filter((a) => a.host === host);
  if (declared.length === 1 && declared[0]) return { id: declared[0].id };
  const fallback = DEFAULT_ID[host];
  return { id: project.config.agents.some((a) => a.id === fallback) ? fallback : (declared[0]?.id ?? fallback) };
}

export async function resolveAgentId(project: Project, host: HostId | "other", env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await resolveAgent(project, host, env)).id;
}

/** What to call an agent in front of the owner: the name they gave its workspace, else the id, capitalized. */
export function displayName(project: { config: { agents: ReadonlyArray<{ id: string; label?: string | undefined }> } }, id: string): string {
  return project.config.agents.find((a) => a.id === id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** An agent as the owner might name it in chat: its id, its workspace name, or a distinctive part of either. */
export function findAgentByName(project: Pick<Project, "config">, wanted: string): Agent | undefined {
  const w = wanted.trim().toLowerCase();
  const slug = slugify(wanted);
  const agents = project.config.agents;
  return (
    agents.find((a) => a.id === w) ??
    agents.find((a) => a.label?.toLowerCase() === w || (a.label && slugify(a.label) === slug)) ??
    agents.find((a) => a.id.includes(slug) || (a.label && slugify(a.label).includes(slug)))
  );
}

/**
 * The teammate an agent means: by id or workspace name first, then by role ("backend" finds the agent
 * whose role mentions it). Never the asker itself, never a retired agent; an ambiguous role finds no one.
 */
export function findTeammate(project: Pick<Project, "config">, wanted: string, from: string): Agent | undefined {
  const team = project.config.agents.filter((a) => !a.retired && a.id !== from);
  const named = findAgentByName({ config: { ...project.config, agents: team } }, wanted);
  if (named) return named;
  const words = new Set(slugify(wanted).split("-").filter((w) => w.length > 2));
  if (!words.size) return undefined;
  const scored = team
    .map((a) => ({ a, score: a.role ? slugify(a.role).split("-").filter((w) => words.has(w)).length : 0 }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  if (!scored.length || scored[1]?.score === scored[0]!.score) return undefined;
  return scored[0]!.a;
}

/** Add an agent to project.yaml the first time it reports, so init stays trivial. */
export function ensureAgent(
  project: Project,
  id: string,
  host: HostId | "other",
  paseoAgent?: string,
  identity: { workspace?: string; label?: string } = {},
): boolean {
  const existing = project.config.agents.find((a) => a.id === id);
  let changed = false;
  if (!existing) {
    project.config.agents.push({
      id,
      control: paseoAgent ? "paseo" : "inbox",
      host,
      ...(paseoAgent ? { paseoAgent } : {}),
      ...(identity.workspace ? { workspace: identity.workspace } : {}),
      ...(identity.label ? { label: identity.label } : {}),
    });
    changed = true;
  } else {
    // Learn what we can, never overwrite what the owner configured.
    if (existing.host === "other" && host !== "other") {
      existing.host = host;
      changed = true;
    }
    if (paseoAgent && existing.paseoAgent !== paseoAgent) {
      existing.paseoAgent = paseoAgent;
      if (existing.control === "inbox") existing.control = "paseo";
      changed = true;
    }
    // An agent that reports is alive, whatever it was retired for.
    if (existing.retired) {
      delete existing.retired;
      changed = true;
    }
    if (identity.workspace && !existing.workspace) {
      existing.workspace = identity.workspace;
      changed = true;
    }
    // The title follows the workspace when Leftoff itself learned it; a label the owner wrote stays.
    if (identity.label && existing.label !== identity.label && (existing.workspace || !existing.label)) {
      existing.label = identity.label;
      changed = true;
    }
  }
  // One session belongs to one agent: an older, host-level agent that held this very session must
  // not keep receiving what is meant for the workspace agent that has taken it over.
  if (paseoAgent) {
    for (const other of project.config.agents) {
      if (other.id !== id && other.paseoAgent === paseoAgent) {
        delete other.paseoAgent;
        other.control = "inbox";
        if (!other.workspace) other.retired = true;
        changed = true;
      }
    }
  }
  return changed;
}
