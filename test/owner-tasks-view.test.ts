import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { FILE_MAX, TASKS_PATH, atBottom, cleanTasks, closedTasks, mergeTargets, similarTasks, counts, fileProblem, fileUrl, filesOf, filtered, firstOnes, forProject, grouped, helperStatus, isImage, lastSource, safeName, sizeText, taskPath, tasksHash, tasksRoute, uploadPath, withTask, type OwnerTaskView } from "../src/web/public/ownertasks.js";

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

test("a task that changes is re-ranked; closed, it leaves; urgent stays before calm and older first", () => {
  const list = [task("OWN-3", "orchard", true), task("OWN-1", "harbor")];
  deepStrictEqual(withTask(list, { ...list[1]!, title: "Renamed" }).map((x) => x.title), ["Task OWN-3", "Renamed"]);
  deepStrictEqual(withTask(list, { ...list[0]!, status: "done" }).map((x) => x.id), ["OWN-1"]);
  deepStrictEqual(withTask(list, task("OWN-7", "harbor", true)).map((x) => x.id), ["OWN-3", "OWN-7", "OWN-1"]);
  deepStrictEqual(withTask(list, task("OWN-8", "harbor")).map((x) => x.id), ["OWN-3", "OWN-1", "OWN-8"]);
  const calm = [...list, task("OWN-2", "harbor")];
  deepStrictEqual(withTask(calm, { ...calm[2]!, urgent: true }).map((x) => x.id), ["OWN-3", "OWN-2", "OWN-1"], "an existing task made urgent moves ahead at once");
  strictEqual(withTask(list, null), list);
});

test("where a task came from is its newest source", () => {
  strictEqual(lastSource(task("OWN-1", "h")), null);
  deepStrictEqual(lastSource(task("OWN-1", "h", false, { sources: [{ kind: "next", agent: "ux", at: "1" }, { kind: "question", agent: "main-dev", at: "2" }] })), { kind: "question", agent: "main-dev", at: "2" });
});

test("the tasks page has its own address, keeps a project filter, and puts the first ones on the Home", () => {
  deepStrictEqual(tasksRoute("#/tasks"), { task: null, project: null });
  deepStrictEqual(tasksRoute("#/tasks/own-7"), { task: "OWN-7", project: null });
  deepStrictEqual(tasksRoute("#/tasks/OWN-7?project=orchard%20club"), { task: "OWN-7", project: "orchard club" });
  strictEqual(tasksRoute("#/p/harbor"), null);
  strictEqual(tasksRoute("#/tasks/../p"), null);
  strictEqual(tasksHash({ task: "OWN-7", project: "harbor" }), "#/tasks/OWN-7?project=harbor");
  strictEqual(tasksHash(), "#/tasks");
  const list = [task("OWN-3", "orchard", true), task("OWN-1", "harbor"), task("OWN-2", "orchard"), task("OWN-4", "harbor")];
  deepStrictEqual(filtered(list, "harbor").map((x) => x.id), ["OWN-1", "OWN-4"]);
  deepStrictEqual(filtered(list, null).length, 4);
  deepStrictEqual(firstOnes(list).map((x) => x.id), ["OWN-3", "OWN-1", "OWN-2"], "three, in the hub's order");
});

test("whoever helps is shown working, or awaited; idle or nameless, nothing", () => {
  const helperNow = { id: "main-dev", name: "Andrea" };
  deepStrictEqual(helperStatus({ ...task("OWN-1", "h"), helperNow, helperState: { state: "working", since: "t" } }), { state: "working", name: "Andrea", since: "t" });
  strictEqual(helperStatus({ ...task("OWN-1", "h"), helperNow, helperState: { state: "waiting" } })?.state, "waiting");
  strictEqual(helperStatus({ ...task("OWN-1", "h"), helperNow, helperState: { state: "idle" } }), null);
  strictEqual(helperStatus({ ...task("OWN-1", "h"), helperState: { state: "working" } }), null);
  strictEqual(helperStatus(null), null);
});

