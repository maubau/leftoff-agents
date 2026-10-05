import { MARKER, type HookSpec } from "./types.ts";

/**
 * Claude Code and Codex both describe hooks as
 * `{ <Event>: [ { matcher, hooks: [ { type: "command", command, timeout } ] } ] }`,
 * so one merge implementation serves both.
 */
export interface HookEntry {
  type: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
  [key: string]: unknown;
}

export type HookMap = Record<string, HookMatcher[]>;

export function isOurs(entry: HookEntry): boolean {
  return typeof entry.command === "string" && entry.command.includes(MARKER);
}

export interface MergeResult {
  map: HookMap;
  installed: string[];
  alreadyPresent: string[];
}

/**
 * Add Leftoff's hooks without touching anyone else's. Re-running is a no-op
 * unless the command changed, in which case ours is updated in place.
 */
export function mergeHooks(existing: HookMap, specs: readonly HookSpec[]): MergeResult {
  const map: HookMap = structuredClone(existing);
  const installed: string[] = [];
  const alreadyPresent: string[] = [];

  for (const spec of specs) {
    const entry: HookEntry = { type: "command", command: spec.command, timeout: spec.timeoutSec };
    const groups = (map[spec.event] ??= []);
    const ourGroup = groups.find((g) => g.hooks?.some(isOurs));

    if (!ourGroup) {
      groups.push({ matcher: "", hooks: [entry] });
      installed.push(spec.event);
      continue;
    }
    const index = ourGroup.hooks.findIndex(isOurs);
    const current = ourGroup.hooks[index];
    if (current?.command === spec.command && current?.timeout === spec.timeoutSec) {
      alreadyPresent.push(spec.event);
    } else {
      ourGroup.hooks[index] = { ...current, ...entry };
      installed.push(spec.event);
    }
  }
  // Events we used to install but no longer do (e.g. SubagentStop): remove ours only.
  const wanted = new Set(specs.map((s) => s.event));
  for (const [event, groups] of Object.entries(map)) {
    if (wanted.has(event) || !groups.some((g) => g.hooks?.some(isOurs))) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) map[event] = kept;
    else delete map[event];
    installed.push(`-${event}`);
  }
  return { map, installed, alreadyPresent };
}

/** Strip only the entries Leftoff installed, and drop groups and events left empty. */
export function removeHooks(existing: HookMap): { map: HookMap; removed: string[] } {
  const map: HookMap = structuredClone(existing);
  const removed: string[] = [];
  for (const [event, groups] of Object.entries(map)) {
    const kept: HookMatcher[] = [];
    for (const group of groups) {
      const hooks = (group.hooks ?? []).filter((h) => !isOurs(h));
      if (hooks.length !== (group.hooks ?? []).length) removed.push(event);
      if (hooks.length > 0) kept.push({ ...group, hooks });
    }
    if (kept.length > 0) map[event] = kept;
    else delete map[event];
  }
  return { map, removed: [...new Set(removed)] };
}

export function describeInstalled(map: HookMap, binary: string) {
  const installed: string[] = [];
  const stale: string[] = [];
  for (const [event, groups] of Object.entries(map)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (!isOurs(hook)) continue;
        installed.push(event);
        if (!hook.command?.startsWith(binary)) stale.push(`${event} → ${hook.command}`);
      }
    }
  }
  return { installed: [...new Set(installed)], stale };
}
