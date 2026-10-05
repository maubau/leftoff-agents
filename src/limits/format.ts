import { localParts } from "../hub/clock.ts";
import { LOCALES, messages, type Lang } from "../i18n/index.ts";
import type { LimitWindow } from "./types.ts";

/** "alle 21:30 (tra 2h 10m)", "domani alle 09:05", or null when the reset is unknown. */
export function whenText(resetsAt: number | null, now: number, timezone: string, lang: Lang): string | null {
  if (resetsAt === null) return null;
  const m = messages(lang).limits;
  const locale = LOCALES[lang];
  const hhmm = new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(resetsAt);
  const today = localParts(new Date(now), timezone).day;
  const day = localParts(new Date(resetsAt), timezone).day;
  const tomorrow = localParts(new Date(now + 86_400_000), timezone).day;
  let when: string;
  if (day === today) when = m.atTime(hhmm);
  else if (day === tomorrow) when = m.tomorrowAt(hhmm);
  else {
    const date = new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(resetsAt);
    when = m.dateAt(date, hhmm);
  }
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  const rel = minutes >= 60 * 36 ? "" : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
  return rel ? m.inRel(when, rel) : when;
}

export function windowName(w: LimitWindow, lang: Lang): string {
  const product = w.account ? `${w.product} (${w.account})` : w.product;
  return w.label ? messages(lang).limits.windowName(product, w.label) : product;
}

/** The stand-up line: only windows worth a glance. */
export function limitsSummary(windows: readonly LimitWindow[], now: number, lang: Lang, minPercent = 50): string | null {
  const parts: string[] = [];
  for (const product of [...new Set(windows.map((w) => w.product))]) {
    const shown = windows
      .filter((w) => w.product === product)
      // A window that already reset is empty again, whatever the log last said.
      .map((w) => ({ w, used: w.resetsAt !== null && w.resetsAt <= now ? 0 : w.usedPercent }))
      .filter(({ w, used }) => w.reached || (used !== null && used >= minPercent));
    if (shown.length === 0) continue;
    const text = shown
      .map(({ w, used }) => `${w.label ? `${w.label} ` : ""}${w.reached ? messages(lang).limits.limitReached : `${Math.round(used ?? 0)}%`}`)
      .join(" · ");
    parts.push(`${product} ${text}`);
  }
  if (parts.length === 0) return null;
  return `${messages(lang).limits.summaryTitle}: ${parts.join(" · ")}`;
}
