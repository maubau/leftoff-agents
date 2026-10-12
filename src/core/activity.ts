import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { REPO_DIR } from "./paths.ts";
import { INSTRUCTION_FILES, stripProtocol } from "./protocol.ts";
import { isAfter, ms } from "./time.ts";
import { commitsSince, readOnlyGitEnv, type Commit } from "./git.ts";
import type { Project } from "./project.ts";

const exec = promisify(execFile);

/** Git, read-only: never the index lock of a worktree an agent is committing in. */
const git = (cwd: string, args: string[]) => exec("git", args, { cwd, env: readOnlyGitEnv(), maxBuffer: 16 * 1024 * 1024 });

/** A map that forgets the entries used least recently past `max`: what a long-running hub can keep without growing. */
class Lru<K, V> {
  readonly #max: number;
  readonly #map = new Map<K, V>();
  constructor(max: number) {
    this.#max = max;
  }
  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value as K);
  }
  clear(): void {
    this.#map.clear();
  }
}

/**
 * What never changes for a commit, kept so the hub classifies each one once instead of every minute in every worktree
 * (one project with 29 worktrees: 3,706 `diff-tree` a minute for 218 commits). Keyed by the full sha, which names the
 * same commit in every worktree of a repository. Only answers git gave: a failed call is asked again next time. Whether
 * a file was touched after a commit's report is not here: it can change, so it is looked at every time.
 */
const cache = {
  bookkeeping: new Lru<string, boolean>(5000),
  files: new Lru<string, string[]>(5000),
  reportAt: new Lru<string, number>(5000),
};

/** For tests: start from nothing. */
export function clearCommitCache(): void {
  cache.bookkeeping.clear();
  cache.files.clear();
  cache.reportAt.clear();
}

