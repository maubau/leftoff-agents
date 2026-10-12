export type PanelLanguage = "it" | "en" | "de" | "fr" | "es" | "pt";

export interface PanelStrings extends Record<string, unknown> {
  name: string;
  needsYou: string;
  pmSpent(amount: string): string;
}

export const STR: Record<PanelLanguage, PanelStrings>;
export const CODES: PanelLanguage[];
export const LOCALES: Record<PanelLanguage, string>;
export function strings(lang: string): PanelStrings;
