/**
 * The Anthropic models the owner can switch the PM to from the panel. Only models with a list price
 * in pricing.ts: one without would count as free, and the monthly cap would stop counting.
 * `fallback`: the model takes the server-side refusal fallback the adapter asks for.
 * `effort`: the model takes `output_config.effort`.
 */
export interface PmModel {
  id: string;
  label: string;
  fallback: boolean;
  effort: boolean;
}

export const PM_MODELS: readonly PmModel[] = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", fallback: false, effort: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", fallback: true, effort: true },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", fallback: true, effort: true },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", fallback: true, effort: true },
];

/** From the cheapest to the most thorough. */
export const PM_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type PmEffort = (typeof PM_EFFORTS)[number];

/** Older models some installations still name: no refusal fallback, no effort. */
const LEGACY: Record<string, Pick<PmModel, "fallback" | "effort">> = {
  "claude-haiku-4-5": { fallback: false, effort: false },
};

/** What a model accepts. A model Leftoff does not know keeps the full request, as before. */
export function capabilities(model: string): Pick<PmModel, "fallback" | "effort"> {
  const alias = model.replace(/-\d{8}$/, "");
  return PM_MODELS.find((m) => m.id === alias) ?? LEGACY[alias] ?? { fallback: true, effort: true };
}
