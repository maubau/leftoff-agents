import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { TASKS_PATH, cleanTasks, counts, forProject, grouped, lastSource, taskPath, withTask, type OwnerTaskView } from "../src/web/public/ownertasks.js";

const task = (id: string, project: string, urgent = false, extra: Partial<OwnerTaskView> = {}): OwnerTaskView => ({ id, project, title: `Task ${id}`, urgent, status: "open", ...extra });

test("the panel shows only what can be shown of the hub's list, in the hub's order", () => {
  deepStrictEqual(cleanTasks(null), []);
  deepStrictEqual(cleanTasks({}), []);
  const good = task("OWN-2", "harbor", true);
  const list = cleanTasks([good, null, { id: 3 }, { id: "OWN-4", project: "harbor" }, task("OWN-5", "orchard", false, { status: "done" }), task("OWN-1", "orchard")]);
  deepStrictEqual(list.map((x) => x.id), ["OWN-2", "OWN-1"], "open, with an id, a project and a title");
  strictEqual(TASKS_PATH, "/api/owner-tasks?status=open");
  strictEqual(taskPath("OWN-12", "done"), "/api/owner-tasks/OWN-12/done");
  strictEqual(taskPath("a/b", "chat"), "/api/owner-tasks/a%2Fb/chat");
});

test("the Home groups by project in the order the hub ranked them; a project's page shows its own; the count says how many are urgent", () => {
  const list = [task("OWN-3", "orchard", true), task("OWN-1", "harbor"), task("OWN-2", "orchard")];
  deepStrictEqual(grouped(list, new Map([["orchard", "Orchard Club"]])).map((g) => [g.name, g.tasks.map((x) => x.id)]), [["Orchard Club", ["OWN-3", "OWN-2"]], ["harbor", ["OWN-1"]]]);
  deepStrictEqual(forProject(list, "harbor").map((x) => x.id), ["OWN-1"]);
  deepStrictEqual(counts(list), { open: 3, urgent: 1 });
  deepStrictEqual(counts([]), { open: 0, urgent: 0 });
});

test("a task that changes is replaced in place; closed, it leaves; new and urgent, it goes before the calm ones", () => {
  const list = [task("OWN-3", "orchard", true), task("OWN-1", "harbor")];
  deepStrictEqual(withTask(list, { ...list[1]!, title: "Renamed" }).map((x) => x.title), ["Task OWN-3", "Renamed"]);
  deepStrictEqual(withTask(list, { ...list[0]!, status: "done" }).map((x) => x.id), ["OWN-1"]);
  deepStrictEqual(withTask(list, task("OWN-7", "harbor", true)).map((x) => x.id), ["OWN-3", "OWN-7", "OWN-1"]);
  deepStrictEqual(withTask(list, task("OWN-8", "harbor")).map((x) => x.id), ["OWN-3", "OWN-1", "OWN-8"]);
  strictEqual(withTask(list, null), list);
});

test("where a task came from is its newest source", () => {
  strictEqual(lastSource(task("OWN-1", "h")), null);
  deepStrictEqual(lastSource(task("OWN-1", "h", false, { sources: [{ kind: "next", agent: "ux", at: "1" }, { kind: "question", agent: "main-dev", at: "2" }] })), { kind: "question", agent: "main-dev", at: "2" });
});

test("the page wires the view: Home and project sections, the header count, Done and drop by the hub, the task's chat", async () => {
  const app = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(app.includes("ownerTasksSection(null)") && app.includes("ownerTasksSection(p.id)"), "on the Home and on each project's page");
  ok(app.includes("ownerTasksPill()"), "a count in the header");
  ok(/jsonPost\(taskPath\(x\.id, how\), \{\}\)/.test(app), "Done and drop are the hub's");
  ok(app.includes('jsonPost(taskPath(x.id, "chat"), { text })'), "the task's chat goes to the task");
  ok(app.includes("if (e.status === 404) T.unsupported = true"), "a hub without tasks shows no section");
  ok(app.includes("richText(x.detail)"), "commands in a task's detail come with Copy (D-068)");
  const i18n = await readFile(new URL("../src/web/public/i18n.js", import.meta.url), "utf8");
  strictEqual(i18n.match(/^ {2}tasks: \{/gm)?.length, 6, "in the six languages");
});
