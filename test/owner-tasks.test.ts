import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { IncomingMessage, SendOptions } from "../src/channels/channel.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { createTask, readTasks } from "../src/core/backlog.ts";
import { ConfigSchema } from "../src/core/config.ts";
import type { Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { addOwnerTask, closeOwnerTask, listOwnerTasks, ownerItem } from "../src/hub/owner-tasks.ts";
import { isolateHost, tempProject } from "./helpers.ts";

/** «Your tasks» (D-070), phase 1. Invented projects and agents. */
beforeEach(async () => {
  await isolateHost("leftoff-owner-tasks-");
});

const base = { done: [], doing: [], blocked: [], next: [], option: [] };

test("one task per thing: the same words twice are one task, reopened within a week once closed", async () => {
  const now = new Date("2026-11-01T09:00:00Z");
  const a = await addOwnerTask({ project: "harbor", title: "Add the DNS record for the tour", source: "next", agent: "ux" }, now);
  const b = await addOwnerTask({ project: "harbor", title: "add the DNS record, for the tour!", source: "pm" }, now);
  deepStrictEqual([a.created, b.created, b.task.id], [true, false, a.task.id]);
  strictEqual(b.task.sources.length, 2);
  const other = await addOwnerTask({ project: "lighthouse", title: "Add the DNS record for the tour", source: "owner" }, now);
  ok(other.created, "another project is another task");
  await closeOwnerTask(a.task.id, { status: "done", by: "owner" }, now);
  const again = await addOwnerTask({ project: "harbor", title: "Add the DNS record for the tour", source: "next" }, new Date("2026-11-03T09:00:00Z"));
  deepStrictEqual([again.created, again.reopened, again.task.id, again.task.status], [false, true, a.task.id, "open"]);
  const secret = await addOwnerTask({ project: "harbor", title: "Rotate the key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd", source: "pm" }, now);
  ok(!secret.task.title.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "a secret is redacted before it is kept");
  strictEqual(ownerItem("Titolare: lancia lo script"), "lancia lo script");
  strictEqual(ownerItem("Martin: review"), undefined);
});

async function setup() {
  const harbor: Project = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX" }] });
  await registerProject("harbor", harbor.root);
  const vault: Project = await tempProject({ id: "vault", name: "Vault", visibility: "private", agents: [{ id: "dev", control: "inbox", host: "claude-code" }] });
  await registerProject("vault", vault.root);
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const hub = new Hub({ config, channel, toolExec: async () => ({ stdout: "" }), log: () => undefined });
  const replies: Array<{ text: string; options?: SendOptions | undefined }> = [];
  const say = (text: string, projectId: string | null = "harbor") =>
    hub.handle({ text, projectId, threadKey: projectId ?? "general", reply: async (r, options) => void replies.push({ text: r, options }), typing: async () => undefined } as IncomingMessage);
  return { harbor, vault, hub, channel, say, replies };
}

test("tasks are born from reports, without duplicates; a question closes when the agent moves on; never in a private project", async () => {
  const { harbor, vault, hub } = await setup();
  let t = Date.now();
  await hub.tick(new Date(t));
  await report(harbor, { ...base, agent: "ux", status: "needs_input", next: ["Titolare: add the DNS record"], question: "Week or month view first?", option: ["Week", "Month"], handoff: ["owner: try the tour on a phone"] } as never);
  await report(harbor, { ...base, agent: "ux", status: "needs_input", next: ["Owner: add the DNS record"], question: "Week or month view first?", option: ["Week", "Month"] } as never);
  await report(vault, { ...base, agent: "dev", status: "progress", next: ["Owner: renew the secret thing"] } as never);
  await hub.tick(new Date((t += 60_000)));
  const open = await listOwnerTasks({ status: "open" });
  deepStrictEqual(open.map((x) => x.title).sort(), ["Add the DNS record", "Answer Harbor UX: Week or month view first?", "Try the tour on a phone"]);
  ok(open.every((x) => x.project === "harbor"), "nothing from the private project");
  ok(open.find((x) => x.title.startsWith("Answer"))!.urgent, "a question is urgent");

  await report(harbor, { ...base, agent: "ux", status: "progress", doing: ["Building the week view"] } as never);
  await hub.tick(new Date((t += 60_000)));
  deepStrictEqual((await listOwnerTasks({ status: "open" })).map((x) => x.title).sort(), ["Add the DNS record", "Try the tour on a phone"], "the question was answered");
});

test("/tasks lists with Done buttons, /task adds, /done closes, an agent's check closes, and the stand-up shows them", async () => {
  const { harbor, hub, say, replies } = await setup();
  let t = Date.now();
  await hub.tick(new Date(t));
  await say("/task renew the domain");
  match(replies.at(-1)!.text, /📌 Task OWN-1 \(Harbor\): renew the domain/);
  await say("/task Harbor: add the DNS record", null);
  await say("/task renew the domain");
  match(replies.at(-1)!.text, /Already there: OWN-1/);
  await say("/tasks", null);
  match(replies.at(-1)!.text, /📌 Your tasks \(2\):\nHarbor\n• OWN-2 add the DNS record · since [^\n]+\n• OWN-1 renew the domain/, "newest first, as in the panel");
  deepStrictEqual(replies.at(-1)!.options!.choices!.map((c) => c.reply), ["/done OWN-2", "/done OWN-1"]);
  await say("/done OWN-1");
  match(replies.at(-1)!.text, /✅ OWN-1 done: renew the domain/);
  await say("/done OWN-1");
  match(replies.at(-1)!.text, /No open task OWN-1/);

  await report(harbor, { ...base, agent: "ux", status: "done", done: ["DNS checked"], ownerDone: ["OWN-2"] } as never);
  await hub.tick(new Date((t += 60_000)));
  deepStrictEqual(await listOwnerTasks({ status: "open" }), []);
  strictEqual((await listOwnerTasks({ status: "done" })).find((x) => x.id === "OWN-2")!.closedBy, "ux", "verified by the agent");

  await say("/task try the tour on a phone");
  const standup = await hub.standup([harbor]);
  match(standup, /📌 Today you still have these tasks:\nHarbor\n• OWN-3 try the tour on a phone/);
});

test("every task of an agent's instructions closes when it says done, not only the last one", async () => {
  const { harbor, hub } = await setup();
  let t = Date.now();
  await hub.tick(new Date(t));
  const first = await createTask(harbor, { title: "First instruction", description: "", acceptanceCriteria: [], labels: [], priority: "medium", assignee: ["ux"], status: "In Progress" });
  const second = await createTask(harbor, { title: "Second instruction", description: "", acceptanceCriteria: [], labels: [], priority: "medium", assignee: ["ux"], status: "In Progress" });
  hub.state.taskOf["harbor:ux"] = [first.id, second.id];
  await report(harbor, { ...base, agent: "ux", status: "done", done: ["Both done"] } as never);
  await hub.tick(new Date((t += 60_000)));
  const tasks = await readTasks(harbor);
  deepStrictEqual(tasks.filter((x) => [first.id, second.id].includes(x.id)).map((x) => x.status), ["Done", "Done"]);
  strictEqual(hub.state.taskOf["harbor:ux"], undefined);
});

test("the stand-up says what was finished since yesterday (D-072)", async () => {
  const { harbor, hub } = await setup();
  await report(harbor, { ...base, agent: "ux", status: "done", done: ["The week view ships"] } as never);
  match(await hub.standup([harbor]), /✅ Harbor UX: The week view ships/);
});

test("the same thing in other words is one task; alike but different stays two, marked as likely duplicates; merge and reopen (D-070)", async () => {
  const { likelyDuplicates, mergeOwnerTasks, reopenOwnerTask, titleSimilarity } = await import("../src/hub/owner-tasks.ts");
  const now = new Date("2026-11-02T09:00:00Z");
  const a = await addOwnerTask({ project: "harbor", title: "In the hosting panel → VPS, confirm where the server is (Lisbon?)", source: "next", agent: "ux" }, now);
  const b = await addOwnerTask({ project: "harbor", title: "Confirm in the hosting panel where the server is (VPS → Lisbon?)", source: "pm" }, now);
  deepStrictEqual([b.created, b.task.id], [false, a.task.id], "the same root words: folded into the open one");
  const c = await addOwnerTask({ project: "harbor", title: "confirming in the hosting panel that the VPS is in Lisbon", source: "next", agent: "qa" }, now);
  ok(c.created, "alike, not the same: a task of its own");
  deepStrictEqual(likelyDuplicates(c.task, await listOwnerTasks({ status: "open" })), [a.task.id], "but marked as a likely duplicate");
  const staging = await addOwnerTask({ project: "harbor", title: "Add the payment key to the staging env", source: "next" }, now);
  const prod = await addOwnerTask({ project: "harbor", title: "Add the payment key to the production env", source: "next" }, now);
  ok(prod.created && titleSimilarity(staging.task.title, prod.task.title).jaccard < 0.85, "staging and production are two tasks");

  const merged = await mergeOwnerTasks([c.task.id], a.task.id, "ops", now);
  ok("into" in merged);
  const all = await listOwnerTasks();
  const gone = all.find((t) => t.id === c.task.id)!;
  deepStrictEqual([gone.status, gone.mergedInto], ["dropped", a.task.id]);
  ok(all.find((t) => t.id === a.task.id)!.sources.some((s) => s.agent === "qa"), "its sources moved over");
  const again = await addOwnerTask({ project: "harbor", title: "confirming in the hosting panel that the VPS is in Lisbon", source: "next", agent: "qa" }, now);
  deepStrictEqual([again.created, again.task.id], [false, a.task.id], "its words again go to the task it went into");
  const other = await addOwnerTask({ project: "lighthouse", title: "Something else", source: "owner" }, now);
  deepStrictEqual(await mergeOwnerTasks([other.task.id], a.task.id, "ops", now), { refused: `${other.task.id} is in another project` });

  await closeOwnerTask(staging.task.id, { status: "done", by: "owner" }, now);
  const back = await reopenOwnerTask(staging.task.id, now);
  deepStrictEqual([back?.status, back?.closedBy], ["open", undefined]);
  strictEqual(await reopenOwnerTask(staging.task.id, now), undefined, "only a closed task");
});

test("never folded by itself: a negation, another version, another day, a name more, a word with the same root (D-070)", async () => {
  const now = new Date("2026-11-02T09:00:00Z");
  const pairs: Array<[string, string]> = [
    ["Publish version 2.0 on npm", "Do not publish version 2.0 on npm"],
    ["Pubblica la versione 2.0 su npm", "Non pubblicare la versione 2.0 su npm"],
    ["Publish release 1.0.0 on npm", "Publish release 1.0.1 on npm"],
    ["Renew the payment key today", "Renew the payment key tomorrow"],
    ["Remove alice from the organization developers team", "Remove alice and bob from the organization developers team"],
    ["Confirm the server region for the tour", "Configure the server region for the tour"],
  ];
  for (const [i, [first, second]] of pairs.entries()) {
    const project = `p${i}`;
    const a = await addOwnerTask({ project, title: first, source: "next" }, now);
    const b = await addOwnerTask({ project, title: second, source: "next" }, now);
    ok(b.created && b.task.id !== a.task.id, `${second} is a task of its own`);
  }
  // The same words in another order, with fewer of them: folded, nothing lost.
  const long = await addOwnerTask({ project: "q", title: "Close decision #53 before phase 2 of the cloned voice", source: "next" }, now);
  const short = await addOwnerTask({ project: "q", title: "phase 2 of the cloned voice: close decision #53, before", source: "pm" }, now);
  strictEqual(short.task.id, long.task.id);
});

test("a merged task reopened gets its own words back (D-070)", async () => {
  const { mergeOwnerTasks, reopenOwnerTask } = await import("../src/hub/owner-tasks.ts");
  const now = new Date("2026-11-02T09:00:00Z");
  const a = await addOwnerTask({ project: "harbor", title: "Choose the mailbox for the invitations", source: "next" }, now);
  const b = await addOwnerTask({ project: "harbor", title: "Pick which address sends the invites", source: "pm" }, now);
  await mergeOwnerTasks([b.task.id], a.task.id, "ops", now);
  await reopenOwnerTask(b.task.id, now);
  const again = await addOwnerTask({ project: "harbor", title: "Pick which address sends the invites", source: "pm" }, now);
  strictEqual(again.task.id, b.task.id);
});

test("the orders: urgent always first, then newest, oldest, or by project (D-070)", async () => {
  const { ordered } = await import("../src/hub/owner-tasks.ts");
  const t = (id: string, project: string, day: number, urgent = false) =>
    ({ id, project, title: id, detail: "", sources: [], urgent, status: "open", createdAt: `2026-11-0${day}T09:00:00Z`, updatedAt: "", fingerprint: id }) as never;
  const list = [t("OWN-1", "lighthouse", 1), t("OWN-2", "harbor", 2), t("OWN-3", "harbor", 3, true), t("OWN-4", "lighthouse", 4)];
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
  deepStrictEqual(ids(ordered(list, "newest")), ["OWN-3", "OWN-4", "OWN-2", "OWN-1"]);
  deepStrictEqual(ids(ordered(list, "oldest")), ["OWN-3", "OWN-1", "OWN-2", "OWN-4"]);
  deepStrictEqual(ids(ordered(list, "project")), ["OWN-3", "OWN-2", "OWN-4", "OWN-1"], "by project, newest first within each");
  deepStrictEqual(ids(ordered(list)), ids(ordered(list, "oldest")), "the stand-up keeps urgency and age");
  const odd = [t("OWN-7", "harbor", 9), ({ ...(t("OWN-8", "harbor", 1) as object), createdAt: "not a date" }) as never, t("OWN-9", "harbor", 2)];
  deepStrictEqual(ids(ordered(odd, "oldest")), ids(ordered([...odd].reverse(), "oldest")), "the same order whatever the list's");
});

test("/tasks buttons follow the order the text shows, project by project (D-070)", async () => {
  const { harbor, say, replies } = await setup();
  void harbor;
  const lighthouse = await tempProject({ id: "lighthouse", name: "Lighthouse", agents: [{ id: "qa", control: "inbox", host: "claude-code" }] });
  await registerProject("lighthouse", lighthouse.root);
  await addOwnerTask({ project: "harbor", title: "Older in harbor", source: "owner" }, new Date("2026-11-01T09:00:00Z"));
  await addOwnerTask({ project: "lighthouse", title: "Newest of all, in lighthouse", source: "owner" }, new Date("2026-11-05T09:00:00Z"));
  await addOwnerTask({ project: "harbor", title: "Newer in harbor", source: "owner" }, new Date("2026-11-03T09:00:00Z"));
  await say("/tasks", null);
  const text = replies.at(-1)!.text;
  const order = [...text.matchAll(/• (OWN-\d+)/g)].map((x) => x[1]!);
  deepStrictEqual(replies.at(-1)!.options!.choices!.map((c) => c.reply.replace("/done ", "")), order);
});

test("a task born from an agent's note gets a title to find it by; the whole note goes to the detail (D-070)", async () => {
  const { cleanTitle } = await import("../src/hub/owner-tasks.ts");
  strictEqual(cleanTitle("OWN-13 — turn the production on: follow list #291 step by step").title, "Turn the production on: follow list #291 step by step");
  strictEqual(cleanTitle("OWN-21 OWN-19 — the list on main, step E: https://example.invalid/list").title, "The list on main, step E");
  strictEqual(cleanTitle("Owner: run `npm run deploy` and confirm").title, "Run … and confirm");
  strictEqual(cleanTitle("close the switch-on, as root: 1) `systemctl enable tour` 2) restart").title, "Close the switch-on, as root");
  strictEqual(cleanTitle("where does the invite form go on the home? Anna proposes the bottom, with two buttons on top and a note").title, "Where does the invite form go on the home?");
  const now = new Date("2026-11-06T09:00:00Z");
  const { task } = await addOwnerTask({ project: "harbor", title: "OWN-13 — turn the production on: run `make prod` as root, then tell me", source: "next", agent: "ux" }, now);
  strictEqual(task.title, "Turn the production on: run … as root, then tell me");
  match(task.detail, /make prod/, "the whole note, command included, is in the detail");
  const own = await addOwnerTask({ project: "harbor", title: "OWN-2 my own words, as typed", source: "owner" }, now);
  strictEqual(own.task.title, "OWN-2 my own words, as typed", "the owner's own words stay as typed");
});

test("what blocks the team: from a blocked or waiting agent, above urgent ones, first in the stand-up; flagged and unflagged (D-070)", async () => {
  const { harbor, hub, say, replies } = await setup();
  let t = Date.now();
  await hub.tick(new Date(t));
  await report(harbor, { ...base, agent: "ux", status: "progress", next: ["Owner: review the tour copy"] } as never);
  await report(harbor, { ...base, agent: "ux", status: "blocked", blocked: ["No production keys"], next: ["Owner: add the production keys to the server"] } as never);
  await hub.tick(new Date((t += 60_000)));
  await addOwnerTask({ project: "harbor", title: "Renew the domain today", source: "owner", urgent: true });
  const open = await listOwnerTasks({ status: "open" });
  const keys = open.find((x) => x.title.startsWith("Add the production keys"))!;
  ok(keys.blocking, "the blocked agent waits for it");
  ok(!open.find((x) => x.title.startsWith("Review the tour copy"))!.blocking);
  const { ordered } = await import("../src/hub/owner-tasks.ts");
  strictEqual(ordered(open, "newest")[0]!.id, keys.id, "above the urgent one");

  const standup = await hub.standup([harbor]);
  const lines = standup.split("\n");
  strictEqual(lines[1], "⛔ The team is waiting for you on:", "right under the title");
  match(lines[2]!, new RegExp(`• ${keys.id} Add the production keys to the server \\(Harbor\\)`));
  await say("/tasks", null);
  match(replies.at(-1)!.text, new RegExp(`• ⛔ ${keys.id} Add the production keys`));

  const { setBlocking } = await import("../src/hub/owner-tasks.ts");
  await setBlocking(keys.id, false);
  ok(!(await hub.standup([harbor])).includes("waiting for you on"), "no line when nothing blocks");
});

test("titles made before were tidied once, their old words still find them (D-070)", async () => {
  const { tidyTitles } = await import("../src/hub/owner-tasks.ts");
  const { writeFile } = await import("node:fs/promises");
  const { ownerTasksFile } = await import("../src/hub/owner-tasks.ts");
  const raw = "OWN-13 — turn the production on: follow list #291 step by step";
  const old = { id: "OWN-1", project: "harbor", title: raw, detail: "", sources: [{ kind: "next", agent: "ux", at: "2026-11-05T09:00:00Z" }], urgent: false, status: "open", createdAt: "2026-11-05T09:00:00Z", updatedAt: "2026-11-05T09:00:00Z", fingerprint: "harbor:own 13 turn the production on follow list 291 step by step" };
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(ownerTasksFile()), { recursive: true });
  await writeFile(ownerTasksFile(), JSON.stringify({ next: 2, tasks: [old] }));
  strictEqual(await tidyTitles(), 1);
  const [task] = await listOwnerTasks();
  strictEqual(task!.title, "Turn the production on: follow list #291 step by step");
  strictEqual(task!.detail, raw);
  const again = await addOwnerTask({ project: "harbor", title: raw, source: "next", agent: "ux" });
  deepStrictEqual([again.created, again.task.id], [false, "OWN-1"], "the same note again is the same task");
  strictEqual(await tidyTitles(), 0, "once is enough");
});

