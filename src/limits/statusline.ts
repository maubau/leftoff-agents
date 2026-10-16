import { loadConfig } from "../core/config.ts";
import { currentClaudeAccount } from "./claude.ts";
import { recordClaudeUsage, statusText, usageFrom } from "./claude-usage.ts";

/**
 * `leftoff statusline`, Claude Code's status line command (D-060): it reads what Claude Code hands it on stdin, keeps
 * the subscription's usage for the panel, and prints one short line. Like the hooks it never fails the host: any
 * trouble prints nothing more than the model's name.
 */
export async function runStatusline(raw: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<string> {
  let input: unknown = null;
  try {
    input = JSON.parse(raw);
  } catch {
    return "";
  }
  const model = (input as { model?: { display_name?: unknown } } | null)?.model?.display_name;
  const name = typeof model === "string" ? model : "";
  try {
    const usage = usageFrom(input, now);
    if (!usage) return name;
    await recordClaudeUsage(usage, await currentClaudeAccount(env));
    const language = (await loadConfig().catch(() => null))?.language ?? "en";
    return [name, statusText(usage, language)].filter(Boolean).join(" · ");
  } catch {
    return name;
  }
}
