import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Copy a file to `<file>.leftoff-backup-<timestamp>` before it is rewritten. */
export async function backup(file: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.leftoff-backup-${stamp}`;
  try {
    await copyFile(file, target);
    return target;
  } catch {
    return null; // nothing to back up yet
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null || raw.trim() === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${file} is not valid JSON; refusing to overwrite it`);
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function exists(path: string): Promise<boolean> {
  return (await readFile(path, "utf8").catch(() => null)) !== null;
}
