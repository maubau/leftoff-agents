import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, loadSecrets } from "../core/config.ts";
import { globalPaths } from "../core/paths.ts";
import { spentThisMonth } from "../pm/ledger.ts";
import { stat } from "node:fs/promises";

/**
 * Checks everything the PM needs without spending anything: config, the key's
 * presence (never its value), file permissions, budget, and a call to the
 * free models endpoint to prove the key and workspace work.
 */
export async function pmDoctor(): Promise<{ lines: string[]; healthy: boolean }> {
  const loaded = await loadSecrets();
  const config = await loadConfig();
  const lines: string[] = [];
  let healthy = true;
  const ok = (m: string) => lines.push(`✓ ${m}`);
  const bad = (m: string) => {
    healthy = false;
    lines.push(`✗ ${m}`);
  };

  lines.push(`provider ${config.pm.provider} · model ${config.pm.model} · effort ${config.pm.effort}`);
  const secrets = await stat(globalPaths.secrets()).catch(() => null);
  if (!secrets) bad(`${globalPaths.secrets()} missing`);
  else if ((secrets.mode & 0o077) !== 0) bad(`${globalPaths.secrets()} is readable by others — chmod 600 it`);
  else ok(`secrets file private (${loaded.length} value(s) loaded)`);

  const spent = await spentThisMonth();
  const cap = config.pm.budget.monthlyUsd;
  (spent >= cap ? bad : ok)(`spend this month $${spent.toFixed(4)} of $${cap.toFixed(2)} cap`);

  if (config.pm.provider === "anthropic") {
    const keyName = config.pm.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    const apiKey = process.env[keyName];
    if (!apiKey) {
      bad(`${keyName} not set`);
      return { lines, healthy };
    }
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
    ok(`${keyName} present${workspaceId ? `, workspace ${workspaceId}` : ""}`);
    try {
      const client = new Anthropic({
        apiKey,
        ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
      });
      const model = await client.models.retrieve(config.pm.model);
      ok(`key works; ${model.id} is available`);
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) bad("the API key was rejected (expired or revoked?)");
      else if (error instanceof Anthropic.NotFoundError) bad(`model ${config.pm.model} not available to this key`);
      else if (error instanceof Anthropic.APIError) bad(`API error ${error.status}: ${error.message}`);
      else bad(`could not reach Anthropic: ${(error as Error).message}`);
    }
  } else {
    lines.push(`base URL ${config.pm.baseUrl ?? "(not set)"}`);
    if (!config.pm.baseUrl) bad("pm.baseUrl is required for openai-compatible");
  }
  await voiceDoctor(config.voice, lines, ok, bad);
  return { lines, healthy };
}

/** Voice is optional: a missing key is a note, a rejected key is a problem. */
async function voiceDoctor(
  voice: Awaited<ReturnType<typeof loadConfig>>["voice"],
  lines: string[],
  ok: (m: string) => void,
  bad: (m: string) => void,
): Promise<void> {
  if (voice.provider === "none") {
    lines.push("· voice notes off (voice.provider: none)");
    return;
  }
  const key = process.env[voice.apiKeyEnv];
  if (!key) {
    lines.push(`· voice notes off: ${voice.apiKeyEnv} not set`);
    return;
  }
  // Listing projects is a free, read-only call that proves the key is valid.
  const response = await fetch("https://api.deepgram.com/v1/projects", { headers: { authorization: `Token ${key}` } }).catch(() => null);
  if (!response) bad("could not reach Deepgram");
  else if (response.status === 401 || response.status === 403) bad(`Deepgram rejected ${voice.apiKeyEnv} (${response.status})`);
  else if (!response.ok) bad(`Deepgram answered ${response.status}`);
  else ok(`voice notes on: Deepgram ${voice.model}, language ${voice.language}, up to ${voice.maxSeconds}s`);
}
