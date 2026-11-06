// A newer panel (#134): the hub says its version on every SSE connection and on every API answer. The page keeps the
// first one it saw; another one means the files changed under it, so it offers a reload that keeps what was typed.

/** The first version seen stays; a different, non-empty one later means a newer panel. An empty one says nothing. */
export function versionSeen(first, now) {
  if (typeof now !== "string" || !now) return { first: first ?? null, changed: false };
  if (!first) return { first: now, changed: false };
  return { first, changed: now !== first };
}

/** What is typed and not sent, kept across the reload in this tab only, for a few minutes. */
export const DRAFT_KEY = "leftoff_reload_drafts";
export const DRAFT_TTL = 10 * 60 * 1000;
const TEXT_MAX = 100_000;

export function writeDrafts({ hash = "", pm = "", task = null } = {}, now = Date.now()) {
  const keep = (t) => (typeof t === "string" && t.trim() ? t.slice(0, TEXT_MAX) : "");
  const taskText = task && typeof task.id === "string" ? keep(task.text) : "";
  if (!keep(pm) && !taskText) return null;
  return JSON.stringify({ at: now, hash: String(hash), pm: keep(pm), ...(taskText ? { task: { id: task.id, text: taskText } } : {}) });
}

/** The drafts kept for this page, or null: unreadable, too old, or for another page. */
export function readDrafts(raw, hash, now = Date.now()) {
  if (typeof raw !== "string" || !raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || typeof value.at !== "number" || now - value.at > DRAFT_TTL || now < value.at) return null;
  if (value.hash !== String(hash)) return null;
  const pm = typeof value.pm === "string" ? value.pm : "";
  const task = value.task && typeof value.task.id === "string" && typeof value.task.text === "string" ? { id: value.task.id, text: value.task.text } : null;
  return pm || task ? { pm, task } : null;
}
