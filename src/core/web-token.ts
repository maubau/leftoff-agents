import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { globalPaths } from "./paths.ts";

/**
 * The control panel's password. On loopback the panel used to need none, which leaves it open to
 * any process on the machine — including the agents it supervises. It now always has one: if the
 * owner has not chosen it, a random 256-bit value is generated once and kept in secrets.env, which
 * is private to the owner (0600). It is never written to a log; `leftoff web link` prints it on demand.
 */
export const WEB_TOKEN_KEY = "LEFTOFF_WEB_TOKEN";

const LINE = new RegExp(`^\\s*(?:export\\s+)?${WEB_TOKEN_KEY}\\s*=.*$`, "m");

async function readSecrets(): Promise<string> {
  return readFile(globalPaths.secrets(), "utf8").catch(() => "");
}

/** Write-then-rename, private from the first byte: a half-written secrets file would lock the owner out. */
async function writeSecrets(content: string): Promise<void> {
  const file = globalPaths.secrets();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

const newToken = () => randomBytes(32).toString("hex");

/**
 * Make sure the panel has a password and return it. An existing one — from the environment (secrets.env
 * is loaded into it) — is never touched, so a password the owner chose stays theirs.
 */
export async function ensureWebToken(env: NodeJS.ProcessEnv = process.env): Promise<{ token: string; created: boolean }> {
  const existing = env[WEB_TOKEN_KEY]?.trim();
  if (existing) return { token: existing, created: false };

  const current = await readSecrets();
  const token = newToken();
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeSecrets(`${current}${separator}${WEB_TOKEN_KEY}=${token}\n`);
  env[WEB_TOKEN_KEY] = token;
  return { token, created: true };
}

/** A new password, replacing the old one in secrets.env. The hub must be restarted to use it. */
export async function rotateWebToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const current = await readSecrets();
  const token = newToken();
  const line = `${WEB_TOKEN_KEY}=${token}`;
  const next = LINE.test(current)
    ? current.replace(LINE, line)
    : `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`;
  await writeSecrets(next);
  env[WEB_TOKEN_KEY] = token;
  return token;
}

/** What is stored right now, without generating anything. */
export async function storedWebToken(): Promise<string | undefined> {
  const match = new RegExp(`^\\s*(?:export\\s+)?${WEB_TOKEN_KEY}\\s*=\\s*(.*?)\\s*$`, "m").exec(await readSecrets());
  return match?.[1]?.replace(/^(['"])(.*)\1$/, "$2") || undefined;
}

/** The address to open once; the panel turns it into a cookie and drops the token from the URL. */
export function webLink(web: Config["web"], token: string): string {
  const host = web.host === "0.0.0.0" || web.host === "::" ? "localhost" : web.host;
  return `http://${host}:${web.port}/?token=${token}`;
}
