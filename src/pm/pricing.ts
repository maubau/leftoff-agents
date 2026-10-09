/**
 * USD per million tokens, from Anthropic's list price (checked 2026-10-09).
 * Cache writes are billed at 1.25× input for the default 5-minute TTL.
 * Unknown models fall back to `pm.price` in config, or are reported as unpriced.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A dearer rate for a request whose prompt (cached or not) is longer than `tokens`. */
  long?: { tokens: number; price: Omit<Price, "long"> };
}

const ANTHROPIC: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // Cache rates are not listed for Haiku 5.5: the usual 0.1× and 1.25× of input are assumed.
  "claude-haiku-5-5": {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    long: { tokens: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  },
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

export function costOf(usage: TokenUsage, given: Price | undefined): number {
  if (!given) return 0;
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const price = given.long && prompt > given.long.tokens ? given.long.price : given;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}
