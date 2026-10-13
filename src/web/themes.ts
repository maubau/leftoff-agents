import { THEMES, themeIndexes } from "./public/office.js";

/**
 * Each project's room theme, decided once and kept in the hub's state (D-056): until now the panel worked it out from
 * the list of projects, so adding one could refurnish the others. The first time, today's layout is frozen as it is;
 * a project that comes later takes the first theme nobody has, or one from its id when all are taken.
 * Returns whether anything was added, so the caller knows to save.
 */
export function settleThemes(saved: Record<string, number>, ids: readonly string[]): boolean {
  const missing = ids.filter((id) => saved[id] === undefined);
  if (missing.length === 0) return false;
  if (Object.keys(saved).length === 0) {
    const today = themeIndexes(ids);
    for (const id of ids) saved[id] = today.get(id) ?? 0;
    return true;
  }
  for (const id of [...missing].sort()) {
    const used = new Set(Object.values(saved));
    const free = THEMES.findIndex((_, i) => !used.has(i));
    saved[id] = free >= 0 ? free : (themeIndexes([id]).get(id) ?? 0);
  }
  return true;
}

export const THEME_COUNT = THEMES.length;
