import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configRoot } from "../core/paths.ts";

export interface SpendEntry {
  at: string;
  provider: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** What the call was for: "ask", "standup", "eval"… */
  purpose: string;
  project?: string;
}

const ledgerFile = () => join(configRoot(), "spend.jsonl");

/** Every model call the PM makes, appended. The month total is what the cap checks. */
export async function recordSpend(entry: SpendEntry): Promise<void> {
  await mkdir(dirname(ledgerFile()), { recursive: true });
  await appendFile(ledgerFile(), `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readSpend(): Promise<SpendEntry[]> {
  const raw = await readFile(ledgerFile(), "utf8").catch(() => "");
  const out: SpendEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SpendEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** What counts against the PM's cap: its model calls. Voice is a separate service with its own credit. */
export async function spentThisMonth(now = new Date()): Promise<number> {
  const key = monthKey(now);
  return (await readSpend())
    .filter((e) => e.purpose !== "voice" && monthKey(new Date(e.at)) === key)
    .reduce((sum, e) => sum + e.costUsd, 0);
}

export async function spentSince(isoSince: string): Promise<number> {
  const since = Date.parse(isoSince);
  return (await readSpend()).filter((e) => Date.parse(e.at) >= since).reduce((s, e) => s + e.costUsd, 0);
}
