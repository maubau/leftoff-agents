import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface Usage {
  costUsd?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface TranscriptLine {
  type?: string;
  costUSD?: number;
  total_cost_usd?: number;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * Best-effort cost extraction from a Claude Code JSONL transcript. Hosts change
 * this shape between versions, so every field is optional and a parse failure
 * costs us a number, never a report.
 */
export async function usageFromTranscript(path: string): Promise<Usage> {
  const usage: Usage = {};
  let input = 0;
  let output = 0;
  let cost = 0;
  let sawCost = false;

  try {
    const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      const explicit = parsed.total_cost_usd ?? parsed.costUSD;
      if (typeof explicit === "number") {
        cost = Math.max(cost, explicit);
        sawCost = true;
      }
      const u = parsed.message?.usage;
      if (u) {
        input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        output += u.output_tokens ?? 0;
      }
      if (parsed.message?.model) usage.model = parsed.message.model;
    }
  } catch {
    return usage;
  }

  if (sawCost) usage.costUsd = Number(cost.toFixed(4));
  if (input) usage.inputTokens = input;
  if (output) usage.outputTokens = output;
  return usage;
}

export interface Turn {
  /** When the user's prompt that opened this turn was sent. */
  startedAt?: string;
  /** Tool names called in this turn, in order, excluding sidechains (sub-agents' own tools). */
  tools: string[];
}

/** Tools that mean the agent went looking for information, not just answering. */
const RESEARCH_TOOLS = new Set(["WebSearch", "WebFetch", "Agent", "Task"]);

/** A turn this busy has very likely learned or decided something worth keeping. */
const SUBSTANTIAL_TOOL_CALLS = 10;

interface Entry {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: string | Array<{ type?: string; name?: string }> };
}

/**
 * The current turn of a Claude Code transcript: everything since the last
 * prompt the user actually typed. Tool results also arrive as `user` entries,
 * so a prompt is a user entry whose content is text.
 */
export async function currentTurn(path: string): Promise<Turn> {
  const turn: Turn = { tools: [] };
  try {
    const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      if (entry.isSidechain) continue;
      const content = entry.message?.content;
      if (entry.type === "user" && !entry.isMeta) {
        const isPrompt =
          typeof content === "string" || (Array.isArray(content) && content.some((c) => c.type === "text"));
        if (isPrompt) {
          turn.tools = [];
          if (entry.timestamp) turn.startedAt = entry.timestamp;
          else delete turn.startedAt;
        }
      } else if (entry.type === "assistant" && Array.isArray(content)) {
        for (const item of content) if (item.type === "tool_use" && item.name) turn.tools.push(item.name);
      }
    }
  } catch {
    /* unreadable transcript: an empty turn, never an error */
  }
  return turn;
}

/** Did this turn do enough looking-around that it probably learned something? */
export function isSubstantial(turn: Turn): boolean {
  return turn.tools.some((t) => RESEARCH_TOOLS.has(t)) || turn.tools.length >= SUBSTANTIAL_TOOL_CALLS;
}
