import { saveProject } from "../core/project.ts";
import { detectHost, ensureAgent, resolveAgent } from "../core/agents.ts";
import { relative } from "node:path";
import { activitySince } from "../core/activity.ts";
import { recordDecision } from "../core/decisions.ts";
import { currentBranch } from "../core/git.ts";
import { UserError } from "../core/errors.ts";
import {
  claimedCommits,
  latestReport,
  parseHandoff,
  ReportSchema,
  writeReport,
  STATUSES,
  type ReportData,
  type Status,
} from "../core/report.ts";
import { buildSnapshot } from "../core/snapshot.ts";
import { writeState } from "../core/render.ts";
import { usageFromTranscript } from "../core/transcript.ts";
import type { Project } from "../core/project.ts";
import type { HostId } from "../hosts/types.ts";

export interface ReportOptions {
  agent?: string;
  host?: string;
  status: string;
  done: string[];
  doing: string[];
  blocked: string[];
  next: string[];
  found?: string[];
  decided?: string[];
  question?: string;
  option: string[];
  recommend?: string;
  handoff?: string[];
  body?: string;
  transcript?: string;
  session?: string;
  costUsd?: number;
  model?: string;
  at?: string;
}

function asHost(value: string | undefined): HostId | "other" {
  return value === "claude-code" || value === "codex" ? value : "other";
}

export async function report(
  project: Project,
  options: ReportOptions,
): Promise<{ file: string; data: ReportData }> {
  const status = STATUSES.find((s) => s === options.status);
  if (!status) {
    throw new UserError(`Unknown status "${options.status}"`, `Use one of: ${STATUSES.join(", ")}`);
  }
  const handoffs = (options.handoff ?? []).map((raw) => {
    const parsed = parseHandoff(raw);
    if (!parsed) throw new UserError(`Cannot read --handoff "${raw}"`, 'Write it as "<teammate>: <what you need>", e.g. --handoff "main-dev: expose GET /api/bookings".');
    return parsed;
  });
  const host = options.host ? asHost(options.host) : detectHost();
  const session = options.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CODEX_THREAD_ID;
  const paseoAgent = process.env.PASEO_AGENT_ID;
  // Named on the command line, the agent is what it says; otherwise it is the workspace it works in.
  const resolved = options.agent ? { id: options.agent } : await resolveAgent(project, host);
  const agentId = resolved.id;
  const at = options.at ?? new Date().toISOString();

  // Attribute to this report everything that happened since the agent's last one.
  const previous = await latestReport(project, agentId);
  const activity = await activitySince(project, previous?.at, await claimedCommits(project));

  const branch = await currentBranch(project.workRoot);
  const inWorktree = project.workRoot !== project.root;

  const usage = options.transcript ? await usageFromTranscript(options.transcript) : {};
  if (options.costUsd !== undefined) usage.costUsd = options.costUsd;
  if (options.model) usage.model = options.model;

  const data = ReportSchema.parse({
    agent: agentId,
    host,
    at,
    status,
    done: options.done,
    doing: options.doing,
    blocked: options.blocked,
    next: options.next,
    findings: options.found ?? [],
    decisions: options.decided ?? [],
    question: options.question
      ? {
          text: options.question,
          options: options.option,
          ...(options.recommend ? { recommend: options.recommend } : {}),
        }
      : null,
    handoffs,
    commits: activity.commits.map((c) => c.shortSha),
    filesChanged: activity.dirtyFiles.length,
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(session ? { sessionId: session } : {}),
    ...(paseoAgent ? { paseoAgent } : {}),
    ...(branch ? { branch } : {}),
    ...(inWorktree ? { worktree: project.workRoot } : {}),
  } satisfies Partial<ReportData> & { status: Status });

  const file = await writeReport(project, data, options.body ?? "");

  // decisions.md is where "come era andata la scelta di…?" gets answered months
  // later, so an agent's choices go there too, attributed and linked to the report.
  for (const text of data.decisions) {
    await recordDecision(project, {
      at: data.at,
      by: "agent",
      text,
      why: `${data.agent}${data.branch ? ` on ${data.branch}` : ""} — ${relative(project.root, file)}`,
    });
  }

  // An agent that reports is an agent worth tracking; register it once, silently.
  const identity = "workspace" in resolved ? { ...(resolved.workspace ? { workspace: resolved.workspace } : {}), ...(resolved.label ? { label: resolved.label } : {}) } : {};
  if (ensureAgent(project, agentId, host, paseoAgent, identity)) await saveProject(project.root, project.config);

  await writeState(await buildSnapshot(project));
  return { file, data };
}
