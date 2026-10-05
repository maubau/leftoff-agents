import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { createTask, removeCreatedTasks } from "../src/core/backlog.ts";
import { isolateHost, tempProject } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-review-tasks-");
});

const exists = (path: string) => access(path).then(() => true, () => false);

/** The ledger sits in the repository, so any agent can write it: its paths must never be trusted. */
async function forge(root: string, lines: Array<{ id: string; file: string }>): Promise<void> {
  await mkdir(join(root, ".leftoff"), { recursive: true });
  await writeFile(join(root, ".leftoff", "pm-tasks.jsonl"), lines.map((l) => JSON.stringify({ ...l, at: new Date().toISOString() })).join("\n") + "\n");
}

test("undoing a task the PM created still works", async () => {
  const p = await tempProject({ id: "undo", name: "Undo" });
  const made = await createTask(p, { title: "Pagina del tour", description: "x", acceptanceCriteria: ["Si apre"], labels: [], priority: "medium" });
  const res = await removeCreatedTasks(p, [made.id]);
  deepStrictEqual(res.removed, [made.id.toUpperCase()]);
  strictEqual(await exists(join(p.root, made.file)), false);
});

test("a ledger line pointing outside the repository deletes nothing", async () => {
  const p = await tempProject({ id: "escape", name: "Escape" });
  const outside = await mkdtemp(join(tmpdir(), "victim-"));
  const victim = join(outside, "precious.md");
  await writeFile(victim, "do not delete");
  await forge(p.root, [{ id: "TASK-1", file: join("..", "..", "..", "..", victim.slice(1)) }, { id: "TASK-2", file: victim }]);
  const res = await removeCreatedTasks(p, ["TASK-1", "TASK-2"]);
  deepStrictEqual(res.removed, []);
  deepStrictEqual(res.refused, ["TASK-1", "TASK-2"]);
  ok(await exists(victim), "a file outside the repository must survive, even with a .md name");
});

test("a ledger line cannot reach other files inside the repository either", async () => {
  const p = await tempProject({ id: "inside", name: "Inside" });
  await mkdir(join(p.root, "backlog", "tasks", "nested"), { recursive: true });
  const keep = [join(p.root, "README.md"), join(p.root, ".leftoff", "project.yaml"), join(p.root, "backlog", "tasks", "nested", "TASK-9 - x.md")];
  await writeFile(keep[2]!, "x");
  await forge(p.root, [
    { id: "A", file: "README.md" },
    { id: "B", file: join(".leftoff", "project.yaml") },
    { id: "C", file: join("backlog", "tasks", "nested", "TASK-9 - x.md") },
    { id: "D", file: join("backlog", "tasks", "..", "..", "README.md") },
    { id: "E", file: join("backlog", "tasks", "notes.txt") },
  ]);
  const res = await removeCreatedTasks(p, ["A", "B", "C", "D", "E"]);
  deepStrictEqual(res.removed, []);
  for (const file of keep) ok(await exists(file), file);
});
