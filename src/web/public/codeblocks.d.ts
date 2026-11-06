// Types for codeblocks.js, which is plain JavaScript because the browser loads it as is.

export type Segment = { type: "text" | "code" | "inline"; value: string; lang?: string };
export function segments(text: string): Segment[];
export function telegramHtml(text: string): string;

export type Mark = { type: "text" | "inline" | "strong" | "em"; value: string };
export type Block =
  | { type: "code"; value: string; lang?: string }
  | { type: "para"; inline: Mark[] }
  | { type: "heading"; inline: Mark[] }
  | { type: "list"; ordered: boolean; start?: number; items: Mark[][] };
export function markdown(text: unknown): Block[];
export function inlineMarks(text: string): Mark[];