test("notes that share a clean title stay two tasks; a question asked again is not closed and reopened; tidying twice changes nothing (D-070)", async () => {
  const now = new Date("2026-11-06T09:00:00Z");
  const a = await addOwnerTask({ project: "harbor", title: "Run `ssh tour restart` on the server", source: "next", agent: "ux" }, now);
  const b = await addOwnerTask({ project: "harbor", title: "Run `rm -rf /tmp/demo-cache` on the server", source: "next", agent: "ux" }, now);
  ok(b.created && b.task.id !== a.task.id, "two commands, two tasks, though both read «Run … on the server»");
  const c = await addOwnerTask({ project: "harbor", title: "Ship the beta tonight. Then publish the notes and tell the testers", source: "next", agent: "ux" }, now);
  const d = await addOwnerTask({ project: "harbor", title: "Ship the beta tonight. Then delete the old beta branch for good", source: "next", agent: "ux" }, now);
  ok(d.created && d.task.id !== c.task.id, "one first sentence, two notes, two tasks");
  match(`${d.task.title} ${d.task.detail}`, /delete the old beta branch/, "nothing of the second note is lost");

  const { harbor, hub } = await setup();
  let t = Date.now();
  await hub.tick(new Date(t));
  const long = "Should the tour start with the map or with the list? The map needs the regions, the list needs the copy, and both need a week of work";
  for (let i = 0; i < 2; i++) {
    await report(harbor, { ...base, agent: "ux", status: "needs_input", question: long, option: ["Map", "List"] } as never);
    await hub.tick(new Date((t += 60_000)));
  }
  const questions = (await listOwnerTasks()).filter((x) => x.questionOf === "ux");
  deepStrictEqual(questions.map((x) => [x.status, x.closedAt ?? null]), [["open", null]], "the same question is one open task, never closed in between");

  const { tidyTitles } = await import("../src/hub/owner-tasks.ts");
  await tidyTitles();
  strictEqual(await tidyTitles(), 0, "a second run changes nothing");
});

