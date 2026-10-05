import type { Synthesizer, SpokenAudio } from "./synthesizer.ts";

export interface DeepgramSpeakOptions {
  apiKey: string;
  /** e.g. aura-2-livia-it (Italian, feminine) or aura-2-dionisio-it (masculine). */
  model: string;
  /** Opus bit rate; Deepgram's default of 12 kbps is thin for speech. */
  bitRate: number;
  /** USD per 1,000 characters (Aura-2 pay-as-you-go: 0.03). */
  pricePer1kCharsUsd: number;
  fetch?: typeof fetch;
}

/** Deepgram caps a request at 2000 characters; the hub trims well below that. */
export const MAX_SPEAK_CHARS = 2000;

/** REST only: Ogg/Opus is not available on the streaming endpoint (docs, 2026-10-02). */
export class DeepgramSynthesizer implements Synthesizer {
  readonly id = "deepgram";
  readonly #options: DeepgramSpeakOptions;
  readonly #fetch: typeof fetch;

  constructor(options: DeepgramSpeakOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async synthesize(text: string): Promise<SpokenAudio> {
    const spoken = text.slice(0, MAX_SPEAK_CHARS);
    const params = new URLSearchParams({
      model: this.#options.model,
      encoding: "opus",
      container: "ogg",
      bit_rate: String(this.#options.bitRate),
    });
    const response = await this.#fetch(`https://api.deepgram.com/v1/speak?${params}`, {
      method: "POST",
      headers: { authorization: `Token ${this.#options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ text: spoken }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Deepgram speak answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mime: "audio/ogg",
      characters: spoken.length,
      costUsd: (spoken.length / 1000) * this.#options.pricePer1kCharsUsd,
      model: this.#options.model,
    };
  }
}
