import type { TokenUsage } from "./pricing.ts";

/**
 * The only surface the PM sees. Each adapter owns its vendor's message format
 * and agent loop; the PM hands over a prompt, its tools and a way to run them,
 * and gets back an answer with what it cost. Swapping Anthropic for OpenRouter
 * or a local model never touches the PM.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema with `additionalProperties: false` and every property in `required`. */
  inputSchema: Record<string, unknown>;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

export interface RunRequest {
  /** Stable across calls, so providers can cache it. Never put dates or ids here. */
  system: string;
  /** Earlier turns of this conversation, oldest first, text only. */
  history: ChatTurn[];
  /** The new user message, with any volatile context (today's date…) inside it. */
  prompt: string;
  tools: ToolSpec[];
  execute(name: string, input: unknown): Promise<ToolOutcome>;
  maxSteps: number;
}

export interface RunResult {
  text: string;
  /** The model that actually answered — can differ after a server-side fallback. */
  model: string;
  usage: TokenUsage;
  costUsd: number;
  steps: number;
  toolCalls: Array<{ name: string; input: unknown }>;
  /** Set when the model declined; `text` is then a user-facing explanation. */
  refusal?: { category: string | null; explanation: string | null };
  /** The answer hit the output limit and may be cut short. */
  truncated?: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  run(request: RunRequest): Promise<RunResult>;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(into: TokenUsage, more: TokenUsage): void {
  into.inputTokens += more.inputTokens;
  into.outputTokens += more.outputTokens;
  into.cacheReadTokens += more.cacheReadTokens;
  into.cacheWriteTokens += more.cacheWriteTokens;
}

/** Appended to the last tool results when the step budget runs out. */
export const ANSWER_NOW =
  "You have used all your tool calls for this question. Answer now with what you have, " +
  "and say plainly what you could not check.";
