import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The command a hook config should invoke to reach this same Leftoff, as argv.
 *
 * Hooks run from arbitrary working directories under whatever PATH the host
 * gives them, so a bare `leftoff` is only safe if it is genuinely installed.
 * Otherwise we write an absolute invocation, which also keeps a checked-out
 * working copy usable without a global install.
 */
export async function resolveBinaryArgv(): Promise<string[]> {
  const override = process.env.LEFTOFF_BIN;
  if (override) return override.split(" ").filter(Boolean);

  // Write the absolute path even when `leftoff` is on PATH: agents started by a
  // daemon (Paseo) may not inherit the shell's PATH, and `doctor` compares
  // installed commands against this exact string.
  const onPath = await exec("sh", ["-c", "command -v leftoff"]).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  if (onPath) return [onPath];

  const self = fileURLToPath(new URL(import.meta.url));
  // Running from source (node src/cli.ts) vs from a build (node dist/cli.js).
  const entry = self.endsWith(".ts")
    ? fileURLToPath(new URL("../cli.ts", import.meta.url))
    : fileURLToPath(new URL("../cli.js", import.meta.url));
  return [process.execPath, entry];
}

/** Quote argv for a config field that a host passes through a shell. */
export function shellCommand(argv: readonly string[]): string {
  return argv.map((part) => (/[\s"'$`\\]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part)).join(" ");
}

export async function resolveBinary(): Promise<string> {
  return shellCommand(await resolveBinaryArgv());
}
