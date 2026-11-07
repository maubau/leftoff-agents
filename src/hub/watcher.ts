import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activitySince } from "../core/activity.ts";
import { readOnlyGitEnv, type Commit } from "../core/git.ts";
import { loadProject, type Project } from "../core/project.ts";
import { readRegistry } from "../core/registry.ts";
import { claimedCommits, readReports, type Report } from "../core/report.ts";
import type { HubState } from "./state.ts";

const exec = promisify(execFile);

export type HubEvent =
  | { kind: "report"; project: Project; report: Report; reply?: boolean }
  | { kind: "unreported"; project: Project; branch: string | null; commits: Commit[] };

export interface Worktree {
  path: string;
  branch: string | null;
}

/** Every checkout of a repo: the main one and each linked (Paseo) worktree. */
export async function worktrees(repoRoot: string): Promise<Worktree[]> {
  const out = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, env: readOnlyGitEnv() }).then(
    ({ stdout }) => stdout,
    () => "",
  );
  const result: Worktree[] = [];
  for (const block of out.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path || /^prunable/m.test(block)) continue;
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    result.push({ path, branch: ref });
  }
  return result.length ? result : [{ path: repoRoot, branch: null }];
}

const MERGE = /^Merge (pull request|branch|remote-tracking branch)\b/;

export async function watchedProjects(): Promise<Project[]> {
  const projects: Project[] = [];
  for (const entry of (await readRegistry()).projects) {
    const project = await loadProject(entry.path).catch(() => null);
    if (project) projects.push(project);
  }
  return projects;
}

/**
 * One pass over every project: new reports worth telling, and commits that
 * sat unreported long enough. A project seen for the first time is baselined
 * silently — the owner hears about what happens next, not about history.
 */
export async function scan(
  projects: readonly Project[],
  state: HubState,
  options: { now: Date; unreportedAfterMinutes: number; awaiting?: Record<string, string> },
): Promise<HubEvent[]> {
  const events: HubEvent[] = [];

  for (const project of projects) {
    const reports = await readReports(project, { limit: 200 });
    const firstSight = state.seenReports[project.id] === undefined;
    const seen = new Set(state.seenReports[project.id] ?? []);
    const replyScheduled = new Set<string>();
    for (const report of [...reports].reverse()) {
      if (seen.has(report.file)) continue;
      if (firstSight) {
        seen.add(report.file);
        continue;
      }
      // The first report an agent writes after an instruction the owner sent through
      // the PM is that instruction's answer, whatever its status: it is always worth telling.
      const awaitingKey = `${project.id}:${report.agent}`;
      const sentAt = options.awaiting?.[awaitingKey];
      const reply = sentAt !== undefined && !replyScheduled.has(awaitingKey) && Date.parse(report.at) > Date.parse(sentAt);
      // Every report is an event: the hub decides whether it is conversation or only a step in the register (D-052).
      events.push({ kind: "report", project, report, ...(reply ? { reply: true } : {}) });
      if (reply) replyScheduled.add(awaitingKey);
    }
    state.seenReports[project.id] = [...seen].slice(-500);

    const claimed = await claimedCommits(project);
    const flagged = new Set(state.flaggedCommits[project.id] ?? []);
    const scheduled = new Set(flagged);
    const firstCommitSight = state.flaggedCommits[project.id] === undefined;
    const cutoff = options.now.getTime() - options.unreportedAfterMinutes * 60_000;

    const trees = ((state.treesSeen ??= {})[project.id] ??= {});
    const nowIso = options.now.toISOString();
    // The last pass over this project's commits. Before this field existed (an upgrade), the window an unreported commit
    // waits in, and an hour more: what waits is still told, older history is not.
    const passedAt = state.commitsPassAt?.[project.id] ?? new Date(options.now.getTime() - (options.unreportedAfterMinutes + 60) * 60_000).toISOString();
    const treeList = await worktrees(project.root);
    for (const tree of treeList) {
      const here: Project = { ...project, workRoot: tree.path };
      // Commits only: what is uncommitted is not the watcher's business, and `git status` in every worktree is costly.
      const activity = await activitySince(here, project.config.initializedAt, claimed, { dirty: false });
      const key = `${tree.path}\u0000${tree.branch ?? ""}`;
      if (firstCommitSight) {
        // A project's first sight: whatever exists is history, however recent.
        for (const c of activity.commits) flagged.add(c.shortSha);
        trees[key] = { since: nowIso, last: nowIso };
        continue;
      }
      if (trees[key] === undefined) {
        // A worktree or branch new since the last pass — added, checked out, realigned: what was authored before that
        // pass is history; what was authored after is new work like any other, told when it is due.
        trees[key] = { since: passedAt, last: nowIso };
        for (const c of activity.commits) if (Date.parse(c.at) < Date.parse(passedAt) - 60_000) flagged.add(c.shortSha);
      }
      trees[key]!.last = nowIso;
      // A minute's slack: git dates are to the second.
      const since = Date.parse(trees[key]!.since) - 60_000;
      const stale = activity.commits.filter(
        (c) => !scheduled.has(c.shortSha) && !MERGE.test(c.subject) && Date.parse(c.at) <= cutoff && Date.parse(c.at) >= since,
      );
      for (const c of stale) scheduled.add(c.shortSha);
      if (stale.length) events.push({ kind: "unreported", project, branch: tree.branch, commits: stale });
    }
    // Kept short: the dates above, not this list, keep old commits out — it was this list's cap that made them come back
    // in waves once it dropped them.
    state.flaggedCommits[project.id] = [...flagged].slice(-1000);
    // Worktrees and branches not seen for 30 days are forgotten, so the list does not grow for ever. Not sooner: a branch
    // switched away and back, a rebase in progress or a `git worktree list` that failed once would otherwise be dated anew.
    for (const [key, seen] of Object.entries(trees)) if (options.now.getTime() - Date.parse(seen.last) > 30 * 86_400_000) delete trees[key];
    (state.commitsPassAt ??= {})[project.id] = nowIso;
  }
  return events;
}

/** Mark an event consumed only after it was sent, queued, or intentionally muted. */
export function acknowledge(state: HubState, event: HubEvent): void {
  if (event.kind === "report") {
    const seen = new Set(state.seenReports[event.project.id] ?? []);
    seen.add(event.report.file);
    state.seenReports[event.project.id] = [...seen].slice(-500);
    if (event.reply) delete state.awaiting[`${event.project.id}:${event.report.agent}`];
    return;
  }
  const flagged = new Set(state.flaggedCommits[event.project.id] ?? []);
  for (const commit of event.commits) flagged.add(commit.shortSha);
  state.flaggedCommits[event.project.id] = [...flagged].slice(-1000);
}
