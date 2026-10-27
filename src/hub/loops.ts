import type { Report } from "../core/report.ts";

/**
 * The loop guard's eyes (D-069): four signals of work going round in circles, each a pure function of what the hub
 * already holds — reports, the handoffs it passed on, what it waits for, CI runs read with `gh`. They say what they see;
 * the hub decides what the owner hears, one level at a time.
 */

export type LoopKind = "question" | "review" | "waiting" | "ci";

export interface LoopSignal {
  /** One episode: the same key while the same thing goes on. */
  key: string;
  kind: LoopKind;
  projectId: string;
  /** The agent it is about, when there is one (a review loop is about a pull request). */
  agent?: string;
  /** What goes round: the question, the pull request, the teammate waited for, the branch. */
  subject: string;
  /** How much evidence: repeats, handoffs, hours waited, runs. More of it is what moves the ladder. */
  count: number;
  since: string;
  /** For the waiting signal: the teammate, and whether its session is closed. */
  other?: string;
}

const HOUR = 3_600_000;
export const QUESTION_REPEATS = 3;
export const QUESTION_WINDOW_MS = 48 * HOUR;
export const REVIEW_HANDOFFS = 6;
export const REVIEW_WINDOW_MS = 24 * HOUR;
export const WAITING_AFTER_MS = 3 * HOUR;
export const CI_RUNS = 10;
export const CI_BRANCH_RUNS = 6;
export const CI_WINDOW_MS = 2 * HOUR;

/** Words as an agent would repeat them: case, punctuation and spacing aside. */
export function sameWords(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** An agent that asks the same question in QUESTION_REPEATS reports within QUESTION_WINDOW_MS. */
export function repeatedQuestions(projectId: string, reports: readonly Report[], now: number): LoopSignal[] {
  const groups = new Map<string, { agent: string; text: string; ats: string[] }>();
  for (const r of reports) {
    const text = r.question?.text;
    if (!text || now - Date.parse(r.at) > QUESTION_WINDOW_MS) continue;
    const words = sameWords(text);
    if (!words) continue;
    const id = `${r.agent}\u0000${words}`;
    const g = groups.get(id) ?? { agent: r.agent, text, ats: [] };
    g.ats.push(r.at);
    groups.set(id, g);
  }
  return [...groups.values()]
    .filter((g) => g.ats.length >= QUESTION_REPEATS)
    .map((g) => ({
      key: `question:${projectId}:${g.agent}:${sameWords(g.text).slice(0, 80)}`,
      kind: "question" as const,
      projectId,
      agent: g.agent,
      subject: g.text,
      count: g.ats.length,
      since: g.ats.sort()[0]!,
    }));
}

/** A handoff the hub saw: who asked whom, for what, when. */
export interface HandoffSeen {
  projectId: string;
  from: string;
  to: string;
  ask: string;
  at: string;
}

/** The pull requests an ask names: «#123», «PR 123», «pull request 123». */
export function pullRequestsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:#|\bPR\s*#?|\bpull request\s*#?)(\d{1,6})\b/gi)) found.add(m[1]!);
  return [...found];
}

/** Handoffs naming the same pull request REVIEW_HANDOFFS times within REVIEW_WINDOW_MS: rounds of review and fix. */
export function reviewRounds(projectId: string, seen: readonly HandoffSeen[], now: number): LoopSignal[] {
  const byPr = new Map<string, HandoffSeen[]>();
  for (const h of seen) {
    if (h.projectId !== projectId || now - Date.parse(h.at) > REVIEW_WINDOW_MS) continue;
    for (const pr of pullRequestsIn(h.ask)) byPr.set(pr, [...(byPr.get(pr) ?? []), h]);
  }
  return [...byPr.entries()]
    .filter(([, hs]) => hs.length >= REVIEW_HANDOFFS)
    .map(([pr, hs]) => ({
      key: `review:${projectId}:${pr}`,
      kind: "review" as const,
      projectId,
      subject: `#${pr}`,
      count: hs.length,
      since: hs.map((h) => h.at).sort()[0]!,
      other: [...new Set(hs.flatMap((h) => [h.from, h.to]))].join(", "),
    }));
}

/** A teammate asked by a handoff, delivered WAITING_AFTER_MS ago, that has not reported since. `count` is hours waited. */
export function waitingAnswers(
  projectId: string,
  pending: ReadonlyArray<{ asker: string; target: string; deliveredAt: string; targetReportedAt?: string }>,
  now: number,
): LoopSignal[] {
  return pending
    .filter((p) => now - Date.parse(p.deliveredAt) > WAITING_AFTER_MS && !(p.targetReportedAt && Date.parse(p.targetReportedAt) > Date.parse(p.deliveredAt)))
    .map((p) => ({
      key: `waiting:${projectId}:${p.asker}:${p.target}:${p.deliveredAt}`,
      kind: "waiting" as const,
      projectId,
      agent: p.asker,
      subject: p.target,
      count: Math.floor((now - Date.parse(p.deliveredAt)) / HOUR),
      since: p.deliveredAt,
      other: p.target,
    }));
}

/** A CI run as `gh run list --json createdAt,headBranch` gives it. */
export interface CiRun {
  createdAt: string;
  headBranch: string;
}

/** CI_RUNS runs in a repository within CI_WINDOW_MS, or CI_BRANCH_RUNS on one branch. `count` is the runs in the window. */
export function ciStorm(projectId: string, runs: readonly CiRun[], now: number): LoopSignal[] {
  const recent = runs.filter((r) => now - Date.parse(r.createdAt) <= CI_WINDOW_MS);
  const byBranch = new Map<string, CiRun[]>();
  for (const r of recent) byBranch.set(r.headBranch, [...(byBranch.get(r.headBranch) ?? []), r]);
  const [busiest, onIt] = [...byBranch.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [undefined, []];
  if (recent.length < CI_RUNS && onIt.length < CI_BRANCH_RUNS) return [];
  const branch = onIt.length >= CI_BRANCH_RUNS ? busiest : undefined;
  return [
    {
      key: `ci:${projectId}`,
      kind: "ci" as const,
      projectId,
      subject: branch ?? "",
      count: recent.length,
      since: recent.map((r) => r.createdAt).sort()[0]!,
    },
  ];
}

/** «github.com/owner/repo» from a remote URL, ssh or https; undefined when it is not GitHub. */
export function githubSlug(remote: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}
