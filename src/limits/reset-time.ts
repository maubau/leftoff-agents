import { localParts } from "../hub/clock.ts";

/**
 * Best-effort: when does a usage limit lift, from the text Claude Code shows
 * ("… resets 3pm (Europe/Rome)", "resets in 2h 15m", "resets at 15:30").
 * The StopFailure payload is not documented, so this reads whatever text
 * arrives and returns null rather than guess; the hub then waits for the next
 * successful turn instead.
 */
const MINUTE = 60_000;

function atWallClock(now: number, timezone: string, hours: number, minutes: number): number {
  // Next occurrence of hh:mm in `timezone`, found by stepping minute by minute
  // from the current local time — no time-zone library, and DST-safe.
  const { minutes: nowMinutes } = localParts(new Date(now), timezone);
  const target = hours * 60 + minutes;
  const delta = (target - nowMinutes + 1440) % 1440 || 1440;
  return now - (now % MINUTE) + delta * MINUTE;
}

export function parseResetTime(text: string, now: number, timezone: string): number | null {
  if (!text) return null;

  const relative = /\bin\s+(?:(\d+)\s*(?:h|hr|hrs|hours?|ore?)\b)?\s*(?:(\d+)\s*(?:m|min|mins|minutes?|minuti?)\b)?/i.exec(text);
  if (relative && (relative[1] || relative[2])) {
    return now + (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * MINUTE;
  }

  const epoch = /\b(1[5-9]\d{8})\b/.exec(text);
  if (epoch?.[1]) return Number(epoch[1]) * 1000;

  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(text);
  if (iso?.[1]) {
    const parsed = Date.parse(iso[1]);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const clock = /\bresets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clock?.[1]) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
    // The zone Claude names (e.g. "(Europe/Rome)") wins over ours when it is valid.
    const named = /\(([A-Za-z]+\/[A-Za-z_]+)\)/.exec(text)?.[1];
    let zone = timezone;
    if (named) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: named });
        zone = named;
      } catch {
        /* unknown zone name: keep ours */
      }
    }
    return atWallClock(now, zone, hours, minutes);
  }
  return null;
}
