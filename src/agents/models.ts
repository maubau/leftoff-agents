import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFn } from "./delivery.ts";

const execFileAsync = promisify(execFile);
const defaultExec: ExecFn = (file, args) => execFileAsync(file, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });

/** A model Paseo can run an agent on, with the thinking levels it offers (Paseo's own ids). */
export interface AgentModel {
  id: string;
  label: string;
  thinking: string[];
  defaultThinking: string | null;
}

/** What Paseo says an agent runs on right now. */
export interface AgentRuntime {
  provider: string;
  model: string | null;
  thinking: string | null;
  status: string;
}

/** Every Paseo agent's provider, model and thinking level, by id. Empty when Paseo is unreachable. */
export async function agentRuntimes(exec: ExecFn = defaultExec): Promise<Map<string, AgentRuntime>> {
  const out = new Map<string, AgentRuntime>();
  try {
    const { stdout } = await exec("paseo", ["ls", "--json"]);
    for (const a of JSON.parse(stdout) as Array<Record<string, unknown>>) {
      if (typeof a.id !== "string" || typeof a.provider !== "string") continue;
      // `provider/model`, the model being whatever follows the first slash.
      const slash = a.provider.indexOf("/");
      out.set(a.id, {
        provider: slash === -1 ? a.provider : a.provider.slice(0, slash),
        model: slash === -1 ? null : a.provider.slice(slash + 1) || null,
        // Paseo says "auto" when the provider's default applies.
        thinking: typeof a.thinking === "string" && a.thinking !== "auto" ? a.thinking : null,
        status: typeof a.status === "string" ? a.status : "unknown",
      });
    }
  } catch {
    // Paseo is optional: no answer means no agent can be changed from here.
  }
  return out;
}

export function findRuntime(runtimes: Map<string, AgentRuntime>, paseoId: string): { id: string; runtime: AgentRuntime } | undefined {
  for (const [id, runtime] of runtimes) if (id === paseoId || id.startsWith(paseoId)) return { id, runtime };
  return undefined;
}

const modelCache = new Map<string, { at: number; models: AgentModel[] }>();
const MODELS_TTL = 10 * 60_000;

/**
 * The models a Paseo provider offers. A provider the owner defined ("claude-work") may not answer for
 * itself, so the program it runs ("claude", "codex") is asked next. Cached: the list rarely changes.
 */
export async function providerModels(provider: string, exec: ExecFn = defaultExec, now = Date.now()): Promise<AgentModel[]> {
  const cached = modelCache.get(provider);
  if (cached && now - cached.at < MODELS_TTL) return cached.models;
  const base = provider.startsWith("codex") ? "codex" : provider.startsWith("claude") ? "claude" : provider;
  for (const name of new Set([provider, base])) {
    try {
      const { stdout } = await exec("paseo", ["provider", "models", name, "--thinking", "--json"]);
      const models = (JSON.parse(stdout) as Array<Record<string, unknown>>)
        .filter((m) => typeof m.id === "string" && m.id)
        .map((m) => ({
          id: m.id as string,
          label: typeof m.model === "string" && m.model ? m.model : (m.id as string),
          thinking: Array.isArray(m.thinkingOptionIds) ? m.thinkingOptionIds.filter((t): t is string => typeof t === "string") : [],
          defaultThinking: typeof m.defaultThinkingOptionId === "string" ? m.defaultThinkingOptionId : null,
        }));
      if (models.length === 0) continue;
      modelCache.set(provider, { at: now, models });
      return models;
    } catch {
      // try the next name
    }
  }
  return [];
}

let modelFlag: { at: number; supported: boolean } | undefined;

/**
 * Whether this Paseo can switch a running agent's model from the command line. Up to 0.11 its
 * `agent update` takes only `--thinking`; the model is changed in Paseo's app. Asked again hourly,
 * so a Paseo upgrade turns the feature on without restarting the hub.
 */
export async function canSetModel(exec: ExecFn = defaultExec, now = Date.now()): Promise<boolean> {
  if (modelFlag && now - modelFlag.at < 3_600_000) return modelFlag.supported;
  let supported = false;
  try {
    const { stdout } = await exec("paseo", ["agent", "update", "--help"]);
    supported = /--model\b/.test(stdout);
  } catch {
    supported = false;
  }
  modelFlag = { at: now, supported };
  return supported;
}

/** Forget what was learned about Paseo; for tests, and after the owner upgrades it. */
export function forgetPaseoModels(): void {
  modelCache.clear();
  modelFlag = undefined;
}

export type ChangeResult = { ok: true; notice: string | null } | { ok: false; reason: string };

async function update(paseoId: string, flag: "--model" | "--thinking", value: string, exec: ExecFn): Promise<ChangeResult> {
  try {
    // Values were checked against Paseo's own list, and execFile passes them as arguments, not to a shell.
    const { stdout } = await exec("paseo", ["agent", "update", paseoId, flag, value, "--json"]);
    let notice: string | null = null;
    try {
      const parsed = JSON.parse(stdout) as { notice?: unknown };
      notice = typeof parsed.notice === "string" && parsed.notice ? parsed.notice : null;
    } catch {
      // older output: success is enough
    }
    return { ok: true, notice };
  } catch (error) {
    return { ok: false, reason: `Paseo refused it: ${(error as Error).message.split("\n")[0]}` };
  }
}

export const setAgentModel = (paseoId: string, model: string, exec: ExecFn = defaultExec) => update(paseoId, "--model", model, exec);
export const setAgentThinking = (paseoId: string, thinking: string, exec: ExecFn = defaultExec) => update(paseoId, "--thinking", thinking, exec);
