/** Fields Leftoff uses from a host's hook payload. Everything is optional by design. */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** Claude Code sets this when the Stop hook already blocked once this turn. */
  stop_hook_active?: boolean;
  source?: string;
  prompt?: string;
  [key: string]: unknown;
}

/** Codex's legacy `notify` program is called with one JSON argument, not stdin. */
export interface NotifyPayload {
  type?: string;
  "thread-id"?: string;
  "turn-id"?: string;
  cwd?: string;
  client?: string;
  "input-messages"?: string[];
  "last-assistant-message"?: string;
  [key: string]: unknown;
}

const STDIN_TIMEOUT_MS = 5000;

/**
 * Read the hook payload from stdin. Hosts that pass nothing, or pass something
 * unparseable, must not break the agent's turn: we return an empty payload and
 * let the handler fall back to the working directory.
 */
export async function readStdinPayload(): Promise<HookPayload> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  const timeout = setTimeout(() => process.stdin.destroy(), STDIN_TIMEOUT_MS);
  try {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return {};
  }
}

export function parseNotifyArg(arg: string | undefined): NotifyPayload {
  if (!arg) return {};
  try {
    return JSON.parse(arg) as NotifyPayload;
  } catch {
    return {};
  }
}
