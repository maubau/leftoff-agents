import { LANGUAGES, type Lang } from "./index.ts";

/**
 * The chat commands in every language: whatever the owner types maps to one canonical command.
 * Telegram commands are ASCII, so the aliases are too ("ruhe", "voix", "reanudar").
 */
export type Command = "mute" | "unmute" | "overview" | "quiet" | "resume" | "voice" | "language" | "alerts" | "office";

const ALIASES: Record<Command, string[]> = {
  mute: ["mute", "silenzia", "stumm", "sourdine", "silenciar"],
  unmute: ["unmute", "riattiva", "laut", "reactiver", "reactivar", "reativar"],
  overview: ["overview", "standup", "panoramica", "uebersicht", "apercu", "resumen", "visao"],
  quiet: ["quiet", "silenzio", "ruhe", "silence", "silencio", "sossego"],
  resume: ["resume", "riparti", "weiter", "reprendre", "reanudar", "retomar"],
  voice: ["voice", "voce", "stimme", "voix", "voz"],
  language: ["language", "lingua", "sprache", "langue", "idioma"],
  alerts: ["alerts", "avvisi", "notify", "meldungen", "alertes", "avisos"],
  office: ["office", "ufficio", "buero", "bureau", "oficina", "escritorio", "team", "squadra"],
};

export function canonicalCommand(name: string): Command | undefined {
  const wanted = name.toLowerCase();
  return (Object.keys(ALIASES) as Command[]).find((command) => ALIASES[command].includes(wanted));
}

/** Arguments of /quiet and /voice, in every language. */
export const ON = new Set(["on", "attiva", "attivo", "enable", "an", "ein", "aktiv", "activer", "active", "activar", "activa", "ativar", "ativa", "sim", "oui", "si"]);
export const OFF = new Set(["off", "disattiva", "disattivo", "disable", "aus", "desactiver", "desactivar", "desactiva", "desativar", "desativa", "nao", "non", "no"]);

export const VOICE_MODES: Record<string, "mirror" | "always" | "never"> = {
  on: "always", sempre: "always", always: "always", immer: "always", toujours: "always", siempre: "always",
  off: "never", mai: "never", never: "never", nie: "never", jamais: "never", nunca: "never",
  auto: "mirror", mirror: "mirror", automatisch: "mirror", automatique: "mirror", automatico: "mirror",
};

/** /alerts critical|normal|all, in every language's words. */
const LEVELS: Record<string, "critical" | "normal" | "all"> = {
  critical: "critical", critici: "critical", critico: "critical", kritisch: "critical", critiques: "critical", critique: "critical", criticos: "critical", critica: "critical", essenziali: "critical", essential: "critical",
  normal: "normal", normali: "normal", normale: "normal", normaux: "normal", normales: "normal", normais: "normal",
  all: "all", tutti: "all", tutto: "all", alle: "all", tous: "all", todos: "all", todas: "all", tudo: "all",
};
export const alertLevel = (word: string) => LEVELS[word.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")];

export const languageOptions = (): string => LANGUAGES.join("|");
export type { Lang };
