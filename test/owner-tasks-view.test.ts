import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { NUDGE_AFTER, POLL_WAITING, awaiting, lineState, withLine, megabytes, pasteKind, pastedName, previewLines, utf8Bytes, ORDER_KEY, TASK_ORDERS, orderGroups, readOrder, sortTasks, tasksPath, FILE_MAX, TASKS_PATH, atBottom, cleanTasks, closedTasks, mergeTargets, similarTasks, counts, fileProblem, fileUrl, filesOf, filtered, firstOnes, forProject, grouped, helperStatus, isImage, lastSource, safeName, sizeText, taskPath, tasksHash, tasksRoute, uploadPath, withTask, type OwnerTaskView, CHAT_TEXT_MAX, TASK_TEXT_MAX, textLength } from "../src/web/public/ownertasks.js";

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
  deepStrictEqual(counts(list), { open: 3, urgent: 1, blocking: 0 });
  deepStrictEqual(counts([]), { open: 0, urgent: 0, blocking: 0 });
});

test("a task that changes is re-ranked; closed, it leaves; urgent stays before calm and older first", () => {
  const list = [task("OWN-3", "orchard", true), task("OWN-1", "harbor")];
  deepStrictEqual(withTask(list, { ...list[1]!, title: "Renamed" }).map((x) => x.title), ["Task OWN-3", "Renamed"]);
  deepStrictEqual(withTask(list, { ...list[0]!, status: "done" }).map((x) => x.id), ["OWN-1"]);
  deepStrictEqual(withTask(list, task("OWN-7", "harbor", true)).map((x) => x.id), ["OWN-3", "OWN-7", "OWN-1"]);
  deepStrictEqual(withTask(list, task("OWN-8", "harbor")).map((x) => x.id), ["OWN-3", "OWN-1", "OWN-8"]);
  const calm = [...list, task("OWN-2", "harbor")];
  deepStrictEqual(withTask(calm, { ...calm[2]!, urgent: true }).map((x) => x.id), ["OWN-2", "OWN-3", "OWN-1"], "an existing task made urgent moves ahead at once (same age: the lower number first, as the hub does)");
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
  strictEqual(safeName("Città e città.png"), "Citta-e-citta.png", "accents dropped, not turned into dashes");
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

test("a long text: past a chat line it will become an attachment; at 80,000 it is the most the box takes (D-071)", async () => {
  deepStrictEqual([CHAT_TEXT_MAX, TASK_TEXT_MAX], [3500, 80000]);
  strictEqual(textLength(0), null);
  strictEqual(textLength(3500), null, "a full line is still a line");
  strictEqual(textLength(3501), "file");
  strictEqual(textLength(79_999), "file");
  strictEqual(textLength(80_000), "max");
  strictEqual(textLength(Number.NaN), null);
  const tasks = await readFile(new URL("../src/hub/owner-tasks.ts", import.meta.url), "utf8");
  ok(tasks.includes("export const CHAT_TEXT_MAX = 3500;") && tasks.includes("export const TASK_TEXT_MAX = 80_000;"), "the same limits as the hub's");
});

test("the order: urgent always first, then newest (the default), oldest, or by project — as the hub sorts", () => {
  const at = (d: string) => ({ createdAt: `2026-11-0${d}T10:00:00Z` }) as Partial<OwnerTaskView>;
  const list = [task("OWN-1", "orchard", false, at("1")), task("OWN-2", "harbor", false, at("3")), task("OWN-3", "orchard", true, at("2")), task("OWN-4", "atlas", false, at("4")), task("OWN-5", "harbor", false, at("2"))];
  deepStrictEqual(sortTasks(list).map((x) => x.id), ["OWN-3", "OWN-4", "OWN-2", "OWN-5", "OWN-1"], "newest");
  deepStrictEqual(sortTasks(list, "oldest").map((x) => x.id), ["OWN-3", "OWN-1", "OWN-5", "OWN-2", "OWN-4"]);
  deepStrictEqual(sortTasks(list, "project").map((x) => x.id), ["OWN-3", "OWN-4", "OWN-2", "OWN-5", "OWN-1"], "by project, newest within");
  deepStrictEqual(orderGroups(sortTasks(list, "project")).map((g) => [g.urgent ? "!" : g.project, g.tasks.map((x) => x.id)]), [["!", ["OWN-3"]], ["atlas", ["OWN-4"]], ["harbor", ["OWN-2", "OWN-5"]], ["orchard", ["OWN-1"]]], "the urgent ones together first, then one group per project");
  deepStrictEqual(withTask(sortTasks(list), task("OWN-6", "atlas", false, at("5")), "newest").map((x) => x.id)[1], "OWN-6", "a live change lands in the chosen order");
  deepStrictEqual([readOrder("oldest"), readOrder(null), readOrder("sideways")], ["oldest", "newest", "newest"]);
  deepStrictEqual(TASK_ORDERS, ["newest", "oldest", "project"]);
  strictEqual(tasksPath("project"), "/api/owner-tasks?status=open&sort=project");
  strictEqual(ORDER_KEY, "leftoff_tasks_order");
});

test("what blocks the team comes first in every order, above the urgent ones, and is counted (D-070, #132)", () => {
  const at = (d: string, more: Partial<OwnerTaskView> = {}) => ({ createdAt: `2026-11-0${d}T10:00:00Z`, ...more }) as Partial<OwnerTaskView>;
  const list = [
    task("OWN-1", "orchard", false, at("1")),
    task("OWN-2", "harbor", true, at("3")),
    task("OWN-3", "orchard", false, at("2", { blocking: true } as Partial<OwnerTaskView>)),
    task("OWN-4", "atlas", true, at("4", { blocking: true } as Partial<OwnerTaskView>)),
    task("OWN-5", "harbor", false, at("5")),
  ];
  deepStrictEqual(sortTasks(list).map((x) => x.id), ["OWN-4", "OWN-3", "OWN-2", "OWN-5", "OWN-1"], "newest");
  deepStrictEqual(sortTasks(list, "oldest").map((x) => x.id), ["OWN-4", "OWN-3", "OWN-2", "OWN-1", "OWN-5"], "oldest: blocking, then urgent, as ordered() does");
  deepStrictEqual(orderGroups(sortTasks(list, "project")).map((g) => [g.blocking ? "⛔" : g.urgent ? "!" : g.project, g.tasks.map((x) => x.id)]), [["⛔", ["OWN-4", "OWN-3"]], ["!", ["OWN-2"]], ["harbor", ["OWN-5"]], ["orchard", ["OWN-1"]]]);
  deepStrictEqual(counts(list), { open: 5, urgent: 2, blocking: 2 });
  deepStrictEqual(withTask(sortTasks(list), { ...list[0]!, blocking: true } as OwnerTaskView, "newest").map((x) => x.id).slice(0, 3), ["OWN-4", "OWN-3", "OWN-1"], "turned on, it moves up at once");
});

test("a paste longer than a chat line becomes a Markdown file; over 20 MB in UTF-8 bytes it is refused whole (OWN-126)", () => {
  strictEqual(pasteKind("a short sentence"), "box");
  strictEqual(pasteKind("x".repeat(3500)), "box", "a full chat line still goes in the box");
  strictEqual(pasteKind("x".repeat(3501)), "file");
  strictEqual(pasteKind("x".repeat(80_001)), "file", "past the box's own limit too: nothing is lost");
  strictEqual(pasteKind(undefined), "box");
  // The limit is in bytes: 20 MB of ASCII is 20 MB; «€» is three bytes, so 7 million of them are past it.
  strictEqual(utf8Bytes("€"), 3);
  strictEqual(pasteKind("x".repeat(20 * 1024 * 1024)), "file", "exactly 20 MB");
  strictEqual(pasteKind("x".repeat(20 * 1024 * 1024 + 1)), "too-big");
  strictEqual(pasteKind("€".repeat(7_000_000)), "too-big", "21 MB in UTF-8, though 7 million characters");
  strictEqual(pastedName(new Date(2026, 10, 6, 22, 3)), "incollato-20261106-2203.md");
  strictEqual(pastedName(new Date(2026, 0, 2, 9, 5), "pasted"), "pasted-20260102-0905.md");
  strictEqual(pastedName(new Date(2026, 0, 2, 9, 5), "eingefügt / ../x"), "eingefugt-x-20260102-0905.md", "never a path, nor an odd letter");
  strictEqual(safeName(pastedName(new Date(2026, 10, 6, 22, 3))), "incollato-20261106-2203.md", "the hub's name rule keeps it");
  deepStrictEqual(previewLines("\nfirst line\n\n  second\r\nthird\nfourth"), ["first line", "  second", "third"]);
  deepStrictEqual(previewLines("y".repeat(200), 3, 10), ["yyyyyyyyy…"]);
  strictEqual(fileProblem({ type: "text/markdown", size: 5000 }), null, "a pasted text is a file the hub takes");
  strictEqual(fileProblem({ type: "text/plain", size: 5000 }), "type", "the button still takes only images and .md");
  strictEqual(megabytes(21 * 1024 * 1024), "21.0");
});

test("under the owner's words: where they went, then working, then «not answered yet» after three minutes (#138)", () => {
  const now = Date.parse("2026-11-06T23:30:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const task = { helperNow: { id: "main-dev", name: "Andrea" }, helperState: { state: "idle" } };
  const sent = { id: "c1", role: "owner" as const, at: ago(10_000) };
  deepStrictEqual(lineState(sent, task, { now, waiting: true }), { kind: "sent", to: "main-dev" });
  const delivered = { ...sent, delivery: { state: "delivered" as const, to: "main-dev", at: ago(10_000) } };
  deepStrictEqual(lineState(delivered, task, { now, waiting: true }), { kind: "delivered", to: "main-dev" });
  strictEqual(lineState({ ...sent, delivery: { state: "queued" as const, to: "main-dev", at: ago(1000) } }, task, { now, waiting: true }).kind, "queued");
  strictEqual(lineState({ ...sent, delivery: { state: "pm" as const, to: "pm", at: ago(1000) } }, task, { now, waiting: true }).kind, "pm");
  strictEqual(lineState(delivered, { ...task, helperState: { state: "working" } }, { now, waiting: true }).kind, "working");
  strictEqual(lineState({ ...delivered, delivery: { ...delivered.delivery, at: ago(NUDGE_AFTER) } }, task, { now, waiting: true }).kind, "late");
  deepStrictEqual(lineState({ ...delivered, delivery: { ...delivered.delivery, at: ago(NUDGE_AFTER + 60_000), nudgedAt: ago(30_000) } }, task, { now, waiting: true }), { kind: "delivered", to: "main-dev" }, "asked again: three more minutes");
  strictEqual(lineState({ ...delivered, delivery: { ...delivered.delivery, at: ago(NUDGE_AFTER * 3) } }, task, { now, waiting: false }).kind, "delivered", "answered: just where it went");
  strictEqual(lineState({ ...sent, at: ago(NUDGE_AFTER + 1) }, task, { now, waiting: true }).kind, "late", "never delivered: late too");
  strictEqual(POLL_WAITING, 5000);
});

test("which words await an answer, and a line that comes again", () => {
  const o1 = { id: "a", role: "owner" }, h1 = { id: "b", role: "helper", agent: "main-dev" }, o2 = { id: "c", role: "owner" }, note = { id: "d", role: "helper", agent: "leftoff" };
  strictEqual(awaiting([o1, h1]), null, "answered");
  strictEqual(awaiting([o1, h1, o2]), o2);
  strictEqual(awaiting([o1, h1, o2, note]), o2, "Leftoff's own note answers nothing");
  strictEqual(awaiting([]), null);
  deepStrictEqual(withLine([o1, o2], { id: "a", role: "owner", delivery: { state: "delivered", to: "x", at: "t" } } as never).map((e: { id: string; delivery?: unknown }) => [e.id, Boolean(e.delivery)]), [["a", true], ["c", false]], "replaced where it is");
  deepStrictEqual(withLine([o1], h1 as never).map((e: { id: string }) => e.id), ["a", "b"]);
});

test("«queued» (#144): the helper is finishing something else — said as queued, never as working", () => {
  const task = { helperNow: { id: "main-dev", name: "Andrea" }, helperState: { state: "queued", since: "t" } };
  deepStrictEqual(helperStatus({ ...task, id: "OWN-1", project: "h", title: "x" } as never), { state: "queued", name: "Andrea", since: "t" });
  const line = { id: "c1", role: "owner" as const, at: new Date().toISOString(), delivery: { state: "delivered" as const, to: "main-dev", at: new Date().toISOString() } };
  strictEqual(lineState(line, task, { waiting: true }).kind, "queued");
  strictEqual(lineState(line, { ...task, helperState: { state: "working" } }, { waiting: true }).kind, "working");
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
  ok(app.includes('e.role === "owner" ? h("div", { class: "tp-delivery", "data-line": e.id') && app.includes("refreshDelivery(id);"), "a line under each of the owner's words");
  ok(app.includes('jsonPost(taskPath(x.id, "nudge"), {})') && app.includes("e.status === 429 ? L.nudgeSoon : e.status === 409 ? L.nudgeNothing"), "Ask again, with the hub's refusals said");
  ok(app.includes("}, POLL_WAITING);") && app.includes("!awaiting(c.entries)"), "every five seconds while an answer is awaited");
  ok(app.includes('jsonPost(taskPath(x.id, "blocking"), { on })') && app.includes('role: "switch", "aria-checked": String(x.blocking === true)'), "«Blocks the team» is a switch in the task, kept by the hub");
  ok(app.includes("const urgent = T.list.filter((x) => x.urgent === true || x.blocking === true).length;"), "the header's number counts what is urgent or blocks the team, each task once");
  ok(app.includes("onchange: (ev) => pickMerge(x, ev.target.value)") && !/onchange: \(ev\) => \{ if \(ev\.target\.value\) void mergeTask/.test(app), "choosing whom to merge into only asks");
  ok(app.includes("onclick: () => { T.mergePick = null; void mergeTask(x, pick); }"), "the merge is the second tap's");
  ok(app.includes("onpaste:") && app.includes("ondrop") && app.includes('type: "file"'), "paste, drop, or the button");
  ok(app.includes('addFiles(id, [new File([text], pastedName(new Date(), L.pastedPrefix), { type: "text/markdown" })], text)') && app.includes('if (kind === "too-big") { showTaskError(L.pasteTooBig('), "a long paste becomes a file; one too big is refused whole");
  ok(app.includes("if (e.status === 404) T.unsupported = true"), "a hub without tasks shows none of it");
  ok(app.includes("richText(x.detail)"), "commands in a task's detail come with Copy (D-068)");
  ok(app.includes('id: "otask-new-title"') && app.includes("maxlength: 120"), "the task title stops where the store does");
  ok(app.includes("id: `task-in-${x.id}`") && app.includes("maxlength: TASK_TEXT_MAX"), "the task chat stops where the API does: 80,000, past 3,500 an attachment");
  const i18n = await readFile(new URL("../src/web/public/i18n.js", import.meta.url), "utf8");
  strictEqual(i18n.match(/^ {2}tasks: \{/gm)?.length, 6, "in the six languages");
});
