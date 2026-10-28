// Types for limits.js, which is plain JavaScript because the browser loads it as is.

export interface MeterWindow { id?: string; product: string; label: string; account?: string; usedPercent: number | null; valueText?: string }

export function claudeWithoutPercent(w: MeterWindow | null | undefined, all?: ReadonlyArray<MeterWindow | null | undefined>): boolean;
