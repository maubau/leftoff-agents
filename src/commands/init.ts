import { mkdir, writeFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { UserError } from "../core/errors.ts";
import { headSha, mainWorktreeRoot } from "../core/git.ts";
import { loadProject, ProjectSchema, saveProject, slugify, type ProjectConfig } from "../core/project.ts";
import { repoPaths } from "../core/paths.ts";
import { registerProject } from "../core/registry.ts";
import { INSTRUCTION_FILES, upsertProtocol } from "../core/protocol.ts";
import { buildSnapshot } from "../core/snapshot.ts";
import { writeState } from "../core/render.ts";
import { resolveBinary } from "../core/binary.ts";
import { HOSTS } from "../hosts/index.ts";

export interface InitOptions {
  name?: string;
  purpose?: string;
  private?: boolean;
  hooks: boolean;
  force: boolean;
}

const GITIGNORE = [
  "# Leftoff: the inbox is transient delivery state, not project memory.",
  "inbox/",
  "",
].join("\n");

export async function init(cwd: string, options: InitOptions): Promise<string[]> {
  // From inside a Paseo worktree, set up the main checkout: that is where the
  // project's memory lives for every agent and every branch.
  const root = await mainWorktreeRoot(cwd);
  if (!root) {
    throw new UserError(
      `${cwd} is not inside a git repository`,
      "Run `git init` first — Leftoff keeps a project's memory in its repo.",
    );
  }
  const paths = repoPaths(root);
  const log: string[] = [];

  const existing = await loadProject(root).catch(() => null);
  if (existing && !options.force) {
    log.push(`Already initialised: ${paths.project}`);
  } else {
    const config: ProjectConfig = ProjectSchema.parse({
      name: options.name ?? existing?.config.name ?? basename(root),
      purpose: options.purpose ?? existing?.config.purpose ?? "",
      agents: existing?.config.agents ?? [],
      visibility: options.private ? "private" : (existing?.config.visibility ?? "normal"),
    });
    await saveProject(root, config);
    log.push(`${existing ? "Updated" : "Created"} ${paths.project}`);
  }

  await mkdir(paths.reports, { recursive: true });
  await mkdir(paths.inbox, { recursive: true });
  await writeFile(join(paths.reports, ".gitkeep"), "", "utf8");
  const ignore = join(paths.root, ".gitignore");
  if (!(await readFile(ignore, "utf8").catch(() => null))) {
    await writeFile(ignore, GITIGNORE, "utf8");
    log.push(`Created ${ignore}`);
  }

  const project = await loadProject(root);
  const id = project.id;

  for (const filename of INSTRUCTION_FILES) {
    const exists = await readFile(join(root, filename), "utf8").catch(() => null);
    // Create AGENTS.md always; only touch CLAUDE.md if the project already uses it.
    if (filename === "CLAUDE.md" && exists === null) continue;
    const result = await upsertProtocol(project, filename);
    if (result !== "unchanged") log.push(`${result === "created" ? "Created" : "Updated"} ${filename}`);
  }

  await registerProject(id, root);
  log.push(`Registered project "${id}"`);

  if (options.hooks) {
    const binary = await resolveBinary();
    for (const host of HOSTS) {
      for (const hostRoot of await host.detectRoots()) {
        const result = await host.install(hostRoot, binary).catch((error: Error) => {
          log.push(`! ${host.label} (${hostRoot.dir}): ${error.message}`);
          return null;
        });
        if (!result) continue;
        if (result.installed.length) {
          log.push(`${host.label} [${hostRoot.origin}]: installed ${result.installed.join(", ")}`);
        }
        for (const note of result.manual) log.push(`  → ${note}`);
      }
    }
  } else {
    log.push("Skipped hook installation (--no-hooks)");
  }

  // Stamp the baseline once, after every file init writes. Re-running init to
  // refresh the protocol block must not move it, or real work done since would
  // silently stop counting; the block itself is recognised by content instead.
  if (!project.config.initializedAt) {
    project.config.initializedAt = new Date().toISOString();
    const head = await headSha(root);
    if (head) project.config.initializedHead = head;
    await saveProject(root, project.config);
  }

  await writeState(await buildSnapshot(project));
  log.push(`Wrote ${paths.state}`);
  log.push("", `Next: let an agent work, then run \`leftoff brief\`.`);
  return log;
}

export { slugify };
