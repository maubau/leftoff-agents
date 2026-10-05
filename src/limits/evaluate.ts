import { messages, type Lang } from "../i18n/index.ts";
import { whenText, windowName } from "./format.ts";
import type { LimitAlert, LimitMemory, LimitWindow } from "./types.ts";

export interface EvaluateOptions {
  now: number;
  warnAtPercent: number;
  language: Lang;
  timezone: string;
}

/** A window "full" for Codex means 100%; allow for rounding in what it logs. */
const FULL = 99.5;
/** Two readings of one window can differ by a few seconds in resets_at. */
const SAME_CYCLE_MS = 120_000;

/** "usato l'83%", "83% used": the phrase belongs to the language, so it lives in its catalog. */
export function usedPhrase(percent: number, lang: Lang): string {
  return messages(lang).limits.used(percent);
}

/** Claude Code windows: "claude" is the default account, "claude:<account>" any other. */
export const isClaude = (id: string) => id === "claude" || id.startsWith("claude:");

const fresh = (): LimitMemory => ({ cycle: null, warned: false, reached: false });

/**
 * Turn the current readings into the few things worth telling — close to the
 * limit, at the limit, available again — exactly once per cycle. Pure apart
 * from updating `memory`, which the hub persists.
 */
export function evaluateLimits(
  windows: readonly LimitWindow[],
  memory: Record<string, LimitMemory>,
  options: EvaluateOptions,
): LimitAlert[] {
  const { now, language: lang, timezone } = options;
  const L = messages(lang).limits;
  const alerts: LimitAlert[] = [];
  const say = (kind: LimitAlert["kind"], windowId: string, text: string) => alerts.push({ kind, windowId, text });

  for (const w of windows) {
    const mem = (memory[w.id] ??= fresh());
    const name = windowName(w, lang);
    const when = whenText(w.resetsAt, now, timezone, lang);

    if (isClaude(w.id)) {
      // Claude reports episodes, not percentages: `observedAt` is when this one began.
      if (w.reached && mem.cycle !== w.observedAt) {
        mem.cycle = w.observedAt;
        mem.reached = true;
        say("reached", w.id, when ? L.reachedWhen(name, when) : L.reachedUnknown(name));
      } else if (w.reached && mem.reached && w.resetsAt !== null && now >= w.resetsAt) {
        // Nobody has tried since, but the time the message gave has passed.
        mem.reached = false;
        say("back", w.id, L.shouldBeBack(name, when ?? L.now));
      } else if (!w.reached && mem.reached) {
        mem.reached = false;
        say("back", w.id, L.back(name));
      }
      continue;
    }

    const expired = w.resetsAt !== null && w.resetsAt <= now;
    const newCycle = mem.cycle !== null && w.resetsAt !== null && w.resetsAt > mem.cycle + SAME_CYCLE_MS;
    if (expired || newCycle) {
      if (mem.reached) {
        say("back", w.id, L.windowReset(name));
      }
      memory[w.id] = fresh();
      if (expired) continue;
    }
    const m = memory[w.id]!;
    m.cycle = w.resetsAt ?? m.cycle;
    const used = w.usedPercent ?? 0;

    if ((used >= FULL || w.reached) && !m.reached) {
      m.reached = true;
      m.warned = true;
      say("reached", w.id, when ? L.reachedWhen(name, when) : L.reachedPlain(name));
    } else if (used >= options.warnAtPercent && used < FULL && !m.warned && !m.reached) {
      m.warned = true;
      say("warn", w.id, L.warn(name, used, when));
    }
  }
  return alerts;
}
