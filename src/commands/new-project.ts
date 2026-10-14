import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../core/config.ts";
import { slugify } from "../core/project.ts";
import { readRegistry, registerProject } from "../core/registry.ts";
import { init } from "./init.ts";

/**
 * A new project from Leftoff (D-056): a name becomes a folder under `projects.root`, a git repository, a Leftoff
 * project with its first commit, an entry in the registry and a Paseo project. Each step can run again without harm,
 * so a retry resumes from the one that failed; nothing is ever deleted.
 */

export const NAME_MAX = 60;
const ID_MAX = 40;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Ids the panel or chat already use for something else (`web-general` is the general thread). */
const RESERVED = new Set(["general", "settings", "new", "api"]);

export const STEPS = ["folder", "repository", "leftoff", "registry", "paseo"] as const;
export type StepId = (typeof STEPS)[number];

/** `cwd` for git; Paseo's command line ignores it. */
export type RunFn = (file: string, args: string[], cwd?: string) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const defaultRun: RunFn = (file, args, cwd) => execFileAsync(file, args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });

export type NewProjectErrorType = "invalid_name" | "exists" | "paseo_unavailable" | "paseo_refused" | "git_identity" | "failed";

/** Why a name or a step was refused: `type` and the rest let the panel and chat say it in the owner's language. */
export class NewProjectError extends Error {
  readonly type: NewProjectErrorType;
  readonly reason: string | undefined;
  readonly existing: { kind: "project" | "folder" | "paseo"; id?: string } | undefined;
  /** What Paseo or git said: shown as a detail, never a command line. */
  readonly detail: string | undefined;
  constructor(type: NewProjectErrorType, message: string, extra: { reason?: string; existing?: NewProjectError["existing"]; detail?: string } = {}) {
    super(message);
    this.type = type;
    this.reason = extra.reason;
    this.existing = extra.existing;
    this.detail = extra.detail;
  }

  /** The HTTP status the panel's answer carries. */
  get status(): number {
    return this.type === "invalid_name" ? 400 : this.type === "exists" ? 409 : this.type === "paseo_unavailable" ? 503 : this.type === "paseo_refused" ? 502 : 500;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.message, type: this.type, ...(this.reason ? { reason: this.reason } : {}), ...(this.existing ? { existing: this.existing } : {}), ...(this.detail ? { detail: this.detail } : {}) };
  }
}

/** The folder new projects go under, `~` expanded. */
export function projectsRoot(config: Pick<Config, "projects">): string {
  const root = config.projects.root;
  return resolve(root === "~" ? homedir() : root.startsWith("~/") ? join(homedir(), root.slice(2)) : root);
}

export interface NewProjectPlan {
  name: string;
  id: string;
  folder: string;
}

/**
 * What a name would make, or why it cannot: one line of up to 60 characters, an id the project rules accept, not
 * taken, and a folder that does not exist yet. Asks nothing of Paseo: a folder that does not exist has no project
 * there.
 */
export async function planProject(rawName: unknown, root: string): Promise<NewProjectPlan> {
  if (typeof rawName !== "string") throw new NewProjectError("invalid_name", "the name is missing", { reason: "empty" });
  // Control characters are refused before whitespace is folded, or a newline would pass as a space.
  if (/[\p{Cc}\p{Cf}]/u.test(rawName.replace(/[\t\n\r ]/g, ""))) throw new NewProjectError("invalid_name", "the name has characters a folder cannot have", { reason: "bad_chars" });
  const name = rawName.replace(/\s+/g, " ").trim();
  if (!name) throw new NewProjectError("invalid_name", "the name is empty", { reason: "empty" });
  if (name.length > NAME_MAX) throw new NewProjectError("invalid_name", `the name is longer than ${NAME_MAX} characters`, { reason: "too_long" });
  if (!/[\p{L}\p{N}]/u.test(name)) throw new NewProjectError("invalid_name", "no folder can be made from this name", { reason: "no_id" });
  const id = slugify(name).slice(0, ID_MAX).replace(/-+$/, "");
  if (!ID_RE.test(id)) throw new NewProjectError("invalid_name", "no folder can be made from this name: use Latin letters or digits", { reason: "no_id" });
  if (RESERVED.has(id)) throw new NewProjectError("invalid_name", "that name is reserved", { reason: "reserved" });
  if ((await readRegistry()).projects.some((p) => p.id === id)) throw new NewProjectError("exists", "a project with that name already exists", { existing: { kind: "project", id } });
  const folder = join(root, id);
  if (await lstat(folder).then(() => true, () => false)) throw new NewProjectError("exists", "a folder with that name already exists", { existing: { kind: "folder" } });
  return { name, id, folder };
}

export interface StepContext extends NewProjectPlan {
  root: string;
  purpose?: string | undefined;
  /** Written into the new repository's own config before its first commit (`projects.git`). */
  git?: { name: string; email: string } | undefined;
  run?: RunFn;
}

/**
 * The folder is a real directory, a direct child of the real root: not a symlink, whatever was put there between two
 * steps or before a retry. Checked before every step, so nothing is written anywhere else.
 */
async function assertOwnFolder(ctx: StepContext): Promise<void> {
  if (resolve(ctx.folder) !== resolve(join(ctx.root, ctx.id))) throw new NewProjectError("failed", "the folder would be outside the projects' root");
  const root = await realpath(ctx.root);
  const info = await lstat(join(root, ctx.id)).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory() || (await realpath(join(root, ctx.id))) !== join(root, ctx.id)) {
    throw new NewProjectError("failed", "the project's folder is not a plain folder inside the projects' root");
  }
}

