import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import type { Host, HostId } from "./types.ts";

export const HOSTS: readonly Host[] = [claudeCode, codex];

export function hostById(id: string): Host | undefined {
  return HOSTS.find((h) => h.id === id);
}

export type { Host, HostId };
export * from "./types.ts";
