// A colour per project (D-070, «Your tasks»): the same project has the same colour everywhere. It follows the room's
// theme the hub decided once for each project (D-056), so two projects never share one while there are tints enough;
// without a theme, it comes from the id. Ten tints, none red (red is «Urgent»), readable in light and dark; the
// project's name is always written on it.

export const PROJECT_COLORS = 10;

/** The room's theme when the hub gave one; else FNV-1a of the id, folded to one of the tints. */
export function projectColor(id, theme) {
  if (Number.isInteger(theme) && theme >= 0) return theme % PROJECT_COLORS;
  let hash = 2166136261;
  for (const ch of String(id ?? "")) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % PROJECT_COLORS;
}

export const projectTagClass = (id, theme) => `ptag pc${projectColor(id, theme)}`;
