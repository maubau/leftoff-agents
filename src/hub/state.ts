import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configRoot } from "../core/paths.ts";
import type { NotifyLevel } from "../core/config.ts";
import type { Lang } from "../i18n/index.ts";
import type { LimitMemory } from "../limits/types.ts";

/**
 * What the hub has already seen and said. Losing it costs one burst of
 * "already known" events at most — on a fresh state the hub marks everything
 * existing as seen rather than replaying history to the owner.
 */
export interface HubState {
  version: 1;
  /** Report files already turned into events, per project. */
  seenReports: Record<string, string[]>;
  /** Commit shas already flagged as unreported, per project. */
  flaggedCommits: Record<string, string[]>;
  /** projectId → ISO time until which it is muted. */
  mutes: Record<string, string>;
  /** One draft instruction per chat thread, waiting for the owner's yes. */
  proposals: Record<string, Proposal>;
  /** `<project>:<agent>` → when an instruction was sent; its next report is pushed as the answer. */
  awaiting: Record<string, string>;
  /** When instructions were sent in the last 24 h, for the daily ceiling. */
  sent: string[];
  /** `<project>:<agent>` → when the PM last asked it for a status update. */
  statusAsked: Record<string, string>;
  /** Who asked: the owner through the PM (`pm`), or the hub on its own initiative (`auto`). Decides if the answer is pushed. */
  statusAskedBy: Record<string, "pm" | "auto">;
  /** When status updates were asked for in the last 24 h, for their own ceiling. */
  asks: string[];
  /** What the owner has already been told about each subscription window. */
  limits: Record<string, LimitMemory>;
  /** Set with /voce; overrides `voice.speak.mode` until changed again. */
  speak?: "mirror" | "always" | "never";
  /** Set with /lingua; overrides `language` from config.yaml until changed again. */
  language?: Lang;
  /** Set with /avvisi (/alerts); overrides `notify.level` from config.yaml until changed again. */
  notifyLevel?: NotifyLevel;
  /** Set with /quiet; overrides the configured quiet-hours default. */
  quietHoursEnabled?: boolean;
  /** Agents to wake as soon as the subscription window resets. */
  resumeTargets: ResumeTarget[];
  /** Local day (YYYY-MM-DD) of the last stand-up sent. */
  lastStandup?: string;
  /** Restarts already done, one key per episode and session, so a limit that stays "reached" never restarts the same agent twice. */
  resumeServed: string[];
  /**
   * Messages held back (quiet hours, or until the channel is back), sent later.
   * `about` lists the projects the text reveals: visibility is checked again at
   * send time, because a project can turn private while its notice waits.
   */
  queued: Array<{ projectId: string | null; text: string; at: string; key?: string; about?: string[] }>;
  /** Work agents asked of teammates (D-036): waiting to be shown, or shown and waiting for the owner's yes. */
  handoffs: PendingHandoff[];
  /** `<project>:<agent>` → the teammate whose request it was sent, so its next report is told as the answer to it. */
  handoffReplies: Record<string, string>;
  /**
   * Projects the owner made autonomous (D-041): what they ask for, and teammates' handoffs, go out without
   * waiting for a yes. Absent means control, the default. Kept here, on the owner's machine, and not in
   * project.yaml: a repository is written by agents too, and none of them may grant itself autonomy.
   */
  modes: Record<string, "autonomous">;
  /** A chat request to make a project autonomous, waiting for the owner's yes in the thread it was asked in. */
  modeRequests: Record<string, { projectId: string; expiresAt: string }>;
  /**
   * Messages for agents that were working when they were sent (D-042): `paseo send` to a working agent
   * interrupts its turn, so they wait here and go out when Paseo lists the agent as idle.
   */
  deliveryQueue: QueuedDelivery[];
}

