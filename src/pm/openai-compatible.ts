import { UserError } from "../core/errors.ts";
import { costOf, priceFrom } from "./pricing.ts";
import {
  ANSWER_NOW,
  addUsage,
  emptyUsage,
  type ModelProvider,
  type RunRequest,
  type RunResult,
} from "./provider.ts";

/**
 * Any server that speaks the OpenAI Chat Completions protocol with tool calls:
 * OpenRouter, Ollama, LM Studio, llama.cpp's server, vLLM and most hosted APIs.
 * Plain fetch, no SDK — the protocol is small and this keeps Leftoff's
 * dependencies honest. Claude itself goes through the Anthropic adapter.
 */
export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** USD per million tokens, for backends that do not report cost themselves. */
  price?: { input: number; output: number };
  fetch?: typeof fetch;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface Completion {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** OpenRouter reports what the call cost. */
    cost?: number;
  };
  error?: { message?: string };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly model: string;
  readonly #url: string;
  readonly #apiKey: string | undefined;
  readonly #price: OpenAICompatibleOptions["price"];
  readonly #fetch: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    if (!options.baseUrl) {
      throw new UserError("pm.baseUrl is required for the openai-compatible provider", "e.g. https://openrouter.ai/api/v1 or http://localhost:11434/v1");
    }
    this.model = options.model;
    this.#url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.#apiKey = options.apiKey;
    this.#price = options.price;
    this.#fetch = options.fetch ?? fetch;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const messages: Message[] = [
      { role: "system", content: request.system },
      ...request.history.map((t) => ({ role: t.role, content: t.text }) as Message),
      { role: "user", content: request.prompt },
    ];
    const tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const usage = emptyUsage();
    const toolCalls: RunResult["toolCalls"] = [];
    let reportedCost = 0;
    let sawReportedCost = false;
    let model = this.model;

    for (let step = 1; ; step++) {
      const lastStep = step > request.maxSteps;
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          ...(lastStep ? {} : { tools, tool_choice: "auto" }),
          // Ask OpenRouter for cost accounting; other servers ignore unknown fields.
          usage: { include: true },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Completion;
      if (!response.ok) {
        throw new Error(`${this.#url} answered ${response.status}: ${body.error?.message ?? response.statusText}`);
      }

      const stepUsage = {
        inputTokens: (body.usage?.prompt_tokens ?? 0) - (body.usage?.prompt_tokens_details?.cached_tokens ?? 0),
        outputTokens: body.usage?.completion_tokens ?? 0,
        cacheReadTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      };
      addUsage(usage, stepUsage);
      if (typeof body.usage?.cost === "number") {
        reportedCost += body.usage.cost;
        sawReportedCost = true;
      }
      if (body.model) model = body.model;

      const choice = body.choices?.[0];
      const calls = choice?.message?.tool_calls ?? [];
      const costUsd = sawReportedCost ? reportedCost : costOf(usage, priceFrom(this.#price));
      const base = { model, usage, costUsd, steps: step, toolCalls };

      if (calls.length === 0 || lastStep) {
        return {
          ...base,
          text: (choice?.message?.content ?? "").trim(),
          ...(choice?.finish_reason === "length" ? { truncated: true } : {}),
        };
      }

      messages.push({ role: "assistant", content: choice?.message?.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let input: unknown = {};
        let outcome;
        try {
          input = JSON.parse(call.function.arguments || "{}");
          toolCalls.push({ name: call.function.name, input });
          outcome = await request.execute(call.function.name, input);
        } catch (error) {
          outcome = { content: `Invalid tool call: ${(error as Error).message}`, isError: true };
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
      }
      if (step >= request.maxSteps) messages.push({ role: "user", content: ANSWER_NOW });
    }
  }
}
