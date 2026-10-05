export type HostId = "claude-code" | "codex";

/** One configuration root of a host — a host can have several on one machine. */
export interface HostRoot {
  hostId: HostId;
  /** Absolute path to the config directory (e.g. `~/.claude`, `~/.codex`). */
  dir: string;
  /** Where this root came from, for `leftoff hosts doctor` output. */
  origin: string;
}

export interface HookSpec {
  /** Event name as the host writes it in its own config. */
  event: string;
  /** The `leftoff hook …` invocation. */
  command: string;
  timeoutSec: number;
}

export interface InstallResult {
  root: HostRoot;
  /** Config files written. */
  files: string[];
  /** Backups taken before writing. */
  backups: string[];
  installed: string[];
  alreadyPresent: string[];
  /** Things the user must still do by hand, if any. */
  manual: string[];
}

export interface HostStatus {
  root: HostRoot;
  exists: boolean;
  installed: string[];
  missing: string[];
  /** Hooks pointing at a different `leftoff` binary than the current one. */
  stale: string[];
}

export interface Host {
  id: HostId;
  label: string;
  /** Every config root of this host present on the machine. */
  detectRoots(): Promise<HostRoot[]>;
  install(root: HostRoot, binary: string): Promise<InstallResult>;
  uninstall(root: HostRoot): Promise<InstallResult>;
  status(root: HostRoot, binary: string): Promise<HostStatus>;
}

/** Marks every config entry Leftoff owns, so uninstall never removes a user's own hooks. */
export const MARKER = "leftoff hook";
