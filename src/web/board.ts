import { isAfter, ms } from "../core/time.ts";
import type { Report } from "../core/report.ts";
import type { Snapshot } from "../core/snapshot.ts";

/**
 * The sprint view: what is waiting, being worked on, stuck, and finished. It is derived, not
 * kept — from Backlog.md when the project has one, and from what the agents themselves reported
 * (their `next`, `doing`, `blocked` and `done`) when it has not. Nothing here is typed in by hand,
 * so the board can never disagree with the PM.
 */
export type Column = "todo" | "doing" | "blocked" | "done";

export interface Card {
  id: string;
  title: string;
  column: Column;
  agent: string | null;
  /** When the report (or nothing, for a backlog task) that put it here was written. */
  at: string | null;
  source: "backlog" | "report";
  /** Report file it came from, relative to the repo, for the drill-down. */
  ref?: string;
  /** The agent's own words on a blocker: the question and what it recommends. */
  detail?: string;
}

export interface Board {
  todo: Card[];
  doing: Card[];
  blocked: Card[];
  done: Card[];
  /** `done` is capped; this is how many there were before the cap. */
  doneTotal: number;
}

const DONE_WINDOW_DAYS = 7;
const DONE_CAP = 15;
const TODO_CAP = 20;

const norm = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * `resumed`: agents that are working again since they last reported — their last question or blocker
 * was almost certainly answered (in Paseo, where the owner is), so it is not a card any more.
 */
export function buildBoard(snapshot: Snapshot, now = new Date(), resumed: ReadonlySet<string> = new Set()): Board {
  // A retired agent is history: what it finished still counts, what it left open is nobody's plan.
  const open = snapshot.agents.filter((a) => !a.retired && a.last).map((a) => ({ agent: a.id, r: a.last! }));
  const cards: Card[] = [];
  const taken = new Set<string>();
  const add = (card: Card): void => {
    const key = `${card.column}:${norm(card.title)}`;
    if (!norm(card.title) || taken.has(key)) return;
    taken.add(key);
    cards.push(card);
  };

  // Backlog.md is the owner's own plan: it wins over what an agent happens to call the same thing.
  const columnOf = { todo: "todo", doing: "doing", done: "done" } as const;
  for (const [key, tasks] of Object.entries(snapshot.tasks) as Array<[keyof typeof columnOf, Snapshot["tasks"]["todo"]]>) {
    for (const t of tasks) {
      add({ id: `task:${t.id}`, title: t.title, column: columnOf[key], agent: t.assignee[0] ?? null, at: null, source: "backlog", ref: t.file });
    }
  }

  // Reports are snapshots: only each agent's latest says what is happening *now*.
  const reports = [...snapshot.reports].sort((a, b) => ms(b.at) - ms(a.at));
  const sinceDone = now.getTime() - DONE_WINDOW_DAYS * 86_400_000;
  const doneKeys = new Set<string>();
  for (const r of reports) {
    if (ms(r.at) < sinceDone) continue;
    r.done.forEach((title, i) => {
      doneKeys.add(norm(title));
      add({ id: `${r.file}#done${i}`, title, column: "done", agent: r.agent, at: r.at, source: "report", ref: r.file });
    });
  }

  for (const { agent, r } of open) {
    const mk = (title: string, column: Column, i: number, extra: Partial<Card> = {}): Card => ({ id: `${r.file}#${column}${i}`, title, column, agent, at: r.at, source: "report", ref: r.file, ...extra });
    const waiting = r.status === "blocked" || r.status === "needs_input";
    if (!resumed.has(agent)) {
      r.blocked.forEach((t, i) => add(mk(t, "blocked", i, i === 0 && r.question ? { detail: questionText(r) } : {})));
      // A question with no stated blocker is still a thing standing in the way.
      if (waiting && r.blocked.length === 0 && r.question) add(mk(r.question.text, "blocked", 0, { detail: questionText(r) }));
    }
    r.doing.forEach((t, i) => {
      if (!doneKeys.has(norm(t))) add(mk(t, "doing", i));
    });
    r.next.forEach((t, i) => {
      if (!doneKeys.has(norm(t))) add(mk(t, "todo", i));
    });
  }

  const by = (column: Column) => cards.filter((c) => c.column === column);
  const done = by("done").sort((a, b) => (a.at && b.at ? (isAfter(a.at, b.at) ? -1 : 1) : a.at ? -1 : 1));
  return {
    todo: by("todo").slice(0, TODO_CAP),
    doing: by("doing"),
    blocked: by("blocked"),
    done: done.slice(0, DONE_CAP),
    doneTotal: done.length,
  };
}

function questionText(r: Report): string {
  const q = r.question;
  if (!q) return "";
  const lines = [q.text, ...q.options.map((o, i) => `${i + 1}. ${o}`)];
  if (q.recommend) lines.push(`→ ${q.recommend}`);
  return lines.join("\n");
}
