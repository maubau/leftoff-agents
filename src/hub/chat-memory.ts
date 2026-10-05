import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { configRoot } from "../core/paths.ts";
import type { ChatTurn } from "../pm/provider.ts";

/** Recent turns per thread, so "e il tedesco?" makes sense after "le traduzioni?". */
const KEEP = 10;
const dir = () => join(configRoot(), "chat");
const fileFor = (key: string) => join(dir(), `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);

export async function recentTurns(threadKey: string): Promise<ChatTurn[]> {
  const raw = await readFile(fileFor(threadKey), "utf8").catch(() => "");
  const turns = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ChatTurn & { at: string };
      } catch {
        return null;
      }
    })
    .filter((t): t is ChatTurn & { at: string } => t !== null)
    // Old chat is stale context: after a day, the repo is the memory, not the chat.
    .filter((t) => Date.now() - Date.parse(t.at) < 24 * 3_600_000)
    .slice(-KEEP);
  // The API needs the history to start with a user turn.
  while (turns[0] && turns[0].role !== "user") turns.shift();
  return turns.map(({ role, text }) => ({ role, text }));
}

export async function remember(threadKey: string, turns: ChatTurn[]): Promise<void> {
  await mkdir(dir(), { recursive: true });
  const at = new Date().toISOString();
  await appendFile(fileFor(threadKey), turns.map((t) => JSON.stringify({ ...t, at })).join("\n") + "\n", "utf8");
}
