import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activitySince } from "../core/activity.ts";
import type { Commit } from "../core/git.ts";
import { loadProject, type Project } from "../core/project.ts";
import { readRegistry } from "../core/registry.ts";
import { claimedCommits, PUSH_STATUSES, readReports, type Report } from "../core/report.ts";
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
  const out = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }).then(
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
      if (reply || PUSH_STATUSES.includes(report.status) || report.handoffs.length) {
        events.push({ kind: "report", project, report, ...(reply ? { reply: true } : {}) });
        if (reply) replyScheduled.add(awaitingKey);
      } else seen.add(report.file);
    }
    state.seenReports[project.id] = [...seen].slice(-500);

    const claimed = await claimedCommits(project);
    const flagged = new Set(state.flaggedCommits[project.id] ?? []);
    const scheduled = new Set(flagged);
    const firstCommitSight = state.flaggedCommits[project.id] === undefined;
    const cutoff = options.now.getTime() - options.unreportedAfterMinutes * 60_000;

    for (const tree of await worktrees(project.root)) {
      const here: Project = { ...project, workRoot: tree.path };
      const activity = await activitySince(here, project.config.initializedAt, claimed);
      if (firstCommitSight) {
        // Baseline: whatever exists when the hub first looks is history, however recent.
        for (const c of activity.commits) flagged.add(c.shortSha);
        continue;
      }
      const stale = activity.commits.filter(
        (c) => !scheduled.has(c.shortSha) && !MERGE.test(c.subject) && Date.parse(c.at) <= cutoff,
      );
      for (const c of stale) scheduled.add(c.shortSha);
      if (stale.length) events.push({ kind: "unreported", project, branch: tree.branch, commits: stale });
    }
    state.flaggedCommits[project.id] = [...flagged].slice(-1000);
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
