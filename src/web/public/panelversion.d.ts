// Types for panelversion.js, which is plain JavaScript because the browser loads it as is.

export function versionSeen(first: string | null | undefined, now: unknown): { first: string | null; changed: boolean };
export const DRAFT_KEY: string;
export const DRAFT_TTL: number;
export function writeDrafts(drafts?: { hash?: string; pm?: string; task?: { id: string; text: string } | null }, now?: number): string | null;
export function readDrafts(raw: unknown, hash: string, now?: number): { pm: string; task: { id: string; text: string } | null } | null;
