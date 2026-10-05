import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "./project.ts";

const BEGIN = "<!-- leftoff:begin -->";
const END = "<!-- leftoff:end -->";

/** The instructions files Leftoff maintains a block in, in preference order. */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * The protocol snippet. It is the contract with every agent, including hosts
 * that have no hooks at all, so it must stand on its own.
 */
export function protocolBlock(project: Project): string {
  return [
    BEGIN,
    "## Leftoff: reporting protocol",
    "",
    "This project is managed with Leftoff. A project manager reads what you write here",
    "and tells the human owner where things stand. Two duties, both cheap:",
    "",
    "**1. Report at the end of every turn that changed something, decided something,",
    "or learned something the owner will want to know.**",
    "",
    "```bash",
    "leftoff report --status <progress|done|blocked|needs_input|idle> \\",
    '  --done "outcome you finished" \\',
    '  --doing "what is half done" \\',
    '  --decided "a choice made, and why" \\',
    '  --found "something learned worth remembering" \\',
    '  --blocked "what is stopping you" \\',
    '  --next "what should happen next"',
    "```",
    "",
    "- Each flag repeats, once per item; all but `--status` are optional. Under 15 words",
    "  each, outcomes not steps, in the language the owner writes to you in.",
    "- A turn that only researched or discussed still deserves a report if it produced",
    "  decisions (`--decided`) or findings (`--found`). Pure chit-chat does not.",
    "- `done` means the assigned task is finished, not merely that the turn ended.",
    "- `blocked` / `needs_input` mean you genuinely cannot continue alone. Add the question:",
    '  `--question "..." --option "A" --option "B" --recommend "A"`.',
    "- Never invent progress. An honest `progress` report beats an optimistic `done`.",
    "",
    "**2. Read your inbox at the start of every turn.**",
    "",
    "```bash",
    "leftoff inbox",
    "```",
    "",
    "It prints decisions the owner made while you were not running. Treat them as",
    "instructions with priority over your current plan, and acknowledge them in your",
    "next report. On Claude Code and Codex this is injected automatically, so you only",
    "need to run it by hand on other hosts.",
    "",
    `Project: **${project.config.name}**${project.config.purpose ? ` — ${project.config.purpose}` : ""}`,
    END,
  ].join("\n");
}

/** Remove the Leftoff block from a file's text, for comparing what else changed. */
export function stripProtocol(text: string): string {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return text.trim();
  return `${text.slice(0, start)}${text.slice(end + END.length)}`.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The protocol in brief, injected at every session start. The AGENTS.md block
 * only reaches an agent on a branch that has it committed — and Paseo agents
 * work on their own branches in their own worktrees — so the hook is what
 * actually guarantees every agent knows the deal.
 */
export function sessionBriefing(project: Project, agentId: string): string {
  return [
    `## Leftoff — this project (${project.config.name}) is managed`,
    "",
    "Your human works with you like with a team and often reads your updates on their phone,",
    "days later. At the end of any turn that changed files, made a decision, or learned",
    "something worth keeping, run:",
    "",
    `  leftoff report --agent ${agentId} --status <progress|done|blocked|needs_input|idle> \\`,
    '    [--done "…"] [--doing "…"] [--decided "choice, and why"] [--found "…"] [--blocked "…"] [--next "…"]',
    "",
    "Items under 15 words, outcomes not steps, in the language the owner writes to you in.",
    'Need the owner? `--status needs_input --question "…" --option "A" --option "B" --recommend "A"`.',
    "Messages from the owner appear here at the start of a turn; they take priority.",
  ].join("\n");
}

/** Insert or refresh the Leftoff block without disturbing the rest of the file. */
export async function upsertProtocol(project: Project, filename: string): Promise<"created" | "updated" | "unchanged"> {
  const file = join(project.root, filename);
  const existing = (await readFile(file, "utf8").catch(() => null)) ?? "";
  const block = protocolBlock(project);

  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    const next = existing.slice(0, start) + block + existing.slice(end + END.length);
    if (next === existing) return "unchanged";
    await writeFile(file, next, "utf8");
    return "updated";
  }
  const body = existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
  await writeFile(file, body, "utf8");
  return existing.trim() ? "updated" : "created";
}

export async function removeProtocol(project: Project, filename: string): Promise<boolean> {
  const file = join(project.root, filename);
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing === null) return false;
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start === -1 || end === -1) return false;
  await writeFile(file, `${existing.slice(0, start).trimEnd()}\n${existing.slice(end + END.length).trimStart()}`, "utf8");
  return true;
}
