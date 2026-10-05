import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { configRoot } from "../core/paths.ts";
import { parseResetTime } from "./reset-time.ts";
import type { LimitWindow, StoppedAgent } from "./types.ts";

/**
 * What Leftoff knows about Claude Code's subscription limit. The agents Paseo
 * runs are headless (`sdk-cli`), which has no status line, so there is no usage
 * percentage to read. What exists is the `StopFailure` hook, which fires when a
 * turn ends because the limit was hit, and the `Stop` hook of the next turn that
 * succeeds — together: "reached", and "back".
 *
 * A machine can hold several Claude Code subscriptions (a second CLAUDE_CONFIG_DIR, such as a
 * Paseo provider for another employer). Each is its own account with its own limit, so each
 * has its own state file: a limit on one must never show, or clear, on the other.
 */
export interface ClaudeAccount {
  /** "" for the default `~/.claude`; else a slug of the config directory. */
  slug: string;
  /** What the owner calls it ("Work"); empty for the default. */
  label: string;
}

const DEFAULT_ACCOUNT: ClaudeAccount = { slug: "", label: "" };

/** The name a Paseo provider gives its account: "Claude (Work)" → "Work". */
function accountName(providerLabel: string | undefined, dir: string): string {
  const fromLabel = providerLabel && (/\(([^)]+)\)/.exec(providerLabel)?.[1] ?? providerLabel.replace(/^claude[\s:-]*/i, ""));
  return (fromLabel || basename(dir).replace(/^\.?claude[-_]?/i, "") || basename(dir)).trim();
}

const slugOf = (dir: string) => basename(dir).replace(/^\./, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^claude-?/, "") || "other";

type PaseoProvider = { label?: string; env?: Record<string, string> };

async function paseoProviders(): Promise<Record<string, PaseoProvider>> {
  const raw = await readFile(join(homedir(), ".paseo", "config.json"), "utf8").catch(() => null);
  try {
    return (JSON.parse(raw ?? "{}") as { agents?: { providers?: Record<string, PaseoProvider> } }).agents?.providers ?? {};
  } catch {
    return {};
  }
}

/** Which account the process we run in belongs to: from the config directory Claude Code was started with. */
export async function currentClaudeAccount(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeAccount> {
  const dir = (env.CLAUDE_CONFIG_DIR ?? "").split(":").filter(Boolean)[0];
  if (!dir || resolve(dir) === resolve(homedir(), ".claude")) return DEFAULT_ACCOUNT;
  const provider = Object.values(await paseoProviders()).find((p) => p.env?.["CLAUDE_CONFIG_DIR"] && resolve(p.env["CLAUDE_CONFIG_DIR"]) === resolve(dir));
  return { slug: slugOf(dir), label: accountName(provider?.label, dir) };
}

/** Every account Paseo knows, even those that never hit a limit — so the panel can show them all. */
export async function knownClaudeAccounts(): Promise<ClaudeAccount[]> {
  const accounts = new Map<string, ClaudeAccount>([["", DEFAULT_ACCOUNT]]);
  for (const provider of Object.values(await paseoProviders())) {
    const dir = provider.env?.["CLAUDE_CONFIG_DIR"];
    if (!dir || resolve(dir) === resolve(homedir(), ".claude")) continue;
    accounts.set(slugOf(dir), { slug: slugOf(dir), label: accountName(provider.label, dir) });
  }
  return [...accounts.values()];
}
export interface ClaudeLimitState {
  limited: boolean;
  /** Epoch ms of the failure that started this episode; identifies it. */
  since: number | null;
  /** Epoch ms of the reset, when the message said; else null. */
  resetsAt: number | null;
  /** The raw error text, redacted, kept to improve the parser. */
  details: string;
  lastOkAt: number | null;
  /** Project agents whose turn stopped in this limit episode. */
  targets: StoppedAgent[];
  /** The account's display name, kept with its state so reading it needs no lookup. */
  account?: string;
}

const file = (account: ClaudeAccount = DEFAULT_ACCOUNT) => join(configRoot(), "limits", account.slug ? `claude-${account.slug}.json` : "claude.json");
const empty = (): ClaudeLimitState => ({ limited: false, since: null, resetsAt: null, details: "", lastOkAt: null, targets: [] });

export async function readClaudeState(account: ClaudeAccount = DEFAULT_ACCOUNT): Promise<ClaudeLimitState> {
  const raw = await readFile(file(account), "utf8").catch(() => null);
  if (!raw) return empty();
  try {
    return { ...empty(), ...(JSON.parse(raw) as Partial<ClaudeLimitState>) };
  } catch {
    return empty();
  }
}

async function write(state: ClaudeLimitState, account: ClaudeAccount): Promise<void> {
  const target = file(account);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...state, ...(account.label ? { account: account.label } : {}) }, null, 1), "utf8");
  await rename(tmp, target);
}

