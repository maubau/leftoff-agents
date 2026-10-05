import type { Audio, Transcriber, Transcript } from "./transcriber.ts";

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  /** `it`, `en`… or `multi` for speech that mixes languages (Italian with English tech terms). */
  language: string;
  /** USD per minute, for the spend ledger. */
  pricePerMinuteUsd: number;
  fetch?: typeof fetch;
}

/** Deepgram caps keyterms at 500 tokens per request and recommends 20–50 terms. */
const MAX_KEYTERMS = 40;
const MAX_KEYTERM_CHARS = 350;

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }> };
}

/** Pre-recorded API, raw bytes in the body (docs: developers.deepgram.com, checked 2026-10-02). */
export class DeepgramTranscriber implements Transcriber {
  readonly id = "deepgram";
  readonly #options: DeepgramOptions;
  readonly #fetch: typeof fetch;

  constructor(options: DeepgramOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async transcribe(audio: Audio, options: { keyterms: string[] }): Promise<Transcript> {
    const params = new URLSearchParams({
      model: this.#options.model,
      language: this.#options.language,
      smart_format: "true",
    });
    let budget = MAX_KEYTERM_CHARS;
    for (const term of [...new Set(options.keyterms.map((t) => t.trim()).filter(Boolean))].slice(0, MAX_KEYTERMS)) {
      if (term.length > budget) break;
      budget -= term.length;
      params.append("keyterm", term);
    }

    const response = await this.#fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { authorization: `Token ${this.#options.apiKey}`, "content-type": audio.mime },
      body: audio.bytes,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Deepgram answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = (await response.json()) as DeepgramResponse;
    const best = body.results?.channels?.[0]?.alternatives?.[0];
    const durationSec = body.metadata?.duration ?? 0;
    return {
      text: (best?.transcript ?? "").trim(),
      confidence: best?.confidence ?? 0,
      durationSec,
      costUsd: (durationSec / 60) * this.#options.pricePerMinuteUsd,
      model: this.#options.model,
    };
  }
}
