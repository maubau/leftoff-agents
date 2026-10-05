import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { messages, type Lang } from "../i18n/index.ts";
import type { LimitWindow } from "./types.ts";

/**
 * Codex logs its subscription windows inside every session file, on each
 * `token_count` event: `payload.rate_limits.{primary,secondary}` with the
 * percentage used, the window length and the epoch second of the reset.
 * Verified against codex 0.153.4 session files on this machine. Passive and
 * local — nothing is called, nothing is spent.
 */
interface RawWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}
interface RawLimits {
  primary?: RawWindow | null;
  secondary?: RawWindow | null;
  rate_limit_reached_type?: string | null;
}

/** The newest few session files are enough: the last event of the newest one is the freshest reading. */
const FILES_TO_TRY = 6;
/** Session files get big (16 MB seen); the last event is near the end. */
const TAIL_BYTES = 512 * 1024;
const HEAD_BYTES = 64 * 1024;

async function sessionFiles(root: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(path, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        files.push({ path, mtimeMs: (await stat(path).catch(() => null))?.mtimeMs ?? 0 });
      }
    }
  };
  await walk(root, 0);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function lastReading(path: string): Promise<{ limits: RawLimits; at: number } | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"rate_limits"')) continue;
      try {
        const event = JSON.parse(line) as { timestamp?: string; payload?: { rate_limits?: RawLimits | null } };
        const limits = event.payload?.rate_limits;
        if (limits && (limits.primary || limits.secondary)) {
          return { limits, at: event.timestamp ? Date.parse(event.timestamp) : 0 };
        }
      } catch {
        /* the first line of a tail read is usually cut in half */
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Session metadata is the first JSONL event and ties a limit to its project. */
async function sessionSource(path: string): Promise<LimitWindow["source"]> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, HEAD_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8").split("\n")) {
      if (!line.includes('"session_meta"')) continue;
      try {
        const event = JSON.parse(line) as { type?: string; payload?: { cwd?: string; id?: string; session_id?: string } };
        const cwd = event.payload?.cwd;
        if (event.type !== "session_meta" || !cwd) continue;
        const sessionId = event.payload?.id ?? event.payload?.session_id;
        return { cwd, ...(sessionId ? { sessionId } : {}) };
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

export function windowLabel(minutes: number | undefined, language: Lang): string {
  const m = messages(language).limits;
  if (minutes === 300) return m.fiveHours;
  if (minutes === 10080) return m.weekly;
  if (!minutes) return "";
  return minutes % 60 === 0 ? m.hours(minutes / 60) : `${minutes} min`;
}

export async function readCodexLimits(
  options: { codexHome?: string; language?: Lang } = {},
): Promise<LimitWindow[]> {
  const home = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const language = options.language ?? "en";
  for (const file of (await sessionFiles(join(home, "sessions"))).slice(0, FILES_TO_TRY)) {
    const reading = await lastReading(file.path);
    if (!reading) continue;
    const source = await sessionSource(file.path);
    const reached = Boolean(reading.limits.rate_limit_reached_type);
    const windows: LimitWindow[] = [];
    for (const raw of [reading.limits.primary, reading.limits.secondary]) {
      if (!raw || typeof raw.used_percent !== "number") continue;
      windows.push({
        id: `codex:${raw.window_minutes ?? "?"}`,
        product: "Codex",
        label: windowLabel(raw.window_minutes, language),
        usedPercent: raw.used_percent,
        resetsAt: typeof raw.resets_at === "number" ? raw.resets_at * 1000 : null,
        reached: reached && raw.used_percent >= 99.5,
        observedAt: reading.at || file.mtimeMs,
        ...(source ? { source } : {}),
      });
    }
    if (windows.length) return windows;
  }
  return [];
}
