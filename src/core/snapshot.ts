import { commitsSince, status as gitStatus, type Commit, type GitStatus } from "./git.ts";
import { workDirtyFiles } from "./activity.ts";
import { isDone, isInProgress, isTodo, readTasks, type Task } from "./backlog.ts";
import { latestPerAgent, readReports, type Report, type Status } from "./report.ts";
import { pending as pendingInbox, type InboxMessage } from "./inbox.ts";
import { byNewest, isAfter } from "./time.ts";
import type { Project } from "./project.ts";
import { readNow, type Now } from "./now.ts";

export interface AgentSnapshot {
  id: string;
  /** Replaced by workspace agents (see AgentSchema.retired): history only. */
  retired: boolean;
  /** `last` is the report of a retired agent that this one took the session over from, not its own. */
  inherited?: boolean;
  control: "inbox" | "paseo";
  host: "claude-code" | "codex" | "other";
  last?: Report;
  /** Commits made after the agent's last report: work it never told us about. */
  unreportedCommits: Commit[];
  pendingInbox: InboxMessage[];
  /** Its current turn, or the last one, when it is newer than its last report (D-043). */
  now?: Now;
}

export interface Snapshot {
  project: Project;
  generatedAt: string;
  git: GitStatus;
  /** Commits in the lookback window, newest first. */
  commits: Commit[];
  reports: Report[];
  agents: AgentSnapshot[];
  tasks: { todo: Task[]; doing: Task[]; done: Task[] };
  costUsd: number;
  /** Timestamp of the most recent report, if any. */
  lastActivityAt?: string;
  /** The most urgent thing standing between the project and progress. */
  headline: Status | "quiet";
}

const DAY_MS = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

const URGENCY: readonly Status[] = ["blocked", "needs_input", "idle", "done", "progress"];

/**
 * One read of everything Leftoff knows about a project. Every surface — STATE.md,
 * `leftoff brief`, the PM's read tools, the stand-up — renders this same object,
 * so they can never disagree about the facts.
 */
export async function buildSnapshot(project: Project, lookbackDays = 14): Promise<Snapshot> {
  const since = isoDaysAgo(lookbackDays);
  const [rawGit, commits, reports, byAgent, tasks, dirty] = await Promise.all([
    gitStatus(project.root),
    commitsSince(project.root, { date: since }),
    readReports(project, { since }),
    latestPerAgent(project),
    readTasks(project),
    workDirtyFiles(project.root),
  ]);
  // Leftoff's own bookkeeping is not "uncommitted work" anyone needs to hear about.
  const git: GitStatus = { ...rawGit, dirtyFiles: dirty.length };

  const agents: AgentSnapshot[] = [];
  const configured = new Map(project.config.agents.map((a) => [a.id, a]));
  const ids = new Set([...configured.keys(), ...byAgent.keys()]);

  for (const id of ids) {
    const declared = configured.get(id);
    const last = byAgent.get(id);
    const unreported = last ? commits.filter((c) => isAfter(c.at, last.at)) : commits;
    agents.push({
      id,
      retired: declared?.retired === true,
      control: declared?.control ?? "inbox",
      host: declared?.host ?? last?.host ?? "other",
      ...(last ? { last } : {}),
      unreportedCommits: unreported,
      pendingInbox: await pendingInbox(project, id),
    });
  }
  // What each agent is on now: a turn in progress always (its latest step is news even after a progress
  // report); a finished one only while it is newer than the last report, which otherwise says it better.
  for (const a of agents) {
    const now = await readNow(project, a.id).catch(() => undefined);
    if (now && (!now.ended || !a.last || isAfter(now.since, a.last.at))) a.now = now;
  }
  // A retired agent was often the *same session* under an older name: the workspace agent that took
  // its Paseo link carries on its work, so what it last said (blocked, open question, next steps) is
  // still that agent's current state until it reports for itself. Reports name their session.
  const heirOf = new Map<string, AgentSnapshot>();
  for (const a of agents) {
    const link = configured.get(a.id)?.paseoAgent;
    if (link && !a.retired) heirOf.set(link, a);
  }
  for (const old of agents) {
    if (!old.retired || !old.last?.paseoAgent) continue;
    const heir = heirOf.get(old.last.paseoAgent);
    if (!heir || (heir.last && !isAfter(old.last.at, heir.last.at))) continue;
    const taken = old.last;
    heir.last = taken;
    heir.inherited = true;
    heir.unreportedCommits = commits.filter((c) => isAfter(c.at, taken.at));
  }
  agents.sort((a, b) => byNewest({ at: a.last?.at ?? "" }, { at: b.last?.at ?? "" }));

  const costUsd = reports.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0);

  let headline: Snapshot["headline"] = "quiet";
  for (const status of URGENCY) {
    if (agents.some((a) => !a.retired && a.last?.status === status)) {
      headline = status;
      break;
    }
  }

  return {
    project,
    generatedAt: new Date().toISOString(),
    git,
    commits,
    reports,
    agents,
    tasks: {
      todo: tasks.filter(isTodo),
      doing: tasks.filter(isInProgress),
      done: tasks.filter(isDone),
    },
    costUsd,
    ...(reports[0] ? { lastActivityAt: reports[0].at } : {}),
    headline,
  };
}
