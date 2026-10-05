import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { agentIdFromTitle, displayName, findAgentByName, paseoWorkspace, resolveAgent } from "../src/core/agents.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, resolveProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { latestReport } from "../src/core/report.ts";
import { reportMessage } from "../src/hub/messages.ts";
import { emptyState } from "../src/hub/state.ts";
import { Data } from "../src/web/data.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const exec = promisify(execFile);
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
let paseoHome = "";

type Entry = { cwd: string; title: string; archivedAt?: string | null };
async function paseoRegistry(entries: Entry[]): Promise<void> {
  await mkdir(join(paseoHome, "projects"), { recursive: true });
  await writeFile(join(paseoHome, "projects", "workspaces.json"), JSON.stringify(entries.map((e) => ({ kind: "worktree", archivedAt: null, ...e }))), "utf8");
}

beforeEach(async () => {
  const dir = await isolateHost("leftoff-ws-");
  paseoHome = join(dir, "paseo");
  process.env.PASEO_HOME = paseoHome;
});
afterEach(() => {
  delete process.env.PASEO_HOME;
  delete process.env.PASEO_AGENT_ID;
  delete process.env.LEFTOFF_AGENT;
});

/** A real linked worktree of the project's repo, as Paseo makes them. */
async function worktree(project: Project, name: string): Promise<string> {
  const path = join(dirname(project.root), `wt-${name}`);
  await exec("git", ["worktree", "add", "-q", "-b", name, path], { cwd: project.root });
  return path;
}

/** One report as an agent of `host`, in session `session`, working in `cwd`. */
async function reportFrom(root: string, cwd: string, host: "claude-code" | "codex", session: string, text: string) {
  process.env.PASEO_AGENT_ID = session;
  const project = await resolveProject(cwd);
  strictEqual(project.root, root);
  return report(project, { ...base, host, status: "progress", done: [text] });
}

test("Paseo's workspace registry is read by directory; archived, missing and broken ones are no workspace", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  await paseoRegistry([{ cwd: p.root, title: " Clipforge-UX-UI-Claude " }, { cwd: "/elsewhere", title: "Old", archivedAt: "2026-09-01T00:00:00Z" }]);
  deepStrictEqual(await paseoWorkspace(p.root), { cwd: p.root, title: "Clipforge-UX-UI-Claude" });
  strictEqual(await paseoWorkspace("/elsewhere"), undefined, "archived");
  strictEqual(await paseoWorkspace("/nowhere"), undefined, "unknown directory");
  await writeFile(join(paseoHome, "projects", "workspaces.json"), "{not json", "utf8");
  strictEqual(await paseoWorkspace(p.root), undefined, "unreadable registry");
  strictEqual(await paseoWorkspace(p.root, { PASEO_HOME: join(paseoHome, "absent") }), undefined, "no registry");
});

test("the agent's id is the workspace's name, without the project's own name in it", () => {
  const clipforge = { id: "clipforge", config: { name: "Clipforge" } } as Project;
  const leftoff = { id: "leftoff", config: { name: "Leftoff Agents" } } as Project;
  strictEqual(agentIdFromTitle("Clipforge-UX-UI-Claude", clipforge), "ux-ui-claude");
  strictEqual(agentIdFromTitle("Clipforge-Test-Review-Codex", clipforge), "test-review-codex");
  strictEqual(agentIdFromTitle("Leftoff Agents Web Dev - Claude", leftoff), "web-dev-claude");
  strictEqual(agentIdFromTitle("Clipforge", clipforge), "clipforge", "a name that is only the project's stays");
  strictEqual(agentIdFromTitle("Revisione è già finita!", clipforge), "revisione-e-gia-finita", "ids are plain ASCII");
  strictEqual(agentIdFromTitle("???", clipforge), "agent");
});

test("outside Paseo, or with LEFTOFF_AGENT, identity is what it always was", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  deepStrictEqual(await resolveAgent(p, "claude-code"), { id: "claude" });
  deepStrictEqual(await resolveAgent(p, "codex"), { id: "codex" });
  await paseoRegistry([{ cwd: p.root, title: "Clipforge-UX-UI-Claude" }]);
  strictEqual((await resolveAgent(p, "claude-code", { ...process.env, LEFTOFF_AGENT: "mine" })).id, "mine");
  strictEqual((await resolveAgent(p, "other")).id, "agent", "an unknown host has no workspace to speak for");
});

