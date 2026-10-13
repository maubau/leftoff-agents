// The buttons a PM message came with in chat (Yes/No, an agent's options), shown under it in the panel too.
// Plain rules, no DOM, so they are tested in node like the rest.

/** The thread a feed entry belongs to: a project's id, or "general". */
export const threadOf = (entry) => entry.projectId ?? "general";

/**
 * Which messages show their buttons: in each thread only the last one that has any, and only until the owner writes
 * again there (a tap is the owner writing). A reply given in Telegram is left without: what waits for its «sì» waits in
 * Telegram's thread, so a «yes» from here would not reach it. What the PM said first (a handoff, an agent's options) and
 * what it answered here are kept.
 */
export function liveChoices(feed) {
  const last = new Map();
  for (const entry of feed) {
    if (!entry) continue;
    const thread = threadOf(entry);
    if (entry.role === "owner") last.delete(thread);
    else if (entry.role === "pm" && Array.isArray(entry.choices) && entry.choices.length) last.set(thread, entry);
  }
  const live = new Set();
  for (const entry of last.values()) if (entry.kind === "push" || entry.source === "web") live.add(entry.id);
  return live;
}

/** The buttons of an entry, as far as they can be said: a label and a reply that are both text. */
export function choicesOf(entry) {
  return (entry?.choices ?? []).filter((c) => c && typeof c.label === "string" && typeof c.reply === "string" && c.reply.trim());
}

/** What a chip of an agent's question says, as Telegram's button does: «<agent>: <option>». */
export const optionReply = (agentName, option) => `${agentName}: ${option}`;
