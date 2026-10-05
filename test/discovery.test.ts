import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { discoverAgents } from "../src/agents/discovery.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { resolveAgent } from "../src/core/agents.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, resolveProject, type Project } from "../src/core/project.ts";
import { buildSnapshot } from "../src/core/snapshot.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { emptyState } from "../src/hub/state.ts";
import { Data } from "../src/web/data.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const exec = promisify(execFile);
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
let home = "";

beforeEach(async () => {
  const dir = await isolateHost("leftoff-disc-");
  home = process.env.PASEO_HOME!;
  await mkdir(home, { recursive: true });
  return dir;
});
afterEach(() => {
  delete process.env.PASEO_AGENT_ID;
});

interface Ws { id: string; cwd: string; title: string; repo: string; archived?: boolean }
interface Sess { id: string; ws: Ws; provider: string; status: string; updatedAt?: string; archived?: boolean }

/** Paseo's two registries, as Paseo writes them. */
async function paseo(workspaces: Ws[], sessions: Sess[]): Promise<void> {
  await mkdir(join(home, "projects"), { recursive: true });
  await writeFile(
    join(home, "projects", "workspaces.json"),
    JSON.stringify(workspaces.map((w) => ({ workspaceId: w.id, cwd: w.cwd, kind: "worktree", title: w.title, mainRepoRoot: w.repo, archivedAt: w.archived ? "2026-09-01T00:00:00Z" : null }))),
    "utf8",
  );
  for (const s of sessions) {
    const dir = join(home, "agents", s.ws.cwd.replace(/[^A-Za-z0-9.]+/g, "-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${s.id}.json`), JSON.stringify({ id: s.id, provider: s.provider, cwd: s.ws.cwd, workspaceId: s.ws.id, lastStatus: s.status, updatedAt: s.updatedAt ?? "2026-10-03T10:00:00Z", archivedAt: s.archived ? "2026-09-01T00:00:00Z" : null }), "utf8");
  }
}

async function worktree(project: Project, name: string): Promise<string> {
  const path = join(dirname(project.root), `wt-${name}`);
  await exec("git", ["worktree", "add", "-q", "-b", name, path], { cwd: project.root });
  return path;
}

test("Clipforge: the agents Paseo runs are listed before any of them has reported", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge", agents: [{ id: "claude", control: "paseo", host: "claude-code", paseoAgent: "fa311e5-idle" }] });
  const ux: Ws = { id: "w1", cwd: "/ws/meek-ostrich", title: "Clipforge-UX-UI-Claude", repo: p.root };
  const review: Ws = { id: "w2", cwd: "/ws/sulky-cobra", title: "Clipforge-Test-Review-Codex", repo: p.root };
  const dev: Ws = { id: "w3", cwd: "/ws/hapless-vulture", title: "Clipforge-Main-Dev-Codex-S", repo: p.root };
  const old: Ws = { id: "w4", cwd: "/ws/old", title: "Clipforge-Old", repo: p.root, archived: true };
  const other: Ws = { id: "w5", cwd: "/ws/other", title: "Other-Project", repo: "/somewhere/else" };
  await paseo([ux, review, dev, old, other], [
    { id: "fa311e5-idle", ws: ux, provider: "claude", status: "idle" },
    { id: "dc6754d-codex", ws: review, provider: "codex", status: "idle" },
    { id: "51ded08-idle", ws: dev, provider: "claude", status: "idle", updatedAt: "2026-10-03T08:00:00Z" },
    { id: "0d8b831-work", ws: dev, provider: "claude-work", status: "running", updatedAt: "2026-10-03T09:00:00Z" },
    { id: "closed-1", ws: review, provider: "claude", status: "closed" },
    { id: "gone-1", ws: old, provider: "claude", status: "idle" },
    { id: "elsewhere-1", ws: other, provider: "claude", status: "idle" },
    { id: "shell-1", ws: ux, provider: "terminal", status: "running" },
  ]);

  strictEqual(await discoverAgents(p), true);
  const agents = (await loadProject(p.root)).config.agents;
  deepStrictEqual(
    agents.map((a) => [a.id, a.host, a.paseoAgent ?? null, a.label ?? null]),
    [
      ["claude", "claude-code", null, null], // the old host-level agent lets go of the session the workspace agent took
      ["ux-ui-claude", "claude-code", "fa311e5-idle", "Clipforge-UX-UI-Claude"],
      ["test-review-codex", "codex", "dc6754d-codex", "Clipforge-Test-Review-Codex"],
      ["main-dev-codex-s", "claude-code", "0d8b831-work", "Clipforge-Main-Dev-Codex-S"], // the running session, not the idle one
    ],
  );
  strictEqual(agents.some((a) => ["old", "other-project"].includes(a.id)), false, "archived and foreign workspaces are not this project's");
  strictEqual(await discoverAgents(await loadProject(p.root)), false, "a second pass changes nothing");
});

test("an agent that already has its workspace keeps the link its reports set", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  const ws: Ws = { id: "w1", cwd: "/ws/ux", title: "Clipforge-UX-UI-Claude", repo: p.root };
  await paseo([ws], [{ id: "session-1", ws, provider: "claude", status: "idle" }]);
  await discoverAgents(p);
  const project = await loadProject(p.root);
  project.config.agents[0]!.paseoAgent = "session-2-from-a-report";
  await paseo([ws], [{ id: "session-1", ws, provider: "claude", status: "idle" }, { id: "session-2-from-a-report", ws, provider: "claude", status: "idle" }]);
  strictEqual(await discoverAgents(project), false);
  strictEqual(project.config.agents[0]!.paseoAgent, "session-2-from-a-report");
});

