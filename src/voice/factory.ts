import type { VoiceConfig } from "../core/config.ts";
import type { Lang as Language } from "../i18n/index.ts";
import { DeepgramSynthesizer } from "./deepgram-speak.ts";
import { DeepgramTranscriber } from "./deepgram.ts";
import type { Synthesizer } from "./synthesizer.ts";
import type { Transcriber } from "./transcriber.ts";

/** Pay-as-you-go list prices (deepgram.com/pricing, 2026-10-02). */
const NOVA3_MONO_PER_MIN = 0.0043;
const NOVA3_MULTI_PER_MIN = 0.0052;
const AURA2_PER_1K_CHARS = 0.03;

/**
 * Aura-2 speaks English, German, French, Spanish and Italian (Dutch and Japanese too, which Leftoff has no
 * interface for); the voice must be in the language of the text, or it reads it with a foreign accent.
 * Portuguese has none: replies are text only there until Deepgram adds one. Names from Deepgram's model list.
 */
const DEFAULT_VOICE: Partial<Record<Language, string>> = {
  en: "aura-2-thalia-en",
  de: "aura-2-viktoria-de",
  fr: "aura-2-agathe-fr",
  es: "aura-2-celeste-es",
  it: "aura-2-livia-it",
};

export const defaultVoice = (language: Language): string | undefined => DEFAULT_VOICE[language];

/** The configured speech services, or why one is missing — voice is optional, never an error. */
export function createSpeech(voice: VoiceConfig, language: Language = "en"): {
  transcriber?: Transcriber;
  synthesizer?: Synthesizer;
  why?: string;
} {
  if (voice.provider === "none") return { why: "voice.provider is none" };
  const apiKey = process.env[voice.apiKeyEnv];
  if (!apiKey) return { why: `${voice.apiKeyEnv} is not set` };
  return {
    transcriber: new DeepgramTranscriber({
      apiKey,
      model: voice.model,
      language: voice.language,
      pricePerMinuteUsd: voice.pricePerMinuteUsd ?? (voice.language === "multi" ? NOVA3_MULTI_PER_MIN : NOVA3_MONO_PER_MIN),
    }),
    ...(voice.speak.mode === "never" || !(voice.speak.model ?? defaultVoice(language))
      ? {}
      : {
          synthesizer: new DeepgramSynthesizer({
            apiKey,
            model: (voice.speak.model ?? defaultVoice(language))!,
            bitRate: voice.speak.bitRate,
            pricePer1kCharsUsd: voice.speak.pricePer1kCharsUsd ?? AURA2_PER_1K_CHARS,
          }),
        }),
  };
}
