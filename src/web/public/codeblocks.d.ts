// Types for codeblocks.js, which is plain JavaScript because the browser loads it as is.

export type Segment = { type: "text" | "code" | "inline"; value: string; lang?: string };
export function segments(text: string): Segment[];
export function telegramHtml(text: string): string;