test("an agent is its session's workspace even when it works in a sibling worktree", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  const home1: Ws = { id: "w1", cwd: "/ws/hapless-vulture", title: "Clipforge-Main-Dev-Codex-S", repo: p.root };
  const foreign: Ws = { id: "w9", cwd: "/ws/elsewhere", title: "Other-Workspace", repo: "/another/repo" };
  await paseo([home1, foreign], [{ id: "0d8b831", ws: home1, provider: "claude-work", status: "running" }, { id: "wanderer", ws: foreign, provider: "claude", status: "running" }]);
  const sibling = await worktree(p, "main-dev"); // a git worktree Paseo has no workspace for

  process.env.PASEO_AGENT_ID = "0d8b831";
  const project = await resolveProject(sibling);
  deepStrictEqual(await resolveAgent(project, "claude-code"), { id: "main-dev-codex-s", label: "Clipforge-Main-Dev-Codex-S", workspace: "/ws/hapless-vulture" });

  process.env.PASEO_AGENT_ID = "wanderer";
  strictEqual((await resolveAgent(project, "claude-code")).id, "claude", "a session of another repo's workspace is not this project's agent");

  process.env.PASEO_AGENT_ID = "0d8b831";
  await report(project, { ...base, host: "claude-code", status: "progress", done: ["fix editor"] });
  const agents = (await loadProject(p.root)).config.agents;
  deepStrictEqual(agents.map((a) => [a.id, a.paseoAgent]), [["main-dev-codex-s", "0d8b831"]]);
});

test("the hub registers the Paseo agents on its own, on every pass", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge" });
  await registerProject("clipforge", p.root);
  const ws: Ws = { id: "w1", cwd: "/ws/ux", title: "Clipforge-UX-UI-Claude", repo: p.root };
  await paseo([ws], [{ id: "s1", ws, provider: "claude", status: "idle" }]);
  const hub = new Hub({ config: ConfigSchema.parse({ timezone: "Europe/Rome", limits: { enabled: false } }), channel: new ConsoleChannel(), log: () => undefined });
  await hub.tick();
  deepStrictEqual((await loadProject(p.root)).config.agents.map((a) => a.id), ["ux-ui-claude"]);

  // A workspace opened later is picked up on the next pass.
  const ws2: Ws = { id: "w2", cwd: "/ws/review", title: "Clipforge-Test-Review-Codex", repo: p.root };
  await paseo([ws, ws2], [{ id: "s1", ws, provider: "claude", status: "idle" }, { id: "s2", ws: ws2, provider: "codex", status: "idle" }]);
  await hub.tick();
  deepStrictEqual((await loadProject(p.root)).config.agents.map((a) => a.id), ["ux-ui-claude", "test-review-codex"]);
});

