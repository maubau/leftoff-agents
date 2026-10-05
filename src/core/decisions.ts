import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Project } from "./project.ts";

export interface Decision {
  at: string;
  /** Who made the call: the user, or the PM acting on a standing instruction. */
  by: "user" | "pm" | "agent";
  text: string;
  /** Free-form context: the agent asked, the options, why this one. */
  why?: string;
}

/**
 * `decisions.md` is append-only and human-first: it is the answer to
 * "come era andata con la scelta del calendario?" months later.
 */
export async function recordDecision(project: Project, decision: Decision): Promise<void> {
  await mkdir(dirname(project.paths.decisions), { recursive: true });
  const exists = await readFile(project.paths.decisions, "utf8").catch(() => null);
  const header =
    exists === null
      ? `# Decisions\n\nAppend-only log of what was decided, when and why.\nNewest entries at the bottom.\n`
      : "";
  const when = decision.at.slice(0, 16).replace("T", " ");
  const why = decision.why ? `\n  ${decision.why.replace(/\n/g, "\n  ")}` : "";
  await appendFile(
    project.paths.decisions,
    `${header}\n## ${when} — ${decision.by}\n\n${decision.text}${why}\n`,
    "utf8",
  );
}

export async function readDecisions(project: Project): Promise<string> {
  return (await readFile(project.paths.decisions, "utf8").catch(() => "")).trim();
}