test("images are attached within the limits, under a name that is never a path", () => {
  strictEqual(fileProblem({ type: "image/png", size: 1200 }), null);
  strictEqual(fileProblem({ type: "application/zip", size: 10 }), "type");
  strictEqual(fileProblem({ type: "image/jpeg", size: FILE_MAX + 1 }), "size");
  strictEqual(fileProblem({ type: "image/gif", size: 0 }), "empty");
  strictEqual(fileProblem(null), "type");
  strictEqual(safeName("../../etc/Schermata 2026-11-02 alle 10.31.png"), "Schermata-2026-11-02-alle-10.31.png");
  strictEqual(safeName("", "image/png"), "image.png");
  strictEqual(safeName("..", "image/jpeg"), "image.jpg");
  strictEqual(uploadPath("OWN-7", "a b.png"), "/api/owner-tasks/OWN-7/files?name=a%20b.png");
  strictEqual(fileUrl("harbor", "f1"), "/api/files/harbor/f1");
  deepStrictEqual(filesOf({ files: [{ id: "f1", name: "a.png", type: "image/png" }, { id: 3 }, null] }), [{ id: "f1", name: "a.png", type: "image/png" }]);
  ok(isImage({ type: "image/webp" }) && !isImage({ type: "application/pdf" }));
  strictEqual(sizeText(1536), "2 KB");
  strictEqual(sizeText(3 * 1024 * 1024), "3.0 MB");
});

test("a new line moves the chat to the bottom only if the owner was already there", () => {
  ok(atBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 380 }), "within a line of the bottom");
  ok(!atBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 380 }), "reading higher up: left where it is");
  ok(atBottom(null));
});

test("closed tasks are listed newest first, to reopen one closed by mistake", () => {
  const list = [
    task("OWN-1", "h", false, { status: "done", closedAt: "2026-11-01T10:00:00Z" } as Partial<OwnerTaskView>),
    task("OWN-2", "h"),
    task("OWN-3", "h", false, { status: "dropped", closedAt: "2026-11-02T10:00:00Z" } as Partial<OwnerTaskView>),
    null,
  ];
  deepStrictEqual(closedTasks(list).map((x) => x.id), ["OWN-3", "OWN-1"]);
  deepStrictEqual(closedTasks(undefined), []);
});

test("likely duplicates are the hub's (similar), still open; a merge goes to them first, then to the project's others", () => {
  const open = [task("OWN-1", "h"), task("OWN-2", "h"), task("OWN-3", "orchard"), task("OWN-4", "h")];
  const x = { ...open[0]!, similar: ["OWN-4", "OWN-9", "OWN-1"] };
  deepStrictEqual(similarTasks(x, open).map((y) => y.id), ["OWN-4"], "a closed or unknown one, or itself, is not offered");
  const { similar, others } = mergeTargets(x, open);
  deepStrictEqual([similar.map((y) => y.id), others.map((y) => y.id)], [["OWN-4"], ["OWN-2"]], "never another project's");
  deepStrictEqual(similarTasks(task("OWN-2", "h"), open), []);
});

test("the page wires the view: a menu entry, summaries, its own page built once, Done and drop, the chat with files", async () => {
  const app = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(app.includes("tasksMenu()"), "a menu entry with the count, in the header");
  ok(app.includes("tasksSummary(null)") && app.includes("tasksSummary(p.id)"), "the Home and a project's page: the count and the first three");
  ok(app.includes('S.route.page === "tasks") tasksPage(main)'), "its own page");
  ok(app.includes("if (!TP.root) buildTasksPage();") && app.includes("if (TP.shown !== want || TP.lang !== S.lang) buildTaskPane(x, chosen, want);"), "built once, the chat rebuilt only for another task");
  ok(app.includes("const follow = atBottom(TP.msgs)"), "a new line does not pull the owner down unless they were at the bottom");
  ok(/jsonPost\(taskPath\(x\.id, how\), \{\}\)/.test(app), "Done and drop are the hub's");
  ok(app.includes('jsonPost(taskPath(id, "chat"), { text, ...(files.length ? { files } : {}), ...(anyway ? { anyway: true } : {}) })'), "the chat sends text, files, and «anyway» only on a second tap");
  ok(app.includes('"x-leftoff-upload": "1"'), "an upload says what it is");
  ok(app.includes('jsonPost(taskPath(x.id, "reopen"), {})') && app.includes('jsonPost(taskPath(x.id, "merge"), { into })'), "Reopen and Merge into… are the hub's");
  ok(app.includes("L.similar(y.id)"), "likely duplicates are marked beside the title");
  ok(app.includes("onpaste:") && app.includes("ondrop") && app.includes('type: "file"'), "paste, drop, or the button");
  ok(app.includes("if (e.status === 404) T.unsupported = true"), "a hub without tasks shows none of it");
  ok(app.includes("richText(x.detail)"), "commands in a task's detail come with Copy (D-068)");
  ok(app.includes('id: "otask-new-title"') && app.includes("maxlength: 120"), "the task title stops where the store does");
  ok(app.includes("id: `task-in-${x.id}`") && app.includes("maxlength: 3500"), "the task chat stops where the API does");
  const i18n = await readFile(new URL("../src/web/public/i18n.js", import.meta.url), "utf8");
  strictEqual(i18n.match(/^ {2}tasks: \{/gm)?.length, 6, "in the six languages");
});