test("a blocked agent's flag goes by itself when it is no longer blocked; a flag set by hand stays (D-070)", async () => {
  const { harbor, hub } = await setup();
  let t = Date.now();
  await hub.tick(new Date(t));
  await report(harbor, { ...base, agent: "ux", status: "blocked", blocked: ["No keys"], next: ["Owner: add the production keys"] } as never);
  await hub.tick(new Date((t += 60_000)));
  const { setBlocking } = await import("../src/hub/owner-tasks.ts");
  const keys = (await listOwnerTasks({ status: "open" })).find((x) => x.title.startsWith("Add the production keys"))!;
  ok(keys.blocking);
  const manual = await addOwnerTask({ project: "harbor", title: "Sign the hosting contract", source: "owner" });
  await setBlocking(manual.task.id, true);
  await report(harbor, { ...base, agent: "ux", status: "progress", doing: ["Working on the map"] } as never);
  await hub.tick(new Date((t += 60_000)));
  const after = await listOwnerTasks({ status: "open" });
  ok(!after.find((x) => x.id === keys.id)!.blocking, "unblocked: the team no longer waits for it");
  ok(after.find((x) => x.id === manual.task.id)!.blocking, "set by hand: it stays");

  // A blocked agent naming the hand-flagged task does not take it over: unblocked, the flag still stays.
  await report(harbor, { ...base, agent: "ux", status: "blocked", blocked: ["Waiting"], next: ["Owner: sign the hosting contract"] } as never);
  await hub.tick(new Date((t += 60_000)));
  await report(harbor, { ...base, agent: "ux", status: "progress", doing: ["Back to the map"] } as never);
  await hub.tick(new Date((t += 60_000)));
  ok((await listOwnerTasks({ status: "open" })).find((x) => x.id === manual.task.id)!.blocking, "still the owner's flag");

  // A question longer than a title, asked again, stays one open task.
  const long = `Should the tour start with the map, or with the list of places? ${"The map needs the regions and the list needs the copy. ".repeat(3)}`;
  for (let i = 0; i < 2; i++) {
    await report(harbor, { ...base, agent: "ux", status: "needs_input", question: long, option: ["Map", "List"] } as never);
    await hub.tick(new Date((t += 60_000)));
  }
  deepStrictEqual((await listOwnerTasks()).filter((x) => x.questionOf === "ux").map((x) => [x.status, x.closedAt ?? null]), [["open", null]]);
});
