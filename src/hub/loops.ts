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
  /** For the waiting signal: the teammate. For review rounds: who passed it. */
  other?: string;
  /** For the waiting signal: the awaited teammate's Paseo session is closed. */
  closed?: boolean;
}

const HOUR = 3_600_000;
export const QUESTION_REPEATS = 3;
export const QUESTION_WINDOW_MS = 48 * HOUR;
/** Round trips on one pull request: a handoff one way, then one back. Three of them in a day is a loop. */
export const REVIEW_ROUNDS = 3;
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

/**
 * Round trips on one pull request: in time order, each handoff that goes back the way the previous one came (A→B,
 * then B→A) closes a round. Six updates one way, however many, are not a loop: someone is being kept informed.
 */
export function roundTrips(handoffs: readonly HandoffSeen[]): number {
  const ordered = [...handoffs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let rounds = 0;
  let open: HandoffSeen | undefined;
  for (const h of ordered) {
    if (open && h.from === open.to && h.to === open.from) {
      rounds++;
      open = undefined;
    } else open = h;
  }
  return rounds;
}

/**
 * REVIEW_ROUNDS round trips on the same pull request, between the same two agents, within REVIEW_WINDOW_MS: review and
 * fix without end. Only a handoff about one pull request counts — one that names several is a status note, a
 * coordinator's summary, not a round — and never one to or from `coordinators` (the operational PM routes work, it does
 * not review it). Whether the pull request is still open is the hub's to check, with `gh`.
 */
export function reviewRounds(projectId: string, seen: readonly HandoffSeen[], now: number, coordinators: ReadonlySet<string> = new Set()): LoopSignal[] {
  const byPair = new Map<string, HandoffSeen[]>();
  for (const h of seen) {
    if (h.projectId !== projectId || now - Date.parse(h.at) > REVIEW_WINDOW_MS) continue;
    if (coordinators.has(h.from) || coordinators.has(h.to)) continue;
    const prs = pullRequestsIn(h.ask);
    if (prs.length !== 1) continue;
    const pair = [h.from, h.to].sort().join("\u0000");
    const id = `${prs[0]}\u0000${pair}`;
    byPair.set(id, [...(byPair.get(id) ?? []), h]);
  }
  const best = new Map<string, { hs: HandoffSeen[]; rounds: number }>();
  for (const [id, hs] of byPair) {
    const rounds = roundTrips(hs);
    const pr = id.slice(0, id.indexOf("\u0000"));
    if (rounds >= REVIEW_ROUNDS && rounds > (best.get(pr)?.rounds ?? 0)) best.set(pr, { hs, rounds });
  }
  return [...best.entries()].map(([pr, { hs, rounds }]) => ({
    // The pair is part of the episode: another pair on the same pull request is another loop, from its first level.
    key: `review:${projectId}:${pr}:${[...new Set(hs.flatMap((h) => [h.from, h.to]))].sort().join("+")}`,
    kind: "review" as const,
    projectId,
    subject: `#${pr}`,
    count: rounds,
    since: hs.map((h) => h.at).sort()[0]!,
    other: [...new Set(hs.flatMap((h) => [h.from, h.to]))].join(", "),
  }));
}

/** A teammate asked by a handoff, delivered WAITING_AFTER_MS ago, that has not reported since. `count` is hours waited. */
export function waitingAnswers(
  projectId: string,
  pending: ReadonlyArray<{ asker: string; target: string; deliveredAt: string; targetReportedAt?: string; closed?: boolean }>,
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
      ...(p.closed ? { closed: true } : {}),
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
