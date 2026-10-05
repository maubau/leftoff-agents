import { loadProject } from "../core/project.ts";
import { readRegistry, unregisterProject } from "../core/registry.ts";
import { buildSnapshot, type Snapshot } from "../core/snapshot.ts";

export interface ProjectRow {
  id: string;
  path: string;
  ok: boolean;
  name?: string;
  headline?: Snapshot["headline"];
  lastActivityAt?: string;
  error?: string;
}

/** Everything the hub watches, with just enough status to spot trouble. */
export async function listProjects(): Promise<ProjectRow[]> {
  const registry = await readRegistry();
  const rows: ProjectRow[] = [];
  for (const entry of registry.projects) {
    try {
      const project = await loadProject(entry.path);
      const snapshot = await buildSnapshot(project);
      rows.push({
        id: project.id,
        path: entry.path,
        ok: true,
        name: project.config.name,
        headline: snapshot.headline,
        ...(snapshot.lastActivityAt ? { lastActivityAt: snapshot.lastActivityAt } : {}),
      });
    } catch (error) {
      rows.push({ id: entry.id, path: entry.path, ok: false, error: (error as Error).message });
    }
  }
  return rows;
}

export { unregisterProject };
