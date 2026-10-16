import { localParts } from "../hub/clock.ts";

/**
 * Best-effort: when does a usage limit lift, from the text Claude Code shows
 * ("… resets 3pm (Europe/Rome)", "resets in 2h 15m", "resets at 15:30").
 * The StopFailure payload is not documented, so this reads whatever text
 * arrives and returns null rather than guess; the hub then waits for the next
 * successful turn instead.
 */
const MINUTE = 60_000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The instant a wall-clock date and time names in `timezone`: start from it read as UTC, then move by how far that
 * instant's local time is from the one wanted, twice (once more for a DST change in between).
 */
function atWallDate(year: number, month: number, day: number, hours: number, minutes: number, timezone: string): number {
  const wanted = Date.UTC(year, month, day, hours, minutes);
  let at = wanted;
  for (let i = 0; i < 2; i++) {
    const local = localParts(new Date(at), timezone);
    const [y, m, d] = local.day.split("-").map(Number) as [number, number, number];
    at += wanted - Date.UTC(y, m - 1, d, Math.floor(local.minutes / 60), local.minutes % 60);
  }
  return at;
}

/** «resets Oct 16, 1am», as Claude Code says it for a weekly limit: the next such date, in the zone it names. */
function atDate(text: string, now: number, zone: string): number | null {
  const m = /\bresets?\s*(?:on\s*)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  if (month < 0) return null;
  let hours = Number(m[3]);
  const minutes = Number(m[4] ?? 0);
  const meridiem = m[5]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  const day = Number(m[2]);
  if (hours > 23 || minutes > 59 || day < 1 || day > 31) return null;
  const year = Number(localParts(new Date(now), zone).day.slice(0, 4));
  const at = atWallDate(year, month, day, hours, minutes, zone);
  // «Jan 2» read in late December is next year's.
  return at < now - 30 * 86_400_000 ? atWallDate(year + 1, month, day, hours, minutes, zone) : at;
}

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

  const dated = atDate(text, now, namedZone(text, timezone));
  if (dated !== null) return dated;

  const clock = /\bresets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clock?.[1]) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
    return atWallClock(now, namedZone(text, timezone), hours, minutes);
  }
  return null;
}

/** The zone Claude names (e.g. "(Europe/Rome)") when it is a valid one, else ours. */
function namedZone(text: string, timezone: string): string {
  const named = /\(([A-Za-z]+\/[A-Za-z_]+)\)/.exec(text)?.[1];
  if (!named) return timezone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: named });
    return named;
  } catch {
    return timezone;
  }
}
