export interface Audio {
  bytes: Uint8Array;
  /** e.g. audio/ogg for Telegram voice notes (Opus). */
  mime: string;
}

export interface Transcript {
  text: string;
  /** 0..1, as reported by the service. */
  confidence: number;
  durationSec: number;
  costUsd: number;
  model: string;
}

/**
 * Speech to text. Deepgram is the first implementation; like the PM's model,
 * the service is the user's choice and the hub only sees this interface.
 */
export interface Transcriber {
  readonly id: string;
  transcribe(audio: Audio, options: { keyterms: string[] }): Promise<Transcript>;
}
