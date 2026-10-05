import Anthropic from "@anthropic-ai/sdk";
import { UserError } from "../core/errors.ts";
import { anthropicPrice, costOf, priceFrom, type TokenUsage } from "./pricing.ts";
import {
  ANSWER_NOW,
  addUsage,
  emptyUsage,
  type ModelProvider,
  type RunRequest,
  type RunResult,
} from "./provider.ts";

export interface AnthropicOptions {
  model: string;
  effort: "low" | "medium" | "high";
  apiKey?: string;
  /** Required by personal multi-workspace keys; harmless with workspace keys. */
  workspaceId?: string;
  price?: { input: number; output: number };
  /** Injected in tests. */
  client?: Anthropic;
}

/** Server-side fallback re-runs a declined request on another model, Claude API only. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function usageOf(u: Anthropic.Beta.BetaUsage): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly #effort: AnthropicOptions["effort"];
  readonly #client: Anthropic;
  readonly #price: AnthropicOptions["price"];

  constructor(options: AnthropicOptions) {
    this.model = options.model;
    this.#effort = options.effort;
    this.#price = options.price;
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!options.client && !apiKey) {
      throw new UserError(
        "No Anthropic API key found",
        "Put ANTHROPIC_API_KEY=… in ~/.config/leftoff/secrets.env (see `leftoff pm doctor`).",
      );
    }
    const workspaceId = options.workspaceId ?? process.env.ANTHROPIC_WORKSPACE_ID;
    this.#client =
      options.client ??
      new Anthropic({
        apiKey,
        ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
      });
  }

  async run(request: RunRequest): Promise<RunResult> {
    const tools: Anthropic.Beta.BetaTool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...request.history.map((turn) => ({ role: turn.role, content: turn.text })),
      { role: "user", content: request.prompt },
    ];

    const usage = emptyUsage();
    const toolCalls: RunResult["toolCalls"] = [];
    let model = this.model;
    let cost = 0;

    for (let step = 1; ; step++) {
      const lastStep = step > request.maxSteps;
      const response = await this.#client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: this.#effort },
        // Tools render before the system prompt, so this one breakpoint caches
        // both; the top-level one caches the growing conversation between steps.
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        cache_control: { type: "ephemeral" },
        tools,
        ...(lastStep ? { tool_choice: { type: "none" } } : {}),
        messages,
      });

      const stepUsage = usageOf(response.usage);
      addUsage(usage, stepUsage);
      model = response.model;
      cost += costOf(stepUsage, anthropicPrice(response.model) ?? anthropicPrice(this.model) ?? priceFrom(this.#price));

      const base = { model, usage, costUsd: cost, steps: step, toolCalls };

      if (response.stop_reason === "refusal") {
        const details = response.stop_details;
        return {
          ...base,
          text: "",
          refusal: { category: details?.category ?? null, explanation: details?.explanation ?? null },
        };
      }
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      if (response.stop_reason !== "tool_use") {
        return {
          ...base,
          text: textOf(response.content),
          ...(response.stop_reason === "max_tokens" ? { truncated: true } : {}),
        };
      }

      // Append the assistant turn whole: thinking blocks must travel back unchanged.
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        toolCalls.push({ name: block.name, input: block.input });
        const outcome = await request.execute(block.name, block.input).catch((error: Error) => ({
          content: `Tool failed: ${error.message}`,
          isError: true,
        }));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      if (step >= request.maxSteps) results.push({ type: "text", text: ANSWER_NOW });
      messages.push({ role: "user", content: results });
    }
  }
}