/** The files a commit touches (`--diff-filter` optional); null when git failed, which is never kept. */
async function commitFiles(repoRoot: string, sha: string, filter: string[] = []): Promise<string[] | null> {
  const key = `${sha} ${filter.join(" ")}`;
  const known = cache.files.get(key);
  if (known) return known;
  try {
    const { stdout } = await git(repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", ...filter, sha]);
    const files = stdout.split("\n").filter(Boolean);
    cache.files.set(key, files);
    return files;
  } catch {
    return null;
  }
}

/**
 * A file's content at a revision: "" when it is not there (added or removed by the commit, or a root commit) — an
 * answer, kept like any other — and null when git failed for another reason.
 */
async function contentAt(repoRoot: string, rev: string, path: string): Promise<string | null> {
  try {
    return (await git(repoRoot, ["show", `${rev}:${path}`])).stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    return /does not exist in|exists on disk, but not in|invalid object name|unknown revision/i.test(stderr) ? "" : null;
  }
}

/** How far back the very first report of a project may claim credit. */
const FIRST_REPORT_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Covers the precision gap between git author dates and report timestamps. */
const BOUNDARY_SLACK_MS = 5000;

export interface Activity {
  /** Commits made after `since`. */
  commits: Commit[];
  /** Working-tree files changed after `since`, excluding Leftoff's own directory. */
  dirtyFiles: string[];
  /** True when the project moved after `since` and nobody reported it. */
  changed: boolean;
}

async function dirtyPaths(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await git(repoRoot, ["status", "--porcelain=v1", "-uall"]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"))
      // A rename shows as `old -> new`; only the new path exists on disk.
      .map((path) => path.split(" -> ").at(-1) ?? path)
      .filter((path) => !isLeftoffPath(path));
  } catch {
    return [];
  }
}

/**
 * True when the only difference between a file and its committed version is
 * the Leftoff protocol block — i.e. `leftoff init` touched it, nobody else did.
 */
async function onlyProtocolChanged(repoRoot: string, path: string): Promise<boolean> {
  if (!(INSTRUCTION_FILES as readonly string[]).includes(path)) return false;
  const now = await readFile(join(repoRoot, path), "utf8").catch(() => "");
  const committed = await git(repoRoot, ["show", `HEAD:${path}`]).then(
    ({ stdout }) => stdout,
    () => "",
  );
  return stripProtocol(now) === stripProtocol(committed);
}

function isLeftoffPath(path: string): boolean {
  return path === REPO_DIR || path.startsWith(`${REPO_DIR}/`);
}

/**
 * A commit that only touches Leftoff's own bookkeeping — `.leftoff/`, or the
 * protocol block in AGENTS.md / CLAUDE.md — is the owner (or the hub) saving
 * project memory, never an agent's work. Merges and empty diffs count as work.
 */
async function isBookkeepingCommit(repoRoot: string, sha: string): Promise<boolean> {
  const known = cache.bookkeeping.get(sha);
  if (known !== undefined) return known;
  const files = await commitFiles(repoRoot, sha);
  if (files === null) return false; // git failed: count it as work this time, and ask again next time
  let verdict = files.length > 0;
  for (const path of files) {
    if (!verdict) break;
    if (isLeftoffPath(path)) continue;
    if (!(INSTRUCTION_FILES as readonly string[]).includes(path)) {
      verdict = false;
      break;
    }
    const [after, before] = await Promise.all([contentAt(repoRoot, sha, path), contentAt(repoRoot, `${sha}^`, path)]);
    if (after === null || before === null) return false; // not kept: a failed call is no answer
    if (stripProtocol(after) !== stripProtocol(before)) verdict = false;
  }
  cache.bookkeeping.set(sha, verdict);
  return verdict;
}

/** When the report a commit adds says it was written; 0 when it says nothing; null when git failed. */
async function reportTime(repoRoot: string, sha: string, path: string): Promise<number | null> {
  const key = `${sha} ${path}`;
  const known = cache.reportAt.get(key);
  if (known !== undefined) return known;
  const text = await contentAt(repoRoot, sha, path);
  if (text === null) return null;
  const at = /^at:\s*['"]?([^'"\n]+)/m.exec(text)?.[1];
  const value = at ? ms(at) : 0;
  cache.reportAt.set(key, value);
  return value;
}

/**
 * A commit that adds a Leftoff report carries its own account of the work —
 * the natural "report, then commit" order must not trigger a second report.
 * But only for the files the report could have described: anything touched
 * after the report was written is still new, unreported work.
 */
async function coveredByOwnReport(repoRoot: string, sha: string): Promise<boolean> {
  const added = await commitFiles(repoRoot, sha, ["--diff-filter=A"]);
  if (added === null) return false;
  const reports = added.filter((path) => path.startsWith(`${REPO_DIR}/reports/`) && path.endsWith(".md"));
  if (reports.length === 0) return false;

  let reportedAt = 0;
  for (const path of reports) {
    const at = await reportTime(repoRoot, sha, path);
    if (at === null) return false;
    reportedAt = Math.max(reportedAt, at);
  }
  if (!reportedAt) return false;

  const files = await commitFiles(repoRoot, sha);
  if (files === null) return false;
  // Looked at every time: a file touched after the report is new work, whatever the commit said.
  for (const path of files) {
    if (isLeftoffPath(path)) continue;
    const info = await stat(join(repoRoot, path)).catch(() => null);
    if (info && info.mtimeMs > reportedAt) return false;
  }
  return true;
}

/**
 * Uncommitted changes that are someone's work: everything dirty except
 * Leftoff's own directory and edits confined to its protocol block.
 */
export async function workDirtyFiles(repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const path of await dirtyPaths(repoRoot)) {
    if (!(await onlyProtocolChanged(repoRoot, path))) out.push(path);
  }
  return out;
}

/**
 * Did anything happen since the agent last reported?
 *
 * Commits alone are not enough — agents often leave work uncommitted — so the
 * working tree counts too.
 */
export async function activitySince(
  project: Project,
  since?: string,
  claimed: ReadonlySet<string> = new Set(),
  options: { dirty?: boolean } = {},
): Promise<Activity> {
  // Nothing before `leftoff init` is an agent's turn: not the history, and not
  // the protocol block init itself just wrote into AGENTS.md / CLAUDE.md.
  const initialized = project.config.initializedAt;
  const baseline =
    since && initialized ? (isAfter(since, initialized) ? since : initialized) : (since ?? initialized);
  // With no lower bound at all, attributing the whole history to one turn would
  // be worse than useless. Fall back to a plausible session window instead.
  const floor = baseline ?? new Date(Date.now() - FIRST_REPORT_WINDOW_MS).toISOString();
  // Git author dates have second precision while report timestamps have
  // milliseconds, so a strict `>` drops a commit made in the same second as the
  // previous report. Widen the window and let `claimed` do the exact filtering.
  // The slack only applies at a report boundary, where `claimed` catches doubles;
  // at the init boundary there is nothing to dedupe against, so it stays strict.
  // At the init boundary the time filter only needs second precision, matching
  // git's own; pre-init commits are excluded by ancestry below.
  const fromReport = baseline !== undefined && baseline === since;
  const window = fromReport
    ? new Date(ms(floor) - BOUNDARY_SLACK_MS).toISOString()
    : new Date(Math.floor(ms(floor) / 1000) * 1000 - 1).toISOString();
  // Whatever HEAD contained at init is history at every boundary, not just the first.
  const head = project.config.initializedHead;
  const commits = await commitsSince(
    project.workRoot,
    { date: window, ...(head ? { notReachableFrom: head } : {}) },
    100,
  );
  const filtered: Commit[] = [];
  for (const c of commits) {
    if (claimed.has(c.shortSha) || claimed.has(c.sha) || !isAfter(c.at, window)) continue;
    if (await isBookkeepingCommit(project.workRoot, c.sha)) continue;
    if (await coveredByOwnReport(project.workRoot, c.sha)) continue;
    filtered.push(c);
  }

  // Dirty files are only evidence of *this* turn if they were touched after the
  // last report; without the mtime check a stale edit would make Leftoff nag forever.
  // `dirty: false` (the hub's watcher, which only looks at commits): no `git status` at all.
  const candidates = options.dirty === false ? [] : await dirtyPaths(project.workRoot);
  const dirtyFiles: string[] = [];
  const cutoff = baseline ? ms(baseline) : 0;
  for (const path of candidates) {
    if (await onlyProtocolChanged(project.workRoot, path)) continue;
    const info = await stat(join(project.workRoot, path)).catch(() => null);
    if (!info || info.mtimeMs > cutoff) dirtyFiles.push(path);
  }

  return { commits: filtered, dirtyFiles, changed: filtered.length > 0 || dirtyFiles.length > 0 };
}

export function describeActivity(activity: Activity): string {
  const parts: string[] = [];
  if (activity.commits.length) parts.push(`${activity.commits.length} commit(s)`);
  if (activity.dirtyFiles.length) parts.push(`${activity.dirtyFiles.length} changed file(s)`);
  return parts.join(" and ") || "no changes";
}
