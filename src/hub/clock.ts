/** Local wall-clock helpers in the configured timezone, without a date library. */
export function localParts(now: Date, timezone: string): { day: string; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: weekdays.indexOf(get("weekday")),
  };
}

export function toMinutes(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Quiet hours may wrap midnight (22:00 → 08:00). */
export function inQuietHours(now: Date, timezone: string, quiet: { start: string; end: string }): boolean {
  const { minutes } = localParts(now, timezone);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function standupDue(now: Date, timezone: string, at: string, lastDay: string | undefined): boolean {
  const { day, minutes } = localParts(now, timezone);
  return day !== lastDay && minutes >= toMinutes(at);
}