test("an agent that asked a question and is working again no longer shows as waiting for the owner", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge", agents: [{ id: "dev", control: "paseo", host: "claude-code", paseoAgent: "sess-dev" }, { id: "rev", control: "paseo", host: "codex", paseoAgent: "sess-rev" }] });
  await registerProject("clipforge", p.root);
  await report(p, { ...base, agent: "dev", status: "needs_input", question: "Note successive sull'editor?", doing: ["editor"] });
  await report(await loadProject(p.root), { ...base, agent: "rev", status: "blocked", blocked: ["serve l'accesso"] });

  const live = (devStatus: string) => async () => ({
    stdout: JSON.stringify([{ id: "sess-dev", shortId: "sess-de", status: devStatus }, { id: "sess-rev", shortId: "sess-re", status: "idle" }]),
  });
  const view = async (devStatus: string) => new Data({ config: ConfigSchema.parse({}), state: () => emptyState(), exec: live(devStatus) }).overview();

  const waiting = await view("idle");
  deepStrictEqual(waiting.asks.map((a) => a.agent).sort(), ["dev", "rev"]);
  strictEqual(waiting.projects[0]!.headline, "blocked");

  const working = await view("running");
  deepStrictEqual(working.asks.map((a) => a.agent), ["rev"], "only the agent that is still stopped is waiting");
  const clipforge = working.projects[0]!;
  strictEqual(clipforge.agents.find((a) => a.id === "dev")!.status, "progress");
  strictEqual(clipforge.agents.find((a) => a.id === "rev")!.status, "blocked");
  strictEqual(clipforge.headline, "blocked", "the other agent's blocker still counts");
  strictEqual(clipforge.counts.blocked, 1);

  const detail = await new Data({ config: ConfigSchema.parse({}), state: () => emptyState(), exec: live("running") }).detail("clipforge");
  ok(detail!.board.blocked.every((c) => c.agent === "rev"), "its question is not a card on the board");
});

test("old host-level agents are retired once workspace agents replace them, and stop haunting the project", async () => {
  const p = await tempProject({ id: "clipforge", name: "Clipforge", agents: [{ id: "claude", control: "paseo", host: "claude-code", paseoAgent: "sess-ux" }] });
  await registerProject("clipforge", p.root);
  // The old agent's last word was a question. The owner answered it in Paseo; nobody told Leftoff.
  await report(p, { ...base, agent: "claude", status: "needs_input", question: "Note successive?", done: ["vecchio lavoro"], doing: ["editor"] });
  const ws: Ws = { id: "w1", cwd: "/ws/ux", title: "Clipforge-UX-UI-Claude", repo: p.root };
  await paseo([ws], [{ id: "sess-ux", ws, provider: "claude", status: "idle" }]);

  strictEqual(await discoverAgents(await loadProject(p.root)), true);
  const project = await loadProject(p.root);
  const legacy = project.config.agents.find((a) => a.id === "claude")!;
  deepStrictEqual([legacy.retired, legacy.paseoAgent ?? null], [true, null]);

  const data = new Data({ config: ConfigSchema.parse({}), state: () => emptyState(), exec: async () => ({ stdout: "[]" }) });
  const overview = await data.overview();
  const clipforge = overview.projects[0]!;
  deepStrictEqual(clipforge.agents.map((a) => a.id), ["ux-ui-claude"], "the retired agent is not listed");
  deepStrictEqual(overview.asks, [], "its stale question is nobody's now");
  ok(clipforge.headline !== "needs_input", `the project is not waiting on a retired agent (${clipforge.headline})`);
  const detail = (await data.detail("clipforge"))!;
  deepStrictEqual(detail.board.doing, [], "what it left open is not on the board");
  ok(detail.board.done.some((c) => c.title === "vecchio lavoro"), "what it finished still is");
  strictEqual(detail.reports.length, 1, "its history stays");

  // If it reports again it is alive again.
  process.env.PASEO_AGENT_ID = "sess-old";
  await report(await loadProject(p.root), { ...base, agent: "claude", host: "claude-code", status: "progress", done: ["di nuovo"] });
  strictEqual((await loadProject(p.root)).config.agents.find((a) => a.id === "claude")!.retired, undefined);
});