/** StopFailure with a usage limit. Repeated failures in one episode keep the first `since`. */
export async function recordClaudeLimit(
  payload: { error?: string; error_details?: unknown; last_assistant_message?: string },
  now: number,
  timezone: string,
  target?: StoppedAgent,
  account: ClaudeAccount = DEFAULT_ACCOUNT,
): Promise<void> {
  const details = [payload.error_details, payload.last_assistant_message]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" · ")
    .slice(0, 600);
  const previous = await readClaudeState(account);
  const resetsAt = parseResetTime(details, now, timezone);
  const targets = previous.limited ? [...previous.targets] : [];
  // Two sessions of the same logical agent are two agents: keyed by session as well.
  const same = (t: StoppedAgent) =>
    t.projectRoot === target?.projectRoot && t.agentId === target?.agentId && (t.paseoAgent ?? "") === (target?.paseoAgent ?? "");
  if (target && !targets.some(same)) targets.push(target);
  await write({
    limited: true,
    since: previous.limited && previous.since ? previous.since : now,
    resetsAt: resetsAt ?? (previous.limited ? previous.resetsAt : null),
    details,
    lastOkAt: previous.lastOkAt,
    targets,
  }, account);
}

/** A turn finished without error: whatever limit there was has lifted. */
export async function recordClaudeOk(now: number, account: ClaudeAccount = DEFAULT_ACCOUNT): Promise<void> {
  const state = await readClaudeState(account);
  // Only touch the file when there is something to clear, so every normal turn stays free.
  if (!state.limited) return;
  await write({ ...state, limited: false, lastOkAt: now }, account);
}

function windowOf(state: ClaudeLimitState, account: ClaudeAccount, quiet = false): LimitWindow | null {
  if (!state.since && !quiet) return null;
  return {
    id: account.slug ? `claude:${account.slug}` : "claude",
    product: "Claude Code",
    label: "",
    ...(account.label ? { account: account.label } : {}),
    usedPercent: null,
    resetsAt: state.resetsAt,
    reached: state.limited,
    observedAt: state.since ?? 0,
    targets: state.targets,
  };
}

/** The default account's window, or null if it never hit a limit. */
export async function claudeWindow(): Promise<LimitWindow | null> {
  return windowOf(await readClaudeState(), DEFAULT_ACCOUNT);
}

/**
 * One window per account that has ever hit a limit, from the state files alone. With `all`, also
 * a quiet window for each account Paseo knows (the panel shows them all; the hub does not need
 * them, and tests must not depend on whose machine they run on).
 */
export async function claudeWindows(options: { all?: boolean } = {}): Promise<LimitWindow[]> {
  const accounts = new Map<string, ClaudeAccount>([["", DEFAULT_ACCOUNT]]);
  const dir = dirname(file());
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const slug = /^claude-(.+)\.json$/.exec(name)?.[1];
    if (!slug) continue;
    const saved = JSON.parse(await readFile(join(dir, name), "utf8").catch(() => "{}")) as { account?: string };
    accounts.set(slug, { slug, label: saved.account ?? slug });
  }
  if (options.all) for (const a of await knownClaudeAccounts()) accounts.set(a.slug, a);

  const windows: LimitWindow[] = [];
  for (const account of accounts.values()) {
    const state = await readClaudeState(account);
    const window = windowOf(state, account, options.all);
    if (window) windows.push(window);
  }
  return windows;
}
