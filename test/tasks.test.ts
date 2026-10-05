import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import type { IncomingMessage } from "../src/channels/channel.ts";
import { readTasks } from "../src/core/backlog.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { readDecisions } from "../src/core/decisions.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { buildSnapshot } from "../src/core/snapshot.ts";
import { Hub } from "../src/hub/hub.ts";
import type { ModelProvider, RunResult } from "../src/pm/provider.ts";
import { createTasksAction, removeTasksAction } from "../src/pm/tasks.ts";
import { CREATE_TASKS_SPEC, REMOVE_TASKS_SPEC } from "../src/pm/tools.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const task = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  description: `Obiettivo di ${title}.\nContesto breve.`,
  acceptance_criteria: ["Funziona su mobile", "I test passano"],
  priority: "medium",
  labels: [],
  ...extra,
});

beforeEach(async () => {
  await isolateHost("leftoff-tasks-");
});

async function project(id = "clipforge", extra: Record<string, unknown> = {}): Promise<Project> {
  const p = await tempProject({ id, name: id[0]!.toUpperCase() + id.slice(1), ...extra });
  await registerProject(id, p.root);
  return p;
}

test("tasks are written in Backlog.md's layout and show up on the board, numbering on from the existing ones", async () => {
  const p = await project();
  await mkdir(join(p.root, "backlog", "tasks"), { recursive: true });
  await writeFile(join(p.root, "backlog", "tasks", "task-5 - Vecchia.md"), "---\nid: task-5\ntitle: Vecchia\nstatus: Done\n---\n", "utf8");

  const out = await createTasksAction([p], { project: "clipforge", summary: "Pagina tour", tasks: [task("Creare la pagina tour", { priority: "high", labels: ["frontend"] }), task("Collegare il form di prenotazione")] }, { language: "it" });
  ok(!out.isError, out.content);
  match(out.content, /TASK-6: Creare la pagina tour/);
  match(out.content, /TASK-7: Collegare il form/);

  const files = (await readdir(join(p.root, "backlog", "tasks"))).sort();
  deepStrictEqual(files, ["task-5 - Vecchia.md", "task-6 - Creare-la-pagina-tour.md", "task-7 - Collegare-il-form-di-prenotazione.md"]);
  const raw = await readFile(join(p.root, "backlog", "tasks", files[1]!), "utf8");
  match(raw, /^---\nid: TASK-6\ntitle: Creare la pagina tour\nstatus: To Do\nassignee: \[\]\ncreated_date: /);
  match(raw, /priority: high/);
  match(raw, /<!-- SECTION:DESCRIPTION:BEGIN -->\nObiettivo di Creare la pagina tour\./);
  match(raw, /<!-- AC:BEGIN -->\n- \[ \] #1 Funziona su mobile\n- \[ \] #2 I test passano\n<!-- AC:END -->/);

  const tasks = await readTasks(await loadProject(p.root));
  deepStrictEqual(tasks.filter((t) => t.status === "To Do").map((t) => t.title).sort(), ["Collegare il form di prenotazione", "Creare la pagina tour"]);
  const snapshot = await buildSnapshot(await loadProject(p.root));
  strictEqual(snapshot.tasks.todo.length, 2, "the project's board sees them");

  match(await readDecisions(p), /Aggiunte al backlog dal PM: TASK-6 Creare la pagina tour; TASK-7/);
});

test("the prefix of the project's own Backlog.md configuration is respected", async () => {
  const p = await project();
  await mkdir(join(p.root, "backlog"), { recursive: true });
  await writeFile(join(p.root, "backlog", "config.yml"), 'project_name: "Clipforge"\ntask_prefix: "trm"\n', "utf8");
  await createTasksAction([p], { project: "clipforge", summary: "x", tasks: [task("Una")] }, { language: "en" });
  deepStrictEqual(await readdir(join(p.root, "backlog", "tasks")), ["trm-1 - Una.md"]);
  match(await readFile(join(p.root, "backlog", "tasks", "trm-1 - Una.md"), "utf8"), /id: TRM-1/);
});

test("a bad batch creates nothing, and secrets never reach a task file", async () => {
  const p = await project();
  const bad = await createTasksAction([p], { project: "clipforge", summary: "x", tasks: [task("Buona"), task("Senza descrizione", { description: " " })] }, { language: "it" });
  strictEqual(bad.isError, true);
  deepStrictEqual(await readTasks(p), []);

  const many = await createTasksAction([p], { project: "clipforge", summary: "x", tasks: Array.from({ length: 13 }, (_, i) => task(`T${i}`)) }, { language: "it" });
  strictEqual(many.isError, true);
  strictEqual((await createTasksAction([p], { project: "nope", summary: "x", tasks: [task("A")] }, { language: "it" })).isError, true);

  await createTasksAction([p], { project: "clipforge", summary: "x", tasks: [task("Config", { description: "Usa la chiave sk-ant-api03-abcdefghijklmnop per il deploy" })] }, { language: "it" });
  const [file] = await readdir(join(p.root, "backlog", "tasks"));
  ok(!(await readFile(join(p.root, "backlog", "tasks", file!), "utf8")).includes("abcdefghijklmnop"));
});

test("undo takes back only what the PM created", async () => {
  const p = await project();
  await mkdir(join(p.root, "backlog", "tasks"), { recursive: true });
  await writeFile(join(p.root, "backlog", "tasks", "task-1 - Scritta a mano.md"), "---\nid: task-1\ntitle: Scritta a mano\nstatus: To Do\n---\n", "utf8");
  await createTasksAction([p], { project: "clipforge", summary: "x", tasks: [task("Del PM")] }, { language: "it" });

  const out = await removeTasksAction([p], { project: "clipforge", ids: ["TASK-2", "TASK-1"] });
  ok(!out.isError);
  match(out.content, /Removed TASK-2/);
  match(out.content, /Not removed.*TASK-1/);
  deepStrictEqual((await readTasks(p)).map((t) => t.title), ["Scritta a mano"]);
  strictEqual((await removeTasksAction([p], { project: "clipforge", ids: ["TASK-1"] })).isError, true);
});

test("the tool schemas are strict-mode ready, nested objects included", () => {
  const strict = (schema: any, where: string): void => {
    if (schema.type === "object") {
      strictEqual(schema.additionalProperties, false, where);
      deepStrictEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), where);
      for (const [k, v] of Object.entries(schema.properties)) strict(v, `${where}.${k}`);
    }
    if (schema.type === "array") strict(schema.items, `${where}[]`);
  };
  strict(CREATE_TASKS_SPEC.inputSchema, "create_tasks");
  strict(REMOVE_TASKS_SPEC.inputSchema, "remove_tasks");
});

