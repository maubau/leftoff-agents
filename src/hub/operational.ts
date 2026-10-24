import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../core/config.ts";
import { configRoot } from "../core/paths.ts";
import type { Project } from "../core/project.ts";

/**
 * The operational PM (D-064): a Paseo agent the PM delegates projects to. It is told what the owner writes in a
 * delegated project's thread and, rationed, what happens there; it answers through `leftoff pm say` and reaches
 * the other agents only through `leftoff pm ask`, which becomes a handoff waiting for the owner's «sì» like any
 * other (D-041). Leftoff only sends it messages, as to any agent.
 */

export interface OpsTarget {
  /** The project the operational PM's Paseo agent belongs to. */
  project: Project;
  agentId: string;
}

/** The configured operational PM, when it is an agent of a project the chat may know of (never a private one). */
export function opsTarget(config: Config, projects: readonly Project[]): OpsTarget | null {
  const { project: projectId, agent: agentId } = config.pm.operational;
  if (!projectId || !agentId) return null;
  const project = projects.find((p) => p.id === projectId);
  if (!project || project.config.visibility === "private") return null;
  const agent = project.config.agents.find((a) => a.id === agentId && !a.retired);
  return agent ? { project, agentId } : null;
}

/** Is this project followed by the operational PM? A private project never is. */
export function isDelegated(config: Config, project: Project): boolean {
  return project.config.visibility !== "private" && Boolean(config.pm.operational.agent) && config.pm.operational.projects.includes(project.id);
}

/** What the operational PM hands back: a word for the owner, or an ask for a teammate. */
export type OutboxEntry =
  | { at: string; project: string; kind: "say"; text: string }
  | { at: string; project: string; kind: "ask"; to: string; text: string };

export const opsOutbox = () => join(configRoot(), "ops-outbox.jsonl");

export async function appendOutbox(entry: OutboxEntry): Promise<void> {
  await mkdir(dirname(opsOutbox()), { recursive: true, mode: 0o700 });
  await appendFile(opsOutbox(), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** The lines after `from`, and where the next read starts. A damaged line is skipped, not fatal. */
export async function readOutbox(from: number): Promise<{ entries: OutboxEntry[]; next: number }> {
  const lines = (await readFile(opsOutbox(), "utf8").catch(() => "")).split("\n").filter((l) => l.trim());
  // The file was replaced or emptied: start again from its top.
  const start = from > lines.length ? 0 : from;
  const entries: OutboxEntry[] = [];
  for (const line of lines.slice(start)) {
    try {
      const e = JSON.parse(line) as OutboxEntry;
      if (typeof e.project === "string" && typeof e.text === "string" && (e.kind === "say" || (e.kind === "ask" && typeof e.to === "string"))) entries.push(e);
    } catch {
      /* a half-written line */
    }
  }
  return { entries, next: lines.length };
}