test("Clipforge: three workspaces are three agents, each keeping its own session, and the old «claude» lets go of the session it lost", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge", agents: [{ id: "claude", control: "paseo", host: "claude-code", paseoAgent: "session-A" }] });
  await registerProject("clipforge", p.root);
  const ux = await worktree(p, "meek-ostrich");
  const dev = await worktree(p, "main-dev");
  const review = await worktree(p, "sulky-cobra");
  await paseoRegistry([
    { cwd: ux, title: "Clipforge-UX-UI-Claude" },
    { cwd: dev, title: "Clipforge-Main-Dev-Codex-S" },
    { cwd: review, title: "Clipforge-Test-Review-Codex" },
  ]);

  await reportFrom(p.root, ux, "claude-code", "session-A", "ritocchi UI");
  await reportFrom(p.root, dev, "codex", "session-B", "fix editor");
  await reportFrom(p.root, review, "codex", "session-C", "revisione");

  const agents = (await loadProject(p.root)).config.agents;
  deepStrictEqual(
    agents.map((a) => [a.id, a.host, a.paseoAgent ?? null, a.label ?? null, a.control]),
    [
      ["claude", "claude-code", null, null, "inbox"],
      ["ux-ui-claude", "claude-code", "session-A", "Clipforge-UX-UI-Claude", "paseo"],
      ["main-dev-codex-s", "codex", "session-B", "Clipforge-Main-Dev-Codex-S", "paseo"],
      ["test-review-codex", "codex", "session-C", "Clipforge-Test-Review-Codex", "paseo"],
    ],
  );
  strictEqual((await latestReport(await loadProject(p.root), "main-dev-codex-s"))?.done[0], "fix editor");

  // The UX session is replaced by a new one: same workspace, same agent, new link — and only that link.
  await reportFrom(p.root, ux, "claude-code", "session-A2", "seconda sessione");
  const after = (await loadProject(p.root)).config.agents;
  strictEqual(after.find((a) => a.id === "ux-ui-claude")!.paseoAgent, "session-A2");
  strictEqual(after.find((a) => a.id === "main-dev-codex-s")!.paseoAgent, "session-B");
  strictEqual(after.length, 4, "no agent was added by the new session");

  // The owner renames the workspace: still the same agent, shown under its new name.
  await paseoRegistry([{ cwd: ux, title: "Clipforge-UX-UI-Claude v2" }, { cwd: dev, title: "Clipforge-Main-Dev-Codex-S" }, { cwd: review, title: "Clipforge-Test-Review-Codex" }]);
  await reportFrom(p.root, ux, "claude-code", "session-A2", "dopo rinomina");
  const renamed = (await loadProject(p.root)).config.agents.find((a) => a.workspace === ux)!;
  deepStrictEqual([renamed.id, renamed.label], ["ux-ui-claude", "Clipforge-UX-UI-Claude v2"]);
});

test("a name that two workspaces share does not merge them", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  const a = await worktree(p, "one");
  const b = await worktree(p, "two");
  await paseoRegistry([{ cwd: a, title: "Review" }, { cwd: b, title: "Review" }]);
  await reportFrom(p.root, a, "claude-code", "s1", "uno");
  await reportFrom(p.root, b, "claude-code", "s2", "due");
  deepStrictEqual((await loadProject(p.root)).config.agents.map((x) => [x.id, x.paseoAgent]), [["review", "s1"], ["review-claude", "s2"]]);
});

test("the owner sees their own names: in alerts, in the panel, and in what they can say to the PM", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  await registerProject("clipforge", p.root);
  const ux = await worktree(p, "meek-ostrich");
  await paseoRegistry([{ cwd: ux, title: "Clipforge-UX-UI-Claude" }]);
  await reportFrom(p.root, ux, "claude-code", "session-A", "ritocchi UI");

  const project = await loadProject(p.root);
  strictEqual(displayName(project, "ux-ui-claude"), "Clipforge-UX-UI-Claude");
  strictEqual(displayName(project, "claude"), "Claude", "an agent with no workspace name keeps the capitalized id");
  const latest = (await latestReport(project, "ux-ui-claude"))!;
  strictEqual(reportMessage({ ...latest, status: "done" }, "it", displayName(project, latest.agent)).split("\n")[0], "✅ Clipforge-UX-UI-Claude (meek-ostrich) ha finito: ritocchi UI.");

  for (const said of ["ux-ui-claude", "Clipforge-UX-UI-Claude", "ux ui", "UX-UI"]) strictEqual(findAgentByName(project, said)?.id, "ux-ui-claude", said);
  strictEqual(findAgentByName(project, "nobody"), undefined);

  const overview = await new Data({ config: ConfigSchema.parse({}), state: () => emptyState() }).overview();
  const agent = overview.projects.find((x) => x.id === "clipforge")!.agents.find((x) => x.id === "ux-ui-claude")!;
  strictEqual(agent.name, "Clipforge-UX-UI-Claude");
  match(agent.summary, /ritocchi UI/);
});
