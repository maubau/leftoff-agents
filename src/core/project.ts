import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { UserError } from "./errors.ts";
import { findRepoRoot, mainWorktreeRoot } from "./git.ts";
import { repoPaths, type RepoPaths } from "./paths.ts";

export const AgentSchema = z.object({
  /** Stable short id used in report filenames, inbox files and chat ("claude", "codex"). */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "agent id must be lowercase kebab/snake"),
  /** How the PM reaches this agent. `inbox` is universal; `paseo` also pushes live. */
  control: z.enum(["inbox", "paseo"]).default("inbox"),
  /** Host that runs the agent, when known. Drives which hooks are installed. */
  host: z.enum(["claude-code", "codex", "other"]).default("other"),
  /** Paseo agent id, when `control: paseo`. Resolved by name at runtime if absent. */
  paseoAgent: z.string().optional(),
  /**
   * The Paseo workspace this agent works in (its absolute path), learned from its first report. It
   * is what makes the agent stable: sessions come and go, the workspace is the unit the owner named.
   */
  workspace: z.string().optional(),
  /**
   * Replaced by the agents of the project's Paseo workspaces: kept for its history, but its last report
   * is no longer anyone's current state, so it is not shown as an agent, nor waited for.
   */
  retired: z.boolean().optional(),
  /** What the owner calls it: the Paseo workspace title ("Clipforge-UX-UI-Claude"). Shown instead of the id. */
  label: z.string().optional(),
});

export const ProjectSchema = z.object({
  schema: z.literal(1).default(1),
  /** Human name, shown in chat. */
  name: z.string().min(1),
  /** One line: what this project is for. Grounds the PM's answers. */
  purpose: z.string().default(""),
  agents: z.array(AgentSchema).default([]),
  /** `private` projects never produce any chat output. */
  visibility: z.enum(["normal", "private"]).default("normal"),
  /** Overrides the slug derived from the directory name. */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
  /**
   * When `leftoff init` last touched the repo. Nothing before this counts as an
   * agent's work — in particular not the AGENTS.md / CLAUDE.md edits init makes.
   */
  initializedAt: z.string().optional(),
  /** HEAD of the main checkout at init. Commits it already contained are history. */
  initializedHead: z.string().optional(),
});

export type Agent = z.infer<typeof AgentSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;

export interface Project {
  /** Main checkout: where `.leftoff/` — reports, inbox, decisions — lives. */
  root: string;
  /**
   * The checkout the current agent works in. Equals `root` except inside a
   * linked worktree (Paseo), where commits and edits must be measured.
   */
  workRoot: string;
  /** Slug used for chat routing and registry keys. */
  id: string;
  config: ProjectConfig;
  paths: RepoPaths;
}

export function slugify(input: string): string {
  return (
    input
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "project"
  );
}

export async function loadProject(root: string, workRoot = root): Promise<Project> {
  const paths = repoPaths(root);
  let raw: string;
  try {
    raw = await readFile(paths.project, "utf8");
  } catch {
    throw new UserError(
      `No Leftoff project at ${root}`,
      "Run `leftoff init` inside the repository first.",
    );
  }
  const parsed = ProjectSchema.safeParse(parseYaml(raw) ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new UserError(`Invalid ${paths.project}:\n${issues.join("\n")}`);
  }
  const config = parsed.data;
  return { root, workRoot, id: config.id ?? slugify(basename(root)), config, paths };
}

export async function saveProject(root: string, config: ProjectConfig): Promise<void> {
  const paths = repoPaths(root);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.project, stringifyYaml(config, { lineWidth: 0 }), "utf8");
}

/**
 * Resolve the project that owns `cwd`: the enclosing git repository — or, from a
 * linked worktree, its main checkout — which must have been `leftoff init`-ed.
 */
export async function resolveProject(cwd = process.cwd()): Promise<Project> {
  const workRoot = await findRepoRoot(resolve(cwd));
  const root = await mainWorktreeRoot(resolve(cwd));
  if (!root || !workRoot) {
    throw new UserError(
      `${cwd} is not inside a git repository`,
      "Leftoff stores a project's memory in its repo, so it needs one.",
    );
  }
  return loadProject(root, workRoot);
}

/** Like `resolveProject`, but null instead of an error — for hooks. */
export async function tryResolveProject(cwd = process.cwd()): Promise<Project | null> {
  return resolveProject(cwd).catch(() => null);
}

export function findAgent(project: Project, agentId: string): Agent | undefined {
  return project.config.agents.find((a) => a.id === agentId);
}
