import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backup, readJson, writeJson } from "./files.ts";
import { describeInstalled, mergeHooks, removeHooks, type HookMap } from "./hookmap.ts";
import type { Host, HookSpec, HostRoot, HostStatus, InstallResult } from "./types.ts";

interface HooksFile {
  hooks?: HookMap;
  [key: string]: unknown;
}

/**
 * Codex's hook events, verified against codex 0.153.4, are PreToolUse,
 * PermissionRequest, PostToolUse, Pre/PostCompact, SessionStart, SessionEnd,
 * UserPromptSubmit, SubagentStart, SubagentStop and Interrupt — there is **no
 * per-turn Stop event**, unlike Claude Code. End of turn is therefore wired
 * through the legacy `notify` program instead (see docs/decisions.md D-003).
 */
function specs(binary: string): HookSpec[] {
  return [
    { event: "SessionStart", command: `${binary} hook codex session-start`, timeoutSec: 15 },
    {
      event: "UserPromptSubmit",
      command: `${binary} hook codex user-prompt-submit`,
      timeoutSec: 15,
    },
    { event: "SessionEnd", command: `${binary} hook codex session-end`, timeoutSec: 20 },
  ];
}

/** Undo `shellCommand` for the one place Codex wants argv rather than a shell string. */
function splitBinary(binary: string): string[] {
  return (binary.match(/'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^'(.*)'$/, "$1"));
}

const hooksFile = (dir: string) => join(dir, "hooks", "hooks.json");
const configFile = (dir: string) => join(dir, "config.toml");

async function detectRoots(): Promise<HostRoot[]> {
  const dir = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  return [{ hostId: "codex", dir, origin: process.env.CODEX_HOME ? "CODEX_HOME" : "default" }];
}

/** Where a top-level key may still be written: everything before the first `[table]`. */
function topLevelEnd(lines: readonly string[]): number {
  const index = lines.findIndex((l) => /^\s*\[/.test(l));
  return index === -1 ? lines.length : index;
}

const NOTIFY_LINE = /^\s*notify\s*=/;

/** The argv tail that identifies a `notify` program as ours. */
const NOTIFY_TAIL = ["hook", "codex", "notify"] as const;

function notifyArgv(line: string): string[] | null {
  const rhs = line.slice(line.indexOf("=") + 1).trim();
  try {
    const value: unknown = JSON.parse(rhs);
    return Array.isArray(value) ? value.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * `notify` is a TOML array of argv strings, so the plain command marker used for
 * shell-style hooks does not appear in it. Identify our own entry by its argv
 * tail instead — nothing else on the machine writes `["…", "hook", "codex", "notify"]`.
 */
function isOurNotify(line: string): boolean {
  const argv = notifyArgv(line);
  if (!argv || argv.length < NOTIFY_TAIL.length + 1) return false;
  return argv.slice(-NOTIFY_TAIL.length).every((part, i) => part === NOTIFY_TAIL[i]);
}

/**
 * Set `notify` in config.toml with a line-level edit rather than a parse and
 * re-serialize, so the user's comments, ordering and formatting survive intact.
 */
async function setNotify(file: string, command: string[] | null): Promise<"changed" | "same"> {
  const raw = await readFile(file, "utf8").catch(() => "");
  const lines = raw.split("\n");
  const limit = topLevelEnd(lines);
  const existing = lines.slice(0, limit).findIndex((l) => NOTIFY_LINE.test(l));
  const rendered = command ? `notify = ${JSON.stringify(command)}` : null;

  if (existing >= 0) {
    const current = lines[existing];
    const ours = current ? isOurNotify(current) : false;
    if (rendered === null) {
      if (!ours) return "same"; // never remove a notify program we did not install
      lines.splice(existing, 1);
    } else {
      if (current === rendered) return "same";
      if (!ours && current?.trim()) {
        throw new Error(
          `${file} already sets \`notify\` to something else.\n` +
            `Leftoff will not overwrite it. Chain it yourself, or remove it and re-run.`,
        );
      }
      lines[existing] = rendered;
    }
  } else {
    if (rendered === null) return "same";
    lines.splice(limit, 0, rendered, "");
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, lines.join("\n"), "utf8");
  return "changed";
}

async function notifyState(file: string): Promise<"ours" | "foreign" | "absent"> {
  const raw = await readFile(file, "utf8").catch(() => "");
  const all = raw.split("\n");
  const lines = all.slice(0, topLevelEnd(all));
  const line = lines.find((l) => NOTIFY_LINE.test(l));
  if (!line) return "absent";
  return isOurNotify(line) ? "ours" : "foreign";
}

export const codex: Host = {
  id: "codex",
  label: "Codex",

  detectRoots,

  async install(root, binary): Promise<InstallResult> {
    const hFile = hooksFile(root.dir);
    const cFile = configFile(root.dir);
    const current = await readJson<HooksFile>(hFile, {});
    const { map, installed, alreadyPresent } = mergeHooks(current.hooks ?? {}, specs(binary));
    const backups: string[] = [];
    if (installed.length > 0) {
      const b = await backup(hFile);
      if (b) backups.push(b);
      await writeJson(hFile, { ...current, hooks: map });
    }

    const b2 = await backup(cFile);
    const notify = await setNotify(cFile, [...splitBinary(binary), ...NOTIFY_TAIL]);
    if (notify === "changed") {
      installed.push("notify(agent-turn-complete)");
      if (b2) backups.push(b2);
    } else {
      alreadyPresent.push("notify(agent-turn-complete)");
    }

    return {
      root,
      files: [hFile, cFile],
      backups,
      installed,
      alreadyPresent,
      manual:
        installed.length > 0
          ? ["Codex asks you to trust changed hooks the next time it starts — accept once."]
          : [],
    };
  },

  async uninstall(root): Promise<InstallResult> {
    const hFile = hooksFile(root.dir);
    const cFile = configFile(root.dir);
    const current = await readJson<HooksFile>(hFile, {});
    const { map, removed } = removeHooks(current.hooks ?? {});
    const backups: string[] = [];
    if (removed.length > 0) {
      const b = await backup(hFile);
      if (b) backups.push(b);
      const next: HooksFile = { ...current, hooks: map };
      if (Object.keys(map).length === 0) delete next.hooks;
      await writeJson(hFile, next);
    }
    if ((await notifyState(cFile)) === "ours") {
      const b = await backup(cFile);
      if (b) backups.push(b);
      await setNotify(cFile, null);
      removed.push("notify(agent-turn-complete)");
    }
    return { root, files: [hFile, cFile], backups, installed: [], alreadyPresent: removed, manual: [] };
  },

  async status(root, binary): Promise<HostStatus> {
    const hFile = hooksFile(root.dir);
    const current = await readJson<HooksFile>(hFile, {}).catch(() => ({}) as HooksFile);
    const { installed, stale } = describeInstalled(current.hooks ?? {}, binary);
    const wanted = specs(binary).map((s) => s.event);
    const missing = wanted.filter((e) => !installed.includes(e));

    const notify = await notifyState(configFile(root.dir));
    if (notify === "ours") installed.push("notify(agent-turn-complete)");
    else missing.push("notify(agent-turn-complete)");
    if (notify === "foreign") stale.push("config.toml `notify` is set to another program");

    return { root, exists: installed.length > 0 || notify !== "absent", installed, missing, stale };
  },
};
