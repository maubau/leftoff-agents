import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecFn } from "./delivery.ts";

const execFileAsync = promisify(execFile);
// Creating a worktree can take a while on a big repository.
const defaultExec: ExecFn = (file, args) => execFileAsync(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });

/** A Paseo provider a new agent can run on: one Leftoff has hooks for (Claude Code, Codex). */
export interface PaseoProvider {
  id: string;
  label: string;
  host: "claude-code" | "codex";
}

/** Providers by the program they run ("claude-work" extends "claude"); others have no Leftoff hooks. */
export function hostOfProvider(provider: string): "claude-code" | "codex" | undefined {
  if (provider.startsWith("codex")) return "codex";
  if (provider.startsWith("claude")) return "claude-code";
  return undefined;
}

/** The enabled, available providers a new agent can be started on. Empty when Paseo does not answer. */
export async function paseoProviders(exec: ExecFn = defaultExec): Promise<PaseoProvider[]> {
  try {
    const { stdout } = await exec("paseo", ["provider", "ls", "--json"]);
    const out: PaseoProvider[] = [];
    for (const p of JSON.parse(stdout) as Array<Record<string, unknown>>) {
      if (typeof p.provider !== "string" || p.enabled === "Disabled" || p.status !== "available") continue;
      const host = hostOfProvider(p.provider);
      if (host) out.push({ id: p.provider, label: typeof p.label === "string" && p.label ? p.label : p.provider, host });
    }
    return out;
  } catch {
    return [];
  }
}

export type PaseoResult<T> = ({ ok: true } & T) | { ok: false; reason: string };

/**
 * What Paseo said when it refused: its JSON error, else the last line it wrote to stderr. Never the
 * "Command failed: paseo …" line, which repeats the whole command, the owner's task included.
 */
export function paseoError(error: unknown): string {
  const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const fromJson = (text: unknown): string | undefined => {
    try {
      const parsed = JSON.parse(String(text ?? "")) as { error?: { message?: unknown } | unknown; message?: unknown };
      const inner = parsed.error && typeof parsed.error === "object" ? (parsed.error as { message?: unknown }).message : parsed.error;
      const said = inner ?? parsed.message;
      return typeof said === "string" && said ? said : undefined;
    } catch {
      return undefined;
    }
  };
  const lastLine = (text: unknown) => String(text ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Command failed")).at(-1);
  const said = fromJson(e.stdout) ?? fromJson(e.stderr) ?? lastLine(e.stderr) ?? lastLine(e.message) ?? "no answer";
  return said.slice(0, 300);
}

const failure = (error: unknown) => ({ ok: false as const, reason: `Paseo refused it: ${paseoError(error)}` });

/**
 * A new worktree workspace of the project, named as the owner named the agent: Paseo shows it in the
 * project with that title, and Leftoff recognises the agent by it (agentForWorkspace).
 */
export async function createWorkspace(root: string, title: string, exec: ExecFn = defaultExec): Promise<PaseoResult<{ workspaceId: string; cwd: string }>> {
  try {
    const { stdout } = await exec("paseo", ["workspace", "create", "--isolation", "worktree", "--path", resolve(root), "--title", title, "--json"]);
    const w = JSON.parse(stdout) as { workspaceId?: unknown; cwd?: unknown };
    if (typeof w.workspaceId !== "string" || typeof w.cwd !== "string") return { ok: false, reason: "Paseo did not say which workspace it created" };
    return { ok: true, workspaceId: w.workspaceId, cwd: resolve(w.cwd) };
  } catch (error) {
    return failure(error);
  }
}

/** Start an agent in a workspace, in the background, with its first message. */
export async function startAgent(
  workspaceId: string,
  options: { title: string; provider: string; model?: string; thinking?: string; prompt: string },
  exec: ExecFn = defaultExec,
): Promise<PaseoResult<{ agentId: string }>> {
  const args = ["run", "--background", "--json", "--workspace", workspaceId, "--title", options.title, "--provider", options.provider];
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  // Every value was checked against Paseo's own lists; `--` keeps the message an argument, whatever it starts with.
  args.push("--", options.prompt);
  try {
    const { stdout } = await exec("paseo", args);
    const run = JSON.parse(stdout) as { agentId?: unknown };
    if (typeof run.agentId !== "string") return { ok: false, reason: "Paseo did not say which agent it started" };
    return { ok: true, agentId: run.agentId };
  } catch (error) {
    return failure(error);
  }
}

/** The title Paseo shows for a workspace: the agent's name, in both places. */
export async function renameWorkspace(workspaceId: string, title: string, exec: ExecFn = defaultExec): Promise<PaseoResult<object>> {
  try {
    await exec("paseo", ["workspace", "rename", workspaceId, title, "--json"]);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Undo a workspace Leftoff created moments ago, when the agent could not be started in it. */
export async function archiveWorkspace(workspaceId: string, exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    await exec("paseo", ["workspace", "archive", workspaceId, "--json"]);
    return true;
  } catch {
    return false;
  }
}
