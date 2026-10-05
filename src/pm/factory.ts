import type { PmConfig } from "../core/config.ts";
import { UserError } from "../core/errors.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import type { ModelProvider } from "./provider.ts";

export function createProvider(pm: PmConfig): ModelProvider {
  if (pm.provider === "anthropic") {
    const apiKey = process.env[pm.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
    return new AnthropicProvider({
      model: pm.model,
      effort: pm.effort,
      ...(apiKey ? { apiKey } : {}),
      ...(pm.price ? { price: pm.price } : {}),
    });
  }
  if (!pm.baseUrl) {
    throw new UserError("pm.baseUrl is not set", "Set it in ~/.config/leftoff/config.yaml, e.g. https://openrouter.ai/api/v1");
  }
  const apiKey = pm.apiKeyEnv ? process.env[pm.apiKeyEnv] : undefined;
  return new OpenAICompatibleProvider({
    baseUrl: pm.baseUrl,
    model: pm.model,
    ...(apiKey ? { apiKey } : {}),
    ...(pm.price ? { price: pm.price } : {}),
  });
}
