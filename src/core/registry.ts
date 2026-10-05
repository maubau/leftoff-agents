import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { globalPaths } from "./paths.ts";

const EntrySchema = z.object({
  id: z.string(),
  path: z.string(),
  addedAt: z.string(),
});

const RegistrySchema = z.object({
  version: z.literal(1).default(1),
  projects: z.array(EntrySchema).default([]),
});

export type RegistryEntry = z.infer<typeof EntrySchema>;
export type Registry = z.infer<typeof RegistrySchema>;

/**
 * The list of repositories the hub watches. Purely an index: losing it costs
 * nothing that `leftoff init` cannot rebuild, since the truth lives in each repo.
 */
export async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(globalPaths.registry(), "utf8");
    return RegistrySchema.parse(JSON.parse(raw));
  } catch {
    return { version: 1, projects: [] };
  }
}

export async function writeRegistry(registry: Registry): Promise<void> {
  const file = globalPaths.registry();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export async function registerProject(id: string, path: string): Promise<void> {
  const registry = await readRegistry();
  const existing = registry.projects.findIndex((p) => p.path === path || p.id === id);
  const entry: RegistryEntry = { id, path, addedAt: new Date().toISOString() };
  if (existing >= 0) {
    entry.addedAt = registry.projects[existing]?.addedAt ?? entry.addedAt;
    registry.projects[existing] = entry;
  } else {
    registry.projects.push(entry);
  }
  await writeRegistry(registry);
}

export async function unregisterProject(idOrPath: string): Promise<boolean> {
  const registry = await readRegistry();
  const before = registry.projects.length;
  registry.projects = registry.projects.filter((p) => p.id !== idOrPath && p.path !== idOrPath);
  if (registry.projects.length === before) return false;
  await writeRegistry(registry);
  return true;
}
