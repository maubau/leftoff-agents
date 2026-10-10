import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { enqueue } from "../core/inbox.ts";
import { configRoot } from "../core/paths.ts";
import { findAgent, type Project } from "../core/project.ts";

const execFileAsync = promisify(execFile);

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (file, args) => execFileAsync(file, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });

interface PaseoAgent {
  id: string;
  shortId: string;
  /** Paseo's own words: running, idle, closed… */
  status: string;
}

/** What delivery would do right now, for the draft shown to the owner. */
export type Reachability =
  | { via: "paseo"; busy: boolean }
  | { via: "inbox"; reason: string };

/** `queued`: the agent was working, so nothing was sent; the hub delivers it when the agent is idle (D-042). */
export type Delivery = Reachability & { agentId: string; queued?: boolean };

/** Every Paseo agent, with one call — for a pass over many agents. Empty when Paseo is unreachable. */
export async function listPaseoAgents(exec: ExecFn = defaultExec): Promise<PaseoAgent[]> {
  try {
    const { stdout } = await exec("paseo", ["ls", "--json"]);
    return JSON.parse(stdout) as PaseoAgent[];
  } catch {
    return [];
  }
}

export function findPaseoAgent(agents: readonly PaseoAgent[], paseoId: string): PaseoAgent | undefined {
  return agents.find((a) => a.id === paseoId || a.id.startsWith(paseoId) || a.shortId === paseoId);
}

async function paseoAgent(paseoId: string, exec: ExecFn): Promise<PaseoAgent | null> {
  try {
    const { stdout } = await exec("paseo", ["ls", "--json"]);
    const agents = JSON.parse(stdout) as PaseoAgent[];
    return agents.find((a) => a.id === paseoId || a.id.startsWith(paseoId) || a.shortId === paseoId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Can this agent be reached live? `paseo send` to an idle agent starts a new turn. To a running
 * agent it interrupts the current turn (Paseo 0.10.3: `activeTurnBehavior` defaults to "interrupt",
 * and the CLI cannot ask for "steer"; seen 2026-10-10, docs/paseo.md) — not, as first observed on
 * 2026-10-02, inside the turn. A closed agent cannot take it, so the message waits in the inbox instead.
 */
export async function reachability(project: Project, agentId: string, exec: ExecFn = defaultExec): Promise<Reachability> {
  const agent = findAgent(project, agentId);
  if (!agent) return { via: "inbox", reason: "agent unknown" };
  if (agent.control !== "paseo" || !agent.paseoAgent) return { via: "inbox", reason: "not run by Paseo" };
  const live = await paseoAgent(agent.paseoAgent, exec);
  if (!live) return { via: "inbox", reason: "Paseo does not list it, or is unreachable" };
  if (live.status === "closed") return { via: "inbox", reason: "the Paseo session is closed" };
  return { via: "paseo", busy: live.status === "running" };
}

/**
 * Send now. Only ever to an agent Paseo lists as idle: to a working one `paseo send` interrupts its turn
 * (D-042), so callers queue instead.
 */
export async function sendViaPaseo(paseoId: string, text: string, exec: ExecFn = defaultExec): Promise<boolean> {
  // A file, not an argument: prompts are long and full of characters shells like to eat.
  const dir = join(configRoot(), "tmp");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${randomUUID()}.txt`);
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  try {
    const { stdout } = await exec("paseo", ["send", paseoId, "--prompt-file", file, "--no-wait", "--json"]);
    return (JSON.parse(stdout) as { status?: string }).status === "sent";
  } catch {
    return false;
  } finally {
    await rm(file, { force: true });
  }
}

export type SessionDelivery = Delivery | { agentId: string; via: "none"; reason: string };

/**
 * Deliver to the one session that was stopped, and to no other. A restart is meant
 * for that session; the project's link can since have been rebound to a newer one
 * with a different job, and the inbox belongs to the logical agent, so it would be
 * read by whichever session starts next. Hence:
 *  - the session is known (`paseoAgent`): it is reached live, or nothing is sent;
 *  - it is not (the stopped agent was not run by Paseo): its inbox, and only that.
 */
export async function deliverToSession(
  project: Project,
  agentId: string,
  text: string,
  identity: { paseoAgent?: string },
  exec: ExecFn = defaultExec,
): Promise<SessionDelivery> {
  if (!identity.paseoAgent) {
    await enqueue(project, agentId, text, "user");
    return { agentId, via: "inbox", reason: "not run by Paseo" };
  }
  const live = await paseoAgent(identity.paseoAgent, exec);
  if (!live) return { agentId, via: "none", reason: "that session is not in Paseo any more, or Paseo is unreachable" };
  if (live.status === "closed") return { agentId, via: "none", reason: "that session is closed" };
  // Working again already (someone wrote to it): a restart would only interrupt it.
  if (live.status === "running") return { agentId, via: "none", reason: "it is already working again" };
  if (!(await sendViaPaseo(identity.paseoAgent, text, exec))) return { agentId, via: "none", reason: "Paseo refused the message" };
  return { agentId, via: "paseo", busy: live.status === "running" };
}

export type LiveAsk = { sent: true; busy: boolean; queued?: boolean } | { sent: false; reason: string };

/**
 * Say something to an agent that is reachable *right now*, or say nothing. Unlike an
 * instruction, a question ("how is it going?") has no value hours later in an inbox:
 * it would be read at the next session start, out of date, and add noise.
 */
export async function askLive(project: Project, agentId: string, text: string, exec: ExecFn = defaultExec): Promise<LiveAsk> {
  const reach = await reachability(project, agentId, exec);
  const agent = findAgent(project, agentId);
  if (reach.via !== "paseo" || !agent?.paseoAgent) return { sent: false, reason: reach.via === "inbox" ? reach.reason : "not reachable" };
  // Working: asking now would stop it. The hub queues the question for when its turn ends.
  if (reach.busy) return { sent: true, busy: true, queued: true };
  if (!(await sendViaPaseo(agent.paseoAgent, text, exec))) return { sent: false, reason: "Paseo refused the message" };
  return { sent: true, busy: false };
}

/**
 * Hand the owner's approved instruction to an agent: live through Paseo when it
 * can be reached, otherwise into its inbox, where the SessionStart and
 * UserPromptSubmit hooks deliver it at the next turn. Never both.
 */
export async function deliverToAgent(
  project: Project,
  agentId: string,
  text: string,
  exec: ExecFn = defaultExec,
): Promise<Delivery> {
  const reach = await reachability(project, agentId, exec);
  const agent = findAgent(project, agentId);
  // Working: sending now would interrupt its turn. Nothing is sent; the hub queues it (D-042).
  if (reach.via === "paseo" && reach.busy && agent?.paseoAgent) return { ...reach, agentId, queued: true };
  if (reach.via === "paseo" && agent?.paseoAgent) {
    if (await sendViaPaseo(agent.paseoAgent, text, exec)) return { ...reach, agentId };
    // Fall through to the inbox: an instruction the owner approved must not be lost.
    await enqueue(project, agentId, text, "user");
    return { agentId, via: "inbox", reason: "Paseo refused the message" };
  }
  await enqueue(project, agentId, text, "user");
  return { ...reach, agentId } as Delivery;
}
