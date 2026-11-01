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
  deepStrictEqual(open.map((x) => x.title).sort(), ["Answer Harbor UX: Week or month view first?", "add the DNS record", "try the tour on a phone"]);
  ok(open.every((x) => x.project === "harbor"), "nothing from the private project");
  ok(open.find((x) => x.title.startsWith("Answer"))!.urgent, "a question is urgent");

  await report(harbor, { ...base, agent: "ux", status: "progress", doing: ["Building the week view"] } as never);
  await hub.tick(new Date((t += 60_000)));
  deepStrictEqual((await listOwnerTasks({ status: "open" })).map((x) => x.title).sort(), ["add the DNS record", "try the tour on a phone"], "the question was answered");
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
  match(replies.at(-1)!.text, /📌 Your tasks \(2\):\nHarbor\n• OWN-1 renew the domain/);
  deepStrictEqual(replies.at(-1)!.options!.choices!.map((c) => c.reply), ["/done OWN-1", "/done OWN-2"]);
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
