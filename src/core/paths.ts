import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The directory Leftoff owns inside every managed repository. */
export const REPO_DIR = ".leftoff";

/** Global config root: `~/.config/leftoff`, overridable for tests. */
export function configRoot(): string {
  const override = process.env.LEFTOFF_CONFIG_DIR;
  if (override) return resolve(override);
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg ? resolve(xdg) : join(homedir(), ".config"), "leftoff");
}

export const globalPaths = {
  root: configRoot,
  registry: () => join(configRoot(), "projects.json"),
  config: () => join(configRoot(), "config.yaml"),
  secrets: () => join(configRoot(), "secrets.env"),
  logs: () => join(configRoot(), "logs"),
  cache: () => join(configRoot(), "cache.sqlite"),
};

/** Every Leftoff path inside a repository, derived from the repo root. */
export function repoPaths(repoRoot: string) {
  const base = join(repoRoot, REPO_DIR);
  return {
    root: base,
    project: join(base, "project.yaml"),
    reports: join(base, "reports"),
    reportsDay: (day: string) => join(base, "reports", day),
    decisions: join(base, "decisions.md"),
    history: join(base, "HISTORY.md"),
    state: join(base, "STATE.md"),
    inbox: join(base, "inbox"),
    inboxFor: (agentId: string) => join(base, "inbox", `${agentId}.jsonl`),
    backlog: join(repoRoot, "backlog"),
  };
}

export type RepoPaths = ReturnType<typeof repoPaths>;