test("an agent that reported under the workspace's own name is adopted by the workspace, not duplicated", async () => {
  const p = await tempProject({ id: "leftoff", name: "Leftoff Agents", agents: [{ id: "web-dev-claude", control: "inbox", host: "claude-code" }] });
  const ws: Ws = { id: "w1", cwd: "/ws/web", title: "Leftoff Agents Web Dev - Claude", repo: p.root };
  await paseo([ws], [{ id: "s-web", ws, provider: "claude", status: "running" }]);
  await discoverAgents(p);
  deepStrictEqual(
    (await loadProject(p.root)).config.agents.map((a) => [a.id, a.workspace ?? null, a.paseoAgent ?? null, a.label ?? null]),
    [["web-dev-claude", "/ws/web", "s-web", "Leftoff Agents Web Dev - Claude"]],
  );
});

test("the agent that took a retired one's session carries on its open work, until it reports for itself", async () => {
  const p = await tempProject({ id: "harbor", name: "Harbor Guesthouse", agents: [{ id: "claude", control: "paseo", host: "claude-code", paseoAgent: "sess-main" }] });
  await registerProject("harbor", p.root);
  process.env.PASEO_AGENT_ID = "sess-main";
  await report(p, { ...base, agent: "claude", host: "claude-code", status: "idle", done: ["Logo pubblicato"], blocked: ["Secret VPS_PATH incerto", "Logo Airbnb: serve l'SVG"], next: ["Search Console"], doing: ["Mappa My Maps"] });
  const ws: Ws = { id: "w1", cwd: "/ws/main", title: "Harbor Guesthouse Main Dev - Claude", repo: p.root };
  await paseo([ws], [{ id: "sess-main", ws, provider: "claude", status: "idle" }]);
  await discoverAgents(await loadProject(p.root));
  delete process.env.PASEO_AGENT_ID;

  const project = await loadProject(p.root);
  strictEqual(project.config.agents.find((a) => a.id === "claude")!.retired, true);
  const heir = (await buildSnapshot(project)).agents.find((a) => a.id === "main-dev-claude")!;
  strictEqual(heir.inherited, true);
  strictEqual(heir.last?.blocked.length, 2);

  const detail = (await new Data({ config: ConfigSchema.parse({}), state: () => emptyState(), exec: async () => ({ stdout: "[]" }) }).detail("harbor"))!;
  deepStrictEqual(detail.board.blocked.map((c) => [c.title, c.agent]), [["Secret VPS_PATH incerto", "main-dev-claude"], ["Logo Airbnb: serve l'SVG", "main-dev-claude"]], "the real blockers are still on the board, under the agent that owns them now");
  deepStrictEqual(detail.board.todo.map((c) => c.title), ["Search Console"]);
  deepStrictEqual(detail.board.doing.map((c) => c.title), ["Mappa My Maps"]);
  deepStrictEqual(detail.project.agents.map((a) => a.id), ["main-dev-claude"], "the retired name is still not listed");

  // Its own next report replaces what it inherited.
  process.env.PASEO_AGENT_ID = "sess-main";
  await report(await loadProject(p.root), { ...base, host: "claude-code", status: "progress", done: ["Secret risolto"], next: ["Tutto il resto"] });
  const after = (await buildSnapshot(await loadProject(p.root))).agents.find((a) => a.id === "main-dev-claude")!;
  deepStrictEqual([after.inherited ?? false, after.last?.done[0]], [false, "Secret risolto"]);
});
