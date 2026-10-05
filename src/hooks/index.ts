import { resolveAgentId } from "../core/agents.ts";
import { activitySince } from "../core/activity.ts";
import { enqueue, markDelivered, pending, renderForAgent } from "../core/inbox.ts";
import { tryResolveProject, type Project } from "../core/project.ts";
import { sessionBriefing } from "../core/protocol.ts";
import { claimedCommits, latestReport } from "../core/report.ts";
import { buildSnapshot } from "../core/snapshot.ts";
import { writeState } from "../core/render.ts";
import type { HostId } from "../hosts/types.ts";
import { additionalContext, block, emit, proceed } from "./output.ts";
import { parseNotifyArg, readStdinPayload, type HookPayload } from "./payload.ts";
import { findingsNudge, reportNudge } from "./report-prompt.ts";
import { currentClaudeAccount, recordClaudeLimit, recordClaudeOk } from "../limits/claude.ts";
import { loadConfig } from "../core/config.ts";
import { currentTurn, isSubstantial } from "../core/transcript.ts";
import { isAfter } from "../core/time.ts";

/**
 * Hooks run inside someone else's turn. They must never throw, never hang and
 * never print anything a host could mistake for a decision: a broken Leftoff
 * must degrade to "no project management", not to "the agent cannot work".
 */
async function projectFor(cwd: string | undefined): Promise<Project | null> {
  return tryResolveProject(cwd ?? process.cwd());
}

/** SessionStart / UserPromptSubmit on either host: brief the agent and hand it its inbox. */
async function deliverInbox(host: HostId, event: string, payload: HookPayload): Promise<string> {
  const project = await projectFor(payload.cwd);
  if (!project) return proceed;
  const agentId = await resolveAgentId(project, host);
  const parts: string[] = [];
  if (event === "SessionStart") parts.push(sessionBriefing(project, agentId));

  const messages = await pending(project, agentId);
  if (messages.length > 0) {
    await markDelivered(
      project,
      agentId,
      messages.map((m) => m.id),
    );
    parts.push(renderForAgent(messages));
  }
  return parts.length ? additionalContext(event, parts.join("\n\n")) : proceed;
}

/**
 * Claude Code Stop: block the turn once if it went unreported — because it
 * changed the project, or because it did enough research that it probably
 * learned or decided something the owner will want to know.
 */
async function stop(payload: HookPayload): Promise<string> {
  // A turn that ends normally proves the subscription limit, if any, has lifted.
  // Account-wide (this Claude Code account, not the other one on the machine), so before and regardless of any project lookup.
  await recordClaudeOk(Date.now(), await currentClaudeAccount()).catch(() => undefined);

  // Claude Code sets this once we have already blocked; blocking again loops forever.
  if (payload.stop_hook_active) return proceed;

  const project = await projectFor(payload.cwd);
  if (!project) return proceed;
  const agentId = await resolveAgentId(project, "claude-code");
  const last = await latestReport(project, agentId);
  const activity = await activitySince(project, last?.at, await claimedCommits(project));
  if (activity.changed) return block(reportNudge(activity, agentId));

  // Nothing changed on disk. A read-only turn can still carry findings and
  // decisions — that is a team member's most useful update — so ask, once,
  // when the turn was busy enough to have produced any.
  if (!payload.transcript_path) return proceed;
  const turn = await currentTurn(payload.transcript_path);
  if (!isSubstantial(turn)) return proceed;
  if (last && turn.startedAt && isAfter(last.at, turn.startedAt)) return proceed;
  return block(findingsNudge(turn, agentId));
}

/**
 * Claude Code StopFailure: the turn ended on an API error. Only a usage limit
 * matters here; the payload is undocumented beyond `error`, so the raw text is
 * kept for the parser. Never blocks and never prints.
 */
async function stopFailure(payload: HookPayload): Promise<string> {
  if (payload.error !== "rate_limit") return proceed;
  const timezone = (await loadConfig().catch(() => null))?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const project = await projectFor(payload.cwd);
  const target = project
    ? {
        projectRoot: project.root,
        projectId: project.id,
        agentId: await resolveAgentId(project, "claude-code"),
        // Which session this was, so the restart goes to it and not to a later one.
        ...(process.env.PASEO_AGENT_ID ? { paseoAgent: process.env.PASEO_AGENT_ID } : {}),
        ...(typeof payload.session_id === "string" ? { sessionId: payload.session_id } : {}),
      }
    : undefined;
  await recordClaudeLimit(
    payload as { error?: string; error_details?: unknown; last_assistant_message?: string },
    Date.now(),
    timezone,
    target,
    await currentClaudeAccount(),
  );
  return proceed;
}

/**
 * Codex end of turn. `notify` is fire-and-forget — it cannot block the turn or
 * inject context — so instead of nagging in place we queue a reminder that the
 * UserPromptSubmit hook delivers at the start of the next turn.
 */
async function codexNotify(arg: string | undefined): Promise<string> {
  const payload = parseNotifyArg(arg);
  if (payload.type && payload.type !== "agent-turn-complete") return proceed;
  const project = await projectFor(payload.cwd);
  if (!project) return proceed;

  const agentId = await resolveAgentId(project, "codex");
  const last = await latestReport(project, agentId);
  const activity = await activitySince(project, last?.at, await claimedCommits(project));

  if (activity.changed) {
    const already = (await pending(project, agentId)).some((m) => m.text.startsWith("[leftoff]"));
    if (!already) {
      await enqueue(
        project,
        agentId,
        `[leftoff] Your last turn changed the project but wrote no report. ` +
          `Before anything else, run \`leftoff report --agent ${agentId} --status <status> ...\` ` +
          `describing that turn, then carry on with what is asked below.`,
        "pm",
      );
    }
  }
  await writeState(await buildSnapshot(project)).catch(() => undefined);
  return proceed;
}

/** Codex SessionEnd: refresh STATE.md so the repo is accurate even after a crash. */
async function sessionEnd(payload: HookPayload): Promise<string> {
  const project = await projectFor(payload.cwd);
  if (!project) return proceed;
  await writeState(await buildSnapshot(project)).catch(() => undefined);
  return proceed;
}

export async function runHook(host: string, event: string, argv: readonly string[]): Promise<number> {
  try {
    if (host === "codex" && event === "notify") {
      emit(await codexNotify(argv[0]));
      return 0;
    }
    const payload = await readStdinPayload();
    const hostId = host as HostId;

    switch (event) {
      case "stop":
        emit(await stop(payload));
        return 0;
      case "stop-failure":
        emit(await stopFailure(payload));
        return 0;
      case "subagent-stop":
        // Sub-agents see a slice of the turn; the main agent reports for the whole.
        // Kept as a no-op so hooks installed by older versions stay harmless.
        return 0;
      case "session-start":
        emit(await deliverInbox(hostId, "SessionStart", payload));
        return 0;
      case "user-prompt-submit":
        emit(await deliverInbox(hostId, "UserPromptSubmit", payload));
        return 0;
      case "session-end":
        emit(await sessionEnd(payload));
        return 0;
      default:
        return 0;
    }
  } catch (error) {
    // Exit 0 regardless: a hook failure must not become the agent's problem.
    process.stderr.write(`leftoff hook ${host}/${event} failed: ${(error as Error).message}\n`);
    return 0;
  }
}
