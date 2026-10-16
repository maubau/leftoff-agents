import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { ClaudeUsage } from "./claude-usage.ts";

/**
 * Claude's usage as Paseo's daemon already collects it for its own app (D-060): the 5-hour and the weekly window, so
 * the panel has them for agents run by Paseo too, which have no status line. Read-only, on the owner's machine, through
 * the same client code Paseo's own command line uses. It is not a documented API: when it cannot be reached or its
 * answer changes shape, this says why and the status line's readings are kept.
 *
 * Only Paseo's own Claude login is reported (`~/.claude`): an account in another config directory (a provider with
 * CLAUDE_CONFIG_DIR) is not, so it keeps the status line as its only source.
 */

const Window = z.object({ id: z.string(), usedPct: z.number(), resetsAt: z.string() });
const Provider = z.object({ providerId: z.string(), status: z.string(), windows: z.array(Window), error: z.string().nullable().optional() });
const Answer = z.object({ fetchedAt: z.string(), providers: z.array(Provider) });

export type PaseoUsage = { ok: true; usage: ClaudeUsage } | { ok: false; reason: string };

/** What talks to the daemon: returns its raw answer to `provider.usage.list`. Tests give their own. */
export type UsageLoader = () => Promise<unknown>;

/** Paseo's answer as the default account's usage, or why it cannot be. */
export function claudeUsageFromPaseo(raw: unknown): PaseoUsage {
  const parsed = Answer.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "Paseo's usage answer has an unknown shape" };
  const claude = parsed.data.providers.filter((p) => p.providerId === "claude" && p.status === "available" && p.windows.length > 0);
  if (claude.length === 0) return { ok: false, reason: "Paseo reports no Claude usage" };
  if (claude.length > 1) return { ok: false, reason: "Paseo reports several Claude logins: which is which is unknown" };
  const window = (id: string) => {
    const w = claude[0]!.windows.find((x) => x.id === id);
    const resetsAt = w ? Date.parse(w.resetsAt) : Number.NaN;
    return w && Number.isFinite(resetsAt) ? { percent: Math.max(0, Math.min(100, w.usedPct)), resetsAt } : undefined;
  };
  const fiveHour = window("five_hour");
  const sevenDay = window("weekly");
  const observedAt = Date.parse(parsed.data.fetchedAt);
  if ((!fiveHour && !sevenDay) || !Number.isFinite(observedAt)) return { ok: false, reason: "Paseo's Claude usage has no session or weekly window" };
  return { ok: true, usage: { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), observedAt } };
}

const exec = promisify(execFile);

/**
 * The default loader: Paseo's own client modules, found from the `paseo` command on the PATH, connected to the local
 * daemon with the credential Paseo keeps for its command line, asked once, closed.
 */
export const paseoUsageLoader: UsageLoader = async () => {
  const { stdout } = await exec("sh", ["-c", "command -v paseo"], { timeout: 5_000 });
  const bin = await realpath(stdout.trim());
  const dist = join(dirname(dirname(bin)), "dist", "utils");
  const client = (await import(pathToFileURL(join(dist, "client.js")).href)) as { connectToDaemon(o: unknown): Promise<{ listProviderUsage(): Promise<unknown>; close(): Promise<void> }> };
  const target = (await import(pathToFileURL(join(dist, "daemon-target.js")).href)) as { selectDaemonTarget(o: unknown): unknown };
  const daemon = await client.connectToDaemon({ target: target.selectDaemonTarget({}), timeout: 5_000 });
  try {
    return await daemon.listProviderUsage();
  } finally {
    await daemon.close().catch(() => undefined);
  }
};

/** One reading, never throwing: a loader that fails is a reason, like an answer of the wrong shape. */
export async function readPaseoClaudeUsage(load: UsageLoader = paseoUsageLoader): Promise<PaseoUsage> {
  try {
    return claudeUsageFromPaseo(await load());
  } catch (error) {
    return { ok: false, reason: `Paseo's daemon could not be asked for usage: ${String((error as Error).message ?? error).slice(0, 160)}` };
  }
}
