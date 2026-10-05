/**
 * USD per million tokens, from Anthropic's list price (checked 2026-09-25).
 * Cache writes are billed at 1.25× input for the default 5-minute TTL.
 * Unknown models fall back to `pm.price` in config, or are reported as unpriced.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ANTHROPIC: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function anthropicPrice(model: string): Price | undefined {
  if (ANTHROPIC[model]) return ANTHROPIC[model];
  // Dated snapshot ids (claude-haiku-4-5-20251001) price like their alias.
  const alias = model.replace(/-\d{8}$/, "");
  return ANTHROPIC[alias];
}

export function priceFrom(config?: { input: number; output: number }): Price | undefined {
  if (!config) return undefined;
  return { input: config.input, output: config.output, cacheRead: config.input * 0.1, cacheWrite: config.input * 1.25 };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costOf(usage: TokenUsage, price: Price | undefined): number {
  if (!price) return 0;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}
