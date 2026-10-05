import { de } from "./de.ts";
import { en } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { pt } from "./pt.ts";
import type { Messages } from "./types.ts";

export type { Messages };

/** The languages Leftoff speaks. The first is the default. */
export const LANGUAGES = ["it", "en", "de", "fr", "es", "pt"] as const;
export type Lang = (typeof LANGUAGES)[number];

/** For Intl: dates, weekdays and numbers in the owner's own convention. */
export const LOCALES: Record<Lang, string> = { it: "it-IT", en: "en-GB", de: "de-DE", fr: "fr-FR", es: "es-ES", pt: "pt-BR" };

const CATALOGS: Record<Lang, Messages> = { it, en, de, fr, es, pt };

export const isLang = (value: unknown): value is Lang => typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);

export const messages = (lang: Lang): Messages => CATALOGS[lang];

/** "/lingua deutsch", "/language Español", "fr": every way an owner might name a language. */
const NAMES: Record<string, Lang> = {
  it: "it", ita: "it", italiano: "it", italian: "it", italienisch: "it", italien: "it",
  en: "en", eng: "en", english: "en", inglese: "en", englisch: "en", anglais: "en", ingles: "en", inglés: "en",
  de: "de", deu: "de", ger: "de", deutsch: "de", german: "de", tedesco: "de", allemand: "de", aleman: "de", alemán: "de", alemao: "de", alemão: "de",
  fr: "fr", fra: "fr", fre: "fr", francais: "fr", français: "fr", french: "fr", francese: "fr", französisch: "fr", frances: "fr", francés: "fr", francês: "fr",
  es: "es", spa: "es", espanol: "es", español: "es", spanish: "es", spagnolo: "es", spanisch: "es", espagnol: "es", espanhol: "es",
  pt: "pt", por: "pt", portugues: "pt", português: "pt", portuguese: "pt", portoghese: "pt", portugiesisch: "pt", portugais: "pt", portugués: "pt",
};

export function parseLanguage(text: string): Lang | undefined {
  return NAMES[text.trim().toLowerCase()];
}