test("in chat: a loose request becomes tasks on the project's board; a private project cannot receive any", async () => {
  const p = await project("clipforge");
  await project("segreto", { visibility: "private" });
  const seen: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake",
    async run(request): Promise<RunResult> {
      seen.push(request.tools.map((t) => t.name).join(","));
      const made = await request.execute("create_tasks", { project: "clipforge", summary: "Pagina tour con mappa", tasks: [task("Pagina tour"), task("Mappa del tour")] });
      const denied = await request.execute("create_tasks", { project: "segreto", summary: "x", tasks: [task("Spia")] });
      strictEqual(denied.isError, true, "a private project does not exist in chat");
      return { text: made.isError ? made.content : "Ho aggiunto 2 task: Pagina tour, Mappa del tour.", model: "fake", usage, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const hub = new Hub({ config: ConfigSchema.parse({ timezone: "Europe/Rome", language: "it", limits: { enabled: false } }), channel: new ConsoleChannel(), provider, log: () => undefined });
  const replies: string[] = [];
  const message: IncomingMessage = { text: "aggiungi a clipforge una pagina tour con mappa", projectId: "clipforge", threadKey: "t", reply: async (r) => void replies.push(r), typing: async () => undefined };
  await hub.handle(message);

  match(seen[0]!, /create_tasks/);
  match(seen[0]!, /remove_tasks/);
  match(replies[0]!, /Ho aggiunto 2 task/);
  deepStrictEqual((await readTasks(await loadProject(p.root))).map((t) => t.title).sort(), ["Mappa del tour", "Pagina tour"]);
});
