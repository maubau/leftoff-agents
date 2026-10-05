import type { Activity } from "../core/activity.ts";
import { describeActivity } from "../core/activity.ts";
import type { Turn } from "../core/transcript.ts";

const COMMAND = (agentId: string) => [
  "```bash",
  `leftoff report --agent ${agentId} --status <progress|done|blocked|needs_input|idle> \\`,
  '  --done "what you finished" \\',
  '  --doing "what is half done" \\',
  '  --decided "a choice made, and why" \\',
  '  --found "something learned worth remembering" \\',
  '  --blocked "what is stopping you, if anything" \\',
  '  --next "what should happen next"',
  "```",
];

const RULES = [
  "Rules:",
  "- Every flag repeats, once per item, and every flag is optional except --status.",
  "  Keep each item under 15 words, in the language the owner writes to you in,",
  "  and describe outcomes, not the steps you took.",
  "- `--decided` is for choices that shape the project (scope, stack, approach),",
  "  including ones the owner made in this conversation. Say why in a few words.",
  "- `--found` is for what you learned that someone picking this up later needs.",
  "- If you need the owner, use `--status needs_input` with",
  '  `--question "..." --option "A" --option "B" --recommend "A"`.',
  "- Use `--status done` only when the task you were given is finished.",
  "- Report what is true. Do not commit anything just to make this pass.",
];

/**
 * The text an agent sees when it tried to end a turn without reporting. It has
 * to be unambiguous and self-contained: the agent may have no memory of Leftoff,
 * and this is the only chance to get a report out of the turn.
 */
export function reportNudge(activity: Activity, agentId: string): string {
  const what = describeActivity(activity);
  const commits = activity.commits.slice(0, 5).map((c) => `${c.shortSha} ${c.subject}`);
  return [
    `This turn changed the project (${what}) but you have not written a Leftoff report.`,
    "",
    "Write one now, then finish. It is one command, and it is how your human — who",
    "works with you like with a team, often from their phone, days later — finds out",
    "where things stand, what was decided, and what you need from them.",
    "",
    ...COMMAND(agentId),
    "",
    ...RULES,
    ...(commits.length ? ["", "Commits in this turn:", ...commits.map((c) => `- ${c}`)] : []),
  ].join("\n");
}

/** A busy turn that changed nothing on disk: ask for findings, but let it pass. */
export function findingsNudge(turn: Turn, agentId: string): string {
  const research = [...new Set(turn.tools.filter((t) => ["WebSearch", "WebFetch", "Agent", "Task"].includes(t)))];
  const what = research.length ? `research (${research.join(", ")})` : `${turn.tools.length} tool calls`;
  return [
    `This turn did ${what} but changed no files, and nothing was reported to Leftoff.`,
    "",
    "If it produced findings, decisions, or a question for your human, record them",
    "now — otherwise they survive only in this conversation, which nobody rereads:",
    "",
    ...COMMAND(agentId),
    "",
    ...RULES,
    "",
    "If this turn was only conversation with nothing worth keeping, just finish.",
    "You will not be asked again for this turn.",
  ].join("\n");
}
