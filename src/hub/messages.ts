import type { Commit } from "../core/git.ts";
import type { Project } from "../core/project.ts";
import type { Report } from "../core/report.ts";
import type { Snapshot } from "../core/snapshot.ts";
import { displayName } from "../core/agents.ts";
import { LOCALES, messages, type Lang } from "../i18n/index.ts";

/**
 * Every message the hub sends on its own initiative, rendered from structured
 * reports (D-016). Facts in, sentences out — nothing here can invent status.
 */

export const agentName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
const list = (items: readonly string[], lang: Lang) => {
  const and = messages(lang).report.and;
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;
};

function question(report: Report, lang: Lang): string[] {
  const q = report.question;
  if (!q) return [];
  const lines = [q.text];
  q.options.forEach((option, i) => lines.push(`${i + 1}. ${option}`));
  if (q.recommend) lines.push(messages(lang).report.recommends(q.recommend));
  return lines;
}

function extras(report: Report, lang: Lang): string[] {
  const m = messages(lang).report;
  const out: string[] = [];
  if (report.decisions.length) out.push(m.decisions(report.decisions.join("; ")));
  if (report.findings.length) out.push(m.findings(report.findings.join("; ")));
  return out;
}

export function reportMessage(report: Report, lang: Lang, name?: string): string {
  const m = messages(lang).report;
  const who = name ?? agentName(report.agent);
  const where = report.branch && !["main", "master"].includes(report.branch) ? ` (${report.branch})` : "";
  const label = `${who}${where}`;
  const lines: string[] = [];

  switch (report.status) {
    case "done":
      lines.push(m.finished(label, list(report.done, lang) || m.taskFallback));
      lines.push(...extras(report, lang));
      if (report.next.length) lines.push(m.next(report.next.join("; ")));
      else lines.push(m.nowIdle);
      break;
    case "blocked":
      lines.push(m.blocked(label, list(report.blocked, lang) || m.noReason));
      lines.push(...question(report, lang));
      if (report.done.length) lines.push(m.doneSoFar(report.done.join("; ")));
      break;
    case "needs_input":
      lines.push(m.needsYou(label));
      if (report.question) lines.push(...question(report, lang));
      else if (report.next.length) lines.push(m.nextStep(report.next.join("; ")));
      if (report.done.length) lines.push(m.done(report.done.join("; ")));
      lines.push(...extras(report, lang));
      break;
    case "idle":
      lines.push(m.idle(label, list(report.done, lang)));
      lines.push(report.next.length ? m.suggests(report.next.join("; ")) : m.whatShouldItDo);
      break;
    case "progress":
      lines.push(`🔄 ${label}: ${list(report.done.length ? report.done : report.doing, lang)}`);
      break;
  }
  return lines.join("\n");
}

import type { Reachability } from "../agents/delivery.ts";

function reachLine(reach: Reachability, lang: Lang, mode: "draft" | "sent"): string {
  const m = messages(lang).delivery;
  if (reach.via === "paseo") {
    if (mode === "draft") return reach.busy ? m.draftBusy : m.draftIdle;
    return reach.busy ? m.sentBusy : m.sentIdle;
  }
  return m.unreachable(m.reason(reach.reason));
}

/** The draft exactly as it will be sent, so approving it is approving the real text. */
export function draftMessage(
  draft: { agentName: string; projectName: string; prompt: string; ttlMinutes: number },
  reach: Reachability,
  lang: Lang,
): string {
  const m = messages(lang).delivery;
  return [
    m.draftHeader(draft.agentName, draft.projectName),
    reachLine(reach, lang, "draft"),
    "────────",
    draft.prompt,
    "────────",
    m.approveHint(draft.ttlMinutes),
  ].join("\n");
}

export function sentMessage(agentName: string, projectName: string, reach: Reachability, lang: Lang): string {
  const m = messages(lang).delivery;
  const icon = reach.via === "paseo" ? "✅" : "📥";
  return `${icon} ${m.sent(agentName, projectName)} ${reachLine(reach, lang, "sent")} ${m.willTell}`;
}

export function unreportedMessage(branch: string | null, commits: readonly Commit[], lang: Lang): string {
  const m = messages(lang).unreported;
  const shown = commits.slice(0, 3).map((c) => `• ${c.shortSha} ${c.subject}`);
  if (commits.length > 3) shown.push(m.andMore(commits.length - 3));
  return [m.head(commits.length, branch), ...shown, m.askSummary].join("\n");
}

function daysAgo(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}

export function standupMessage(
  rows: Array<{ project: Project; snapshot: Snapshot; reportsLastDay: number }>,
  /** `devUsd: null` when no host reported a cost — subscriptions do not. */
  spend: { devUsd: number | null; pmUsd: number },
  now: Date,
  lang: Lang,
  timezone: string,
): string {
  const m = messages(lang).standup;
  const weekday = new Intl.DateTimeFormat(LOCALES[lang], { weekday: "long", timeZone: timezone }).format(now);
  const lines = [m.title(weekday)];

  for (const { project, snapshot, reportsLastDay } of rows) {
    const name = project.config.name;
    const current = snapshot.agents.filter((a) => !a.retired);
    const latest = (current.find((a) => a.last) ?? snapshot.agents.find((a) => a.last))?.last;
    if (!latest || !snapshot.lastActivityAt) {
      lines.push(`• ${name}: ${m.noReports}`);
      continue;
    }
    const idleDays = daysAgo(snapshot.lastActivityAt, now);
    const waiting = current.filter((a) => a.last && ["blocked", "needs_input"].includes(a.last.status));
    const parts: string[] = [];
    if (reportsLastDay) parts.push(m.reportsLastDay(reportsLastDay));
    else if (idleDays >= 1) parts.push(m.quietDays(idleDays));
    for (const a of waiting) {
      const ask = a.last?.question?.text ?? a.last?.blocked[0] ?? a.last?.next[0];
      parts.push(`${a.last?.status === "blocked" ? "⛔" : "❓"} ${displayName(project, a.id)}${ask ? `: ${ask}` : ""}`);
    }
    if (!waiting.length && latest.next[0]) parts.push(`${m.next}: ${latest.next[0]}`);
    const unreported = snapshot.agents.reduce((n, a) => n + a.unreportedCommits.length, 0);
    if (unreported) parts.push(m.unreportedCommits(unreported));
    lines.push(`• ${name}: ${parts.join(" · ") || m.nothingNew}`);
  }

  const dev = spend.devUsd === null ? m.notReported : m.usd(spend.devUsd);
  lines.push(m.spend(dev, m.usd(spend.pmUsd)));
  return lines.join("\n");
}