/** One step, safe to run again: what is already there is accepted, what is someone else's is refused. */
export async function runStep(step: StepId, ctx: StepContext): Promise<void> {
  const run = ctx.run ?? defaultRun;
  if (step !== "folder") await assertOwnFolder(ctx);
  switch (step) {
    case "folder": {
      await mkdir(ctx.root, { recursive: true });
      // The real root, symlinks resolved: the folder must be a direct child of it, whatever the name was.
      const root = await realpath(ctx.root);
      const folder = join(root, ctx.id);
      if (dirname(folder) !== root || resolve(ctx.folder) !== resolve(join(ctx.root, ctx.id))) throw new NewProjectError("failed", "the folder would be outside the projects' root");
      try {
        await mkdir(folder);
      } catch (error) {
        // Made by this creation before it stopped: still a plain empty folder, so still ours. A symlink never is.
        const info = await lstat(folder).catch(() => null);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !info || info.isSymbolicLink() || !info.isDirectory() || (await readdir(folder)).length > 0) {
          throw new NewProjectError("exists", "a folder with that name already exists", { existing: { kind: "folder" } });
        }
      }
      await assertOwnFolder(ctx);
      return;
    }
    case "repository": {
      if (await lstat(join(ctx.folder, ".git")).then(() => true, () => false)) return;
      await run("git", ["init", "-q"], ctx.folder).catch((error: Error) => {
        throw new NewProjectError("failed", "git could not make the repository", { detail: gitMessage(error) });
      });
      return;
    }
    case "leftoff": {
      await init(ctx.folder, { name: ctx.name, ...(ctx.purpose ? { purpose: ctx.purpose } : {}), hooks: false, force: false, register: false });
      // The first commit, after the Leftoff files: an agent's worktree is made from it and must have AGENTS.md.
      const head = await run("git", ["rev-parse", "--verify", "-q", "HEAD"], ctx.folder).then(() => true, () => false);
      if (head) return;
      // The repository's own identity, set here so a retry after a missing identity picks it up too.
      if (ctx.git) {
        await run("git", ["config", "user.name", ctx.git.name], ctx.folder);
        await run("git", ["config", "user.email", ctx.git.email], ctx.folder);
      }
      try {
        await run("git", ["add", "-A"], ctx.folder);
        await run("git", ["commit", "-q", "-m", "Leftoff: new project"], ctx.folder);
      } catch (error) {
        const said = gitMessage(error as Error);
        if (/tell me who you are|empty ident|user\.email|user\.name/i.test(said)) {
          throw new NewProjectError("git_identity", "git has no name and email on this machine to make the first commit", { detail: said });
        }
        throw new NewProjectError("failed", "git could not make the first commit", { detail: said });
      }
      return;
    }
    case "registry": {
      const taken = (await readRegistry()).projects.find((p) => p.id === ctx.id && resolve(p.path) !== resolve(ctx.folder));
      if (taken) throw new NewProjectError("exists", "a project with that name already exists", { existing: { kind: "project", id: ctx.id } });
      await registerProject(ctx.id, ctx.folder);
      return;
    }
    case "paseo": {
      // Not idempotent in Paseo (the same path twice makes a second workspace): look first.
      const workspaces = await paseoJson<Array<{ cwd?: unknown }>>(run, ["workspace", "ls", "--json"]);
      if (Array.isArray(workspaces) && workspaces.some((w) => typeof w.cwd === "string" && resolve(w.cwd) === resolve(ctx.folder))) return;
      // `--title=…` in one argument: a name that starts with a dash is still a title, never an option.
      await paseoJson(run, ["workspace", "create", "--isolation", "local", `--path=${ctx.folder}`, `--title=${ctx.name}`, "--json"]);
      return;
    }
  }
}

/** Is Paseo there to answer? For the panel's form, before anything is made. */
export async function paseoAnswers(run: RunFn = defaultRun): Promise<boolean> {
  return paseoJson(run, ["workspace", "ls", "--json"]).then(() => true, () => false);
}

/** Paseo's answer, or why there is none: not installed or not running, or a refusal in its own words. */
async function paseoJson<T>(run: RunFn, args: string[]): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await run("paseo", args));
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const said = `${e.stderr ?? ""} ${e.message ?? ""}`;
    if (e.code === "ENOENT" || UNREACHABLE.test(said)) throw new NewProjectError("paseo_unavailable", "Paseo does not answer");
    throw refusal(e.stdout) ?? new NewProjectError("paseo_refused", "Paseo refused it", { detail: (e.stderr || e.message || "").trim().slice(0, 300) });
  }
  const refused = refusal(stdout);
  if (refused) throw refused;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new NewProjectError("paseo_refused", "Paseo gave an answer Leftoff does not understand");
  }
}

const UNREACHABLE = /DAEMON_NOT_RUNNING|Cannot connect|ECONNREFUSED|not running|unreachable|timed out|ETIMEDOUT/i;

/** Paseo answers `{"error":{code,message}}`: its daemon not running is «does not answer», anything else a refusal. */
function refusal(stdout: string | undefined): NewProjectError | null {
  if (!stdout) return null;
  try {
    const error = (JSON.parse(stdout) as { error?: { code?: unknown; message?: unknown } })?.error;
    if (!error) return null;
    if (UNREACHABLE.test(`${String(error.code ?? "")} ${String(error.message ?? "")}`)) return new NewProjectError("paseo_unavailable", "Paseo does not answer");
    return new NewProjectError("paseo_refused", "Paseo refused it", { detail: String(error.message ?? "refused").slice(0, 300) });
  } catch {
    return null;
  }
}

function gitMessage(error: Error): string {
  return String((error as { stderr?: unknown }).stderr || error.message || "").trim().slice(0, 300);
}
