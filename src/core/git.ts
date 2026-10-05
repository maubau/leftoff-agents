import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Commit {
  sha: string;
  shortSha: string;
  at: string;
  author: string;
  subject: string;
}

export interface GitStatus {
  branch: string;
  dirtyFiles: number;
  staged: number;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Walk up from `from` to the root of its git working tree, or null if there is none. */
export async function findRepoRoot(from: string): Promise<string | null> {
  try {
    return (await git(from, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}

/**
 * The main checkout behind a linked worktree. Paseo runs every agent in its own
 * worktree under ~/.paseo/worktrees, on its own branch; a project's memory must
 * still live in one place, or `leftoff brief` on main would never see it.
 * Returns the worktree itself for submodules and other unusual layouts.
 */
export async function mainWorktreeRoot(from: string): Promise<string | null> {
  const top = await findRepoRoot(from);
  if (!top) return null;
  try {
    const common = (await git(from, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    if (basename(common) === ".git") return dirname(common);
  } catch {
    /* old git without --path-format: fall through */
  }
  return top;
}

export async function currentBranch(repo: string): Promise<string | null> {
  try {
    const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  return (await findRepoRoot(path)) !== null;
}

/** HEAD sha, or null on a repo with no commits yet. */
export async function headSha(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

const LOG_FORMAT = "%H%x1f%h%x1f%aI%x1f%an%x1f%s";

function parseLog(stdout: string): Commit[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", at = "", author = "", subject = ""] = line.split("\x1f");
      return { sha, shortSha, at, author, subject };
    });
}

/** Commits reachable from HEAD, newest first, optionally limited to those after `since`. */
export async function commitsSince(
  repo: string,
  since?: { sha?: string; date?: string; notReachableFrom?: string },
  limit = 200,
): Promise<Commit[]> {
  const args = ["log", `--max-count=${limit}`, `--format=${LOG_FORMAT}`];
  if (since?.notReachableFrom) {
    // Exclude everything that already existed at that commit. A sha that has
    // since been rebased away makes git fail; retry without the exclusion.
    try {
      const date = since.date ? [`--since=${since.date}`] : [];
      return parseLog(await git(repo, [...args, ...date, "HEAD", `^${since.notReachableFrom}`]));
    } catch {
      /* fall through */
    }
  }
  if (since?.sha) {
    // `sha..HEAD` fails if the sha is gone (rebase, amend); fall back to the date range.
    try {
      return parseLog(await git(repo, [...args, `${since.sha}..HEAD`]));
    } catch {
      /* fall through */
    }
  }
  if (since?.date) args.push(`--since=${since.date}`);
  try {
    return parseLog(await git(repo, args));
  } catch {
    return [];
  }
}

export async function status(repo: string): Promise<GitStatus> {
  let branch = "(unknown)";
  try {
    branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    /* no commits yet */
  }
  let dirtyFiles = 0;
  let staged = 0;
  try {
    const out = await git(repo, ["status", "--porcelain=v1"]);
    for (const line of out.split("\n").filter(Boolean)) {
      dirtyFiles++;
      if (line[0] && line[0] !== " " && line[0] !== "?") staged++;
    }
  } catch {
    /* not a repo */
  }
  return { branch, dirtyFiles, staged };
}

/** Files changed and insertions/deletions across a commit range. */
export async function diffStat(
  repo: string,
  from: string,
  to = "HEAD",
): Promise<{ files: number; insertions: number; deletions: number }> {
  try {
    const out = await git(repo, ["diff", "--numstat", `${from}..${to}`]);
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of out.split("\n").filter(Boolean)) {
      const [add = "0", del = "0"] = line.split("\t");
      files++;
      insertions += Number(add) || 0;
      deletions += Number(del) || 0;
    }
    return { files, insertions, deletions };
  } catch {
    return { files: 0, insertions: 0, deletions: 0 };
  }
}

/** True when the working tree has changes Leftoff should consider "work done". */
export async function hasUncommittedWork(repo: string, ignore: string[] = []): Promise<boolean> {
  try {
    const out = await git(repo, ["status", "--porcelain=v1"]);
    return out
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        const path = line.slice(3);
        return !ignore.some((prefix) => path.startsWith(prefix));
      });
  } catch {
    return false;
  }
}
