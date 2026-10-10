// Types for pixeltext.js, which is plain JavaScript because the browser loads it as is.
import type { RectTarget } from "./office.js";

export const LINE_H: number;
export const LEADING: number;
export function textWidth(text: string, scale?: number): number;
export function drawText(ctx: RectTarget, text: string, x: number, y: number, colour: string, options?: { scale?: number; shadow?: string }): number;
export function fit(text: string, maxWidth: number): string;
export function wrap(text: string, maxWidth: number, maxLines: number): string[];
