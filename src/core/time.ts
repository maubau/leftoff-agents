/**
 * Timestamps reach Leftoff from several sources with different offsets: git
 * writes `+02:00`, `new Date().toISOString()` writes `Z`, agents may pass either.
 * Lexicographic comparison silently gets these wrong, so every ordering question
 * goes through here.
 */
export function ms(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

export function isAfter(a: string, b: string): boolean {
  return ms(a) > ms(b);
}

export function isBefore(a: string, b: string): boolean {
  return ms(a) < ms(b);
}

/** Newest first. */
export function byNewest(a: { at: string }, b: { at: string }): number {
  return ms(b.at) - ms(a.at);
}
