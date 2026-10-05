/** An agent whose turn a usage limit stopped, with the exact session when it is known. */
export interface StoppedAgent {
  projectRoot: string;
  projectId: string;
  agentId: string;
  /** The Paseo session that hit the limit (from PASEO_AGENT_ID, or the report that matched). */
  paseoAgent?: string;
  sessionId?: string;
}

/** One rolling usage window of a subscription (e.g. Codex's 5 hours, or its week). */
export interface LimitWindow {
  /** Stable key for alert bookkeeping: "codex:300", "codex:10080", "claude", "claude:work". */
  id: string;
  /** "Codex" / "Claude Code" */
  product: string;
  /** Human label: "5 ore", "settimana". Empty when the product has a single window. */
  label: string;
  /** Which subscription, when the product has several on this machine ("Work"). Absent for the default one. */
  account?: string;
  /** 0–100, or null when the source does not report it (Claude, from hooks). */
  usedPercent: number | null;
  /** When the window resets, epoch ms; null when unknown. */
  resetsAt: number | null;
  /** The product says the limit is hit right now. */
  reached: boolean;
  /** When this reading was taken, epoch ms. A reading can be old: Codex only logs while it runs. */
  observedAt: number;
  /** Session that produced the reading, when the host exposes it. */
  source?: { cwd: string; sessionId?: string };
  /** Agents known to have stopped on this exact limit episode. */
  targets?: StoppedAgent[];
}

export type AlertKind = "warn" | "reached" | "back";

export interface LimitAlert {
  kind: AlertKind;
  windowId: string;
  text: string;
}

/** Per-window memory of what the owner has already been told. */
export interface LimitMemory {
  /** The cycle (resetsAt, or a Claude event's `since`) the flags below belong to. */
  cycle: number | null;
  warned: boolean;
  reached: boolean;
}
