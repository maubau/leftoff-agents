import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configRoot } from "../core/paths.ts";
import type { Lang } from "../i18n/index.ts";
import type { ClaudeAccount } from "./claude.ts";
import { windowLabel } from "./codex.ts";
import type { LimitWindow } from "./types.ts";

/**
 * Claude Code's own usage of the subscription, as it hands it to the status line command: the 5-hour and the weekly
 * window, each with the share used and when it resets. It is the only place Claude Code gives these numbers; sessions
 * run by Paseo have no status line, so they come from the owner's own terminal sessions (D-060).
 */
export interface ClaudeUsage {
  fiveHour?: { percent: number; resetsAt: number };
  sevenDay?: { percent: number; resetsAt: number };
  observedAt: number;
  /** The account's name, so an account known only from its readings is still named («Work»). */
  account?: string;
  /** Where it came from: Claude Code's status line, or Paseo's daemon (D-060). */
  source?: "statusline" | "paseo";
}

const usageFile = (account: ClaudeAccount) => join(configRoot(), "limits", account.slug ? `claude-${account.slug}-usage.json` : "claude-usage.json");

/** The two windows from the status line's input, or null when it has none (an API key, an older Claude Code). */
export function usageFrom(input: unknown, now: number): ClaudeUsage | null {
  const limits = (input as { rate_limits?: Record<string, unknown> } | null)?.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const one = (raw: unknown) => {
    const w = raw as { used_percentage?: unknown; resets_at?: unknown } | undefined;
    if (typeof w?.used_percentage !== "number" || typeof w.resets_at !== "number") return undefined;
    return { percent: Math.max(0, Math.min(100, w.used_percentage)), resetsAt: w.resets_at * 1000 };
  };
  const fiveHour = one(limits.five_hour);
  const sevenDay = one(limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), observedAt: now };
}

export async function readClaudeUsage(account: ClaudeAccount): Promise<ClaudeUsage | null> {
  try {
    return JSON.parse(await readFile(usageFile(account), "utf8")) as ClaudeUsage;
  } catch {
    return null;
  }
}

/**
 * Kept when something changed, or a minute has passed: Claude Code calls the status line often, and a write each time
 * would be wasted work.
 */
export async function recordClaudeUsage(usage: ClaudeUsage, account: ClaudeAccount): Promise<void> {
  const previous = await readClaudeUsage(account);
  // Two sources, one file: an older reading never replaces a newer one.
  if (previous && previous.observedAt > usage.observedAt) return;
  const same = (a?: { percent: number; resetsAt: number }, b?: { percent: number; resetsAt: number }) => a?.percent === b?.percent && a?.resetsAt === b?.resetsAt;
  if (previous && same(previous.fiveHour, usage.fiveHour) && same(previous.sevenDay, usage.sevenDay) && usage.observedAt - previous.observedAt < 60_000) return;
  const target = usageFile(account);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...usage, ...(account.label ? { account: account.label } : {}) }), "utf8");
  await rename(tmp, target);
}

/** The windows still running at `now`, as the panel and the alerts show Codex's: a reading past its reset says nothing. */
export function usageWindows(usage: ClaudeUsage | null, account: ClaudeAccount, now: number, language: Lang): LimitWindow[] {
  if (!usage) return [];
  const out: LimitWindow[] = [];
  for (const [minutes, w] of [[300, usage.fiveHour], [10080, usage.sevenDay]] as const) {
    if (!w || w.resetsAt <= now) continue;
    out.push({
      id: `${account.slug ? `claude:${account.slug}` : "claude"}:${minutes}`,
      product: "Claude Code",
      label: windowLabel(minutes, language),
      ...(account.label ? { account: account.label } : {}),
      usedPercent: w.percent,
      resetsAt: w.resetsAt,
      reached: w.percent >= 100,
      observedAt: usage.observedAt,
    });
  }
  return out;
}

/** What the status line shows: the share used of each window, «5 ore 46% · settimana 15%». */
export function statusText(usage: ClaudeUsage | null, language: Lang): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.fiveHour) parts.push(`${windowLabel(300, language)} ${Math.round(usage.fiveHour.percent)}%`);
  if (usage.sevenDay) parts.push(`${windowLabel(10080, language)} ${Math.round(usage.sevenDay.percent)}%`);
  return parts.join(" · ");
}
