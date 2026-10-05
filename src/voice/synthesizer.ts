export interface SpokenAudio {
  bytes: Uint8Array;
  /** audio/ogg for Telegram voice notes. */
  mime: string;
  characters: number;
  costUsd: number;
  model: string;
}

/** Text to speech. Deepgram Aura-2 first; the hub only sees this interface. */
export interface Synthesizer {
  readonly id: string;
  synthesize(text: string): Promise<SpokenAudio>;
}
