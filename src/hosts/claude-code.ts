import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { backup, readJson, writeJson } from "./files.ts";
import { describeInstalled, mergeHooks, removeHooks, type HookMap } from "./hookmap.ts";
import type { Host, HookSpec, HostRoot, HostStatus, InstallResult } from "./types.ts";

interface Settings {
  hooks?: HookMap;
  [key: string]: unknown;
}

function specs(binary: string): HookSpec[] {
  return [
    // End of turn: nudge the agent to report when it changed something and did not.
    { event: "Stop", command: `${binary} hook claude-code stop`, timeoutSec: 20 },
    // A turn that ended on an API error — for us, the subscription limit being hit.
    { event: "StopFailure", command: `${binary} hook claude-code stop-failure`, timeoutSec: 10 },
    // Start of turn and of session: deliver the inbox.
    { event: "SessionStart", command: `${binary} hook claude-code session-start`, timeoutSec: 15 },
    {
      event: "UserPromptSubmit",
      command: `${binary} hook claude-code user-prompt-submit`,
      timeoutSec: 15,
    },
  ];
}

const settingsFile = (dir: string) => join(dir, "settings.json");

/**
 * Discover every Claude Code config root. Beyond `~/.claude` and an explicit
 * CLAUDE_CONFIG_DIR, Paseo providers can pin their own root per provider — agents
 * started from Paseo would otherwise never get hooks installed.
 */
async function detectRoots(): Promise<HostRoot[]> {
  const roots = new Map<string, HostRoot>();
  const add = (dir: string, origin: string) => {
    const key = resolve(dir);
    if (!roots.has(key)) roots.set(key, { hostId: "claude-code", dir: key, origin });
  };

  add(join(homedir(), ".claude"), "default");
  for (const dir of (process.env.CLAUDE_CONFIG_DIR ?? "").split(":").filter(Boolean)) {
    add(dir, "CLAUDE_CONFIG_DIR");
  }

  const paseoConfig = join(homedir(), ".paseo", "config.json");
  const raw = await readFile(paseoConfig, "utf8").catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        agents?: { providers?: Record<string, { env?: Record<string, string> }> };
      };
      for (const [name, provider] of Object.entries(parsed.agents?.providers ?? {})) {
        const dir = provider.env?.["CLAUDE_CONFIG_DIR"];
        if (dir) add(dir, `paseo provider "${name}"`);
      }
    } catch {
      /* a malformed Paseo config is not our problem to report here */
    }
  }
  return [...roots.values()];
}

export const claudeCode: Host = {
  id: "claude-code",
  label: "Claude Code",

  detectRoots,

  async install(root, binary): Promise<InstallResult> {
    const file = settingsFile(root.dir);
    const settings = await readJson<Settings>(file, {});
    const { map, installed, alreadyPresent } = mergeHooks(settings.hooks ?? {}, specs(binary));
    const backups: string[] = [];
    if (installed.length > 0) {
      const b = await backup(file);
      if (b) backups.push(b);
      await writeJson(file, { ...settings, hooks: map });
    }
    return { root, files: [file], backups, installed, alreadyPresent, manual: [] };
  },

  async uninstall(root): Promise<InstallResult> {
    const file = settingsFile(root.dir);
    const settings = await readJson<Settings>(file, {});
    const { map, removed } = removeHooks(settings.hooks ?? {});
    const backups: string[] = [];
    if (removed.length > 0) {
      const b = await backup(file);
      if (b) backups.push(b);
      const next: Settings = { ...settings, hooks: map };
      if (Object.keys(map).length === 0) delete next.hooks;
      await writeJson(file, next);
    }
    return { root, files: [file], backups, installed: [], alreadyPresent: removed, manual: [] };
  },

  async status(root, binary): Promise<HostStatus> {
    const file = settingsFile(root.dir);
    const settings = await readJson<Settings>(file, {}).catch(() => ({}) as Settings);
    const { installed, stale } = describeInstalled(settings.hooks ?? {}, binary);
    const wanted = specs(binary).map((s) => s.event);
    return {
      root,
      exists: Object.keys(settings).length > 0,
      installed,
      missing: wanted.filter((e) => !installed.includes(e)),
      stale,
    };
  },
};