export interface QueuedDelivery {
  id: string;
  projectId: string;
  agentId: string;
  /** The Paseo session it is for, as it was when queued. */
  paseoAgent: string;
  /** Exactly what the agent will read: already redacted. */
  text: string;
  kind: "command" | "handoff" | "status";
  queuedAt: string;
  /** A teammate's ask: the answer goes back to this agent. */
  handoffFrom?: string;
  /** Tell the owner when it goes out (instructions and handoffs; not status questions). */
  notify: boolean;
  /** Paseo refused it this many times; after a few it goes to the inbox. */
  tries?: number;
}

export type ProjectMode = "control" | "autonomous";

export function projectMode(state: Pick<HubState, "modes">, projectId: string): ProjectMode {
  return state.modes[projectId] === "autonomous" ? "autonomous" : "control";
}

export interface PendingHandoff {
  /** `<project>:<report file>#<n>`: one per ask, so a report read twice queues nothing twice. */
  id: string;
  projectId: string;
  /** The agent that asked, and the teammate it is for. */
  from: string;
  to: string;
  ask: string;
  /** Exactly what the teammate will read if the owner approves: already redacted. */
  prompt: string;
  /** The report it came from, relative to the repo. */
  report: string;
  createdAt: string;
  /**
   * Set when the owner has been shown it in the project's thread. Only then is it approvable, until
   * `expiresAt`; one per project at a time, so a «sì» can only mean the last thing shown.
   */
  shownAt?: string;
  expiresAt?: string;
}

export interface ResumeTarget {
  windowId: string;
  product: string;
  /** The limit episode this restart belongs to (see Hub#episode). */
  episode?: string;
  /**
   * Identifies "this agent, in this episode" from what the source itself reported — not from the
   * link looked up later — so a reading that keeps saying "limit reached" can never arm the same
   * agent again under a newer identity once it has been served.
   */
  serveKey?: string;
  projectId: string;
  projectRoot: string;
  agentId: string;
  /**
   * The exact Paseo session that was stopped, snapshotted when the limit was seen.
   * The project's link can later point at a different session (a new report rebinds
   * it), and a restart for the stopped one must never land on that other session.
   * Absent: the stopped agent was not run by Paseo, so only its inbox is used.
   */
  paseoAgent?: string;
  sessionId?: string;
  /** Known reset time; null waits for an explicit "available again" signal. */
  resumeAt: number | null;
  armedAt: string;
}

const file = () => join(configRoot(), "hub-state.json");

export interface Proposal {
  id: string;
  projectId: string;
  agentId: string;
  /** Exactly what will be sent if the owner approves: already redacted. */
  prompt: string;
  /** One sentence, in the owner's language. */
  summary: string;
  createdAt: string;
  expiresAt: string;
  /** The project whose own thread it was drafted in (null: General). A handoff is not shown there meanwhile. */
  threadProject?: string | null;
  /** It replaces a teammate's handoff the owner asked to change: its answer goes back as that teammate's. */
  handoffFrom?: string;
  /** An autonomous project, yet this one waits for a yes (D-041): it looks irreversible, or the owner did not ask for it. */
  hold?: "risky" | "initiative";
}

export function emptyState(): HubState {
  return { version: 1, seenReports: {}, flaggedCommits: {}, mutes: {}, limits: {}, proposals: {}, awaiting: {}, sent: [], statusAsked: {}, statusAskedBy: {}, asks: [], resumeTargets: [], resumeServed: [], queued: [], handoffs: [], handoffReplies: {}, modes: {}, modeRequests: {}, deliveryQueue: [] };
}

export async function loadState(): Promise<HubState | null> {
  const raw = await readFile(file(), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    return { ...emptyState(), ...(JSON.parse(raw) as Partial<HubState>) };
  } catch {
    return null;
  }
}

/** Write-then-rename, so a crash never leaves a half-written state file. */
export async function saveState(state: HubState): Promise<void> {
  const target = file();
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 1), "utf8");
  await rename(tmp, target);
}

export function isMuted(state: HubState, projectId: string, now = new Date()): boolean {
  const until = state.mutes[projectId];
  return until !== undefined && Date.parse(until) > now.getTime();
}
