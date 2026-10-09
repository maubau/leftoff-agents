import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { forgetPaseoModels } from "../src/agents/models.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { sessionBriefing } from "../src/core/protocol.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { Data } from "../src/web/data.ts";
import { Feed } from "../src/web/feed.ts";
import { WebServer } from "../src/web/server.ts";
import { Settings } from "../src/web/settings.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const MAIN = "7a2e4c1d-0000-4000-8000-0000000main1";
const NEW = "9c3f5e2a-0000-4000-8000-00000000new1";
let dir = "";
const servers: WebServer[] = [];

beforeEach(async () => {
  dir = await isolateHost("leftoff-create-");
  forgetPaseoModels();
});
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

/** A pretend `paseo` that can make workspaces and start agents, and records every command it was given. */
function fakePaseo(options: { runFails?: boolean; renameFails?: boolean } = {}) {
  const calls: string[][] = [];
  const started = new Map<string, { provider: string; thinking: string }>([[MAIN, { provider: "claude-work/claude-opus-5-5", thinking: "high" }]]);
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    const [a, b, c] = args;
    if (a === "ls") return { stdout: JSON.stringify([...started].map(([id, r]) => ({ id, provider: r.provider, thinking: r.thinking, status: "idle" }))) };
    if (a === "provider" && b === "ls") {
      return {
        stdout: JSON.stringify([
          { provider: "claude-work", label: "Claude (Work)", status: "available", enabled: "Enabled" },
          { provider: "codex", label: "Codex", status: "available", enabled: "Enabled" },
          { provider: "claude", label: "Claude", status: "unavailable", enabled: "Enabled" },
          { provider: "opencode", label: "OpenCode", status: "available", enabled: "Enabled" },
          { provider: "codex-old", label: "Codex (old)", status: "available", enabled: "Disabled" },
        ]),
      };
    }
    if (a === "provider" && b === "models") {
      if (c === "claude") {
        return { stdout: JSON.stringify([
          { model: "Opus 5.5", id: "claude-opus-5-5", thinkingOptionIds: ["low", "medium", "high"], defaultThinkingOptionId: "medium" },
          { model: "Sonnet 5.5", id: "claude-sonnet-5-5", thinkingOptionIds: ["low", "high"], defaultThinkingOptionId: "high" },
        ]) };
      }
      if (c === "codex") return { stdout: JSON.stringify([{ model: "GPT-5.4", id: "gpt-5.4", thinkingOptionIds: ["low", "medium"], defaultThinkingOptionId: "medium" }]) };
      throw new Error(`unknown provider ${c}`);
    }
    if (a === "agent" && b === "update" && c === "--help") return { stdout: "  --thinking <id>\n" };
    calls.push(args);
    if (a === "workspace" && b === "create") return { stdout: JSON.stringify({ workspaceId: "ws-new", project: "Harbor", name: "x", isolation: "worktree", cwd: join(dir, "worktrees", "harbor-docs") }) };
    if (a === "workspace" && b === "archive") return { stdout: "{}" };
    if (a === "workspace" && b === "rename") {
      if (options.renameFails) throw new Error("Command failed: paseo workspace rename\nworkspace not found");
      return { stdout: "{}" };
    }
    if (a === "run") {
      if (options.runFails) throw new Error("Command failed: paseo run\nprovider not ready");
      const provider = args[args.indexOf("--provider") + 1]!;
      const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "claude-opus-5-5";
      started.set(NEW, { provider: `${provider}/${model}`, thinking: args.includes("--thinking") ? args[args.indexOf("--thinking") + 1]! : "auto" });
      return { stdout: JSON.stringify({ agentId: NEW, status: "created", provider, cwd: join(dir, "worktrees", "harbor-docs"), title: "x" }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, calls };
}

async function rig(paseo = fakePaseo()) {
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false } });
  const feed = new Feed(join(dir, "feed.jsonl"));
  await feed.load();
  const mirror = new MirrorChannel(new ConsoleChannel(), feed);
  const hub = new Hub({ config, channel: mirror, exec: paseo.exec, log: () => undefined });
  const web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0 }, data: new Data({ config, state: () => hub.state, exec: paseo.exec }), feed, mirror, settings: new Settings({ config, exec: paseo.exec }), log: () => undefined });
  await web.start();
  servers.push(web);
  const url = `http://127.0.0.1:${web.port}`;
  return {
    paseo,
    get: (path: string) => fetch(url + path),
    post: (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

async function harbor(extra: Record<string, unknown> = {}): Promise<Project> {
  const p = await tempProject({
    id: "harbor",
    name: "Harbor",
    agents: [
      { id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: MAIN, label: "Harbor Main Dev", role: "architect and backend", workspace: join(dir, "worktrees", "harbor-main") },
      { id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX" },
    ],
    ...extra,
  });
  await registerProject("harbor", p.root);
  return p;
}

const docs = { name: "Harbor Docs", role: "documentation and guides", provider: "claude-work", model: "claude-sonnet-5-5", thinking: "low", task: "Write the setup guide." };

test("a new agent can run on the enabled Claude Code and Codex providers, each with its models", async () => {
  await harbor();
  const r = await rig();
  const { providers } = (await (await r.get("/api/settings/projects/harbor/new-agent")).json()) as any;
  deepStrictEqual(providers.map((p: any) => [p.id, p.host]), [["claude-work", "claude-code"], ["codex", "codex"]], "no unavailable, disabled or hook-less provider");
  deepStrictEqual(providers[0].models.map((m: any) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("creating an agent makes a named worktree workspace in Paseo, starts the agent in it, and registers it with its role", async () => {
  const p = await harbor();
  const r = await rig();
  const res = await r.post("/api/settings/projects/harbor/new-agent", docs);
  strictEqual(res.status, 201);
  const { agent } = (await res.json()) as any;
  deepStrictEqual([agent.id, agent.label, agent.reachable, agent.model, agent.thinking], ["docs", "Harbor Docs", true, "claude-sonnet-5-5", "low"]);

  const [create, run] = r.paseo.calls;
  deepStrictEqual(create, ["workspace", "create", "--isolation", "worktree", "--path", p.root, "--title", "Harbor Docs", "--json"]);
  deepStrictEqual(run!.slice(0, run!.indexOf("--")), ["run", "--background", "--json", "--workspace", "ws-new", "--title", "Harbor Docs", "--provider", "claude-work", "--model", "claude-sonnet-5-5", "--thinking", "low"]);
  const prompt = run!.at(-1)!;
  match(prompt, /^You are Harbor Docs, a new agent of the Harbor team/);
  match(prompt, /Your role: documentation and guides\./);
  match(prompt, /Your first task:\n\nWrite the setup guide\./);

  const saved = (await loadProject(p.root)).config.agents.find((a) => a.id === "docs")!;
  deepStrictEqual(
    { control: saved.control, host: saved.host, paseoAgent: saved.paseoAgent, workspace: saved.workspace, label: saved.label, role: saved.role },
    { control: "paseo", host: "claude-code", paseoAgent: NEW, workspace: join(dir, "worktrees", "harbor-docs"), label: "Harbor Docs", role: "documentation and guides" },
  );
  match(sessionBriefing(await loadProject(p.root), "main-dev"), /docs \(Harbor Docs\): documentation and guides/, "the team knows it before its first report");
});

test("an agent with no task and no model gets the provider's defaults and is told to get to know the project", async () => {
  await harbor();
  const r = await rig();
  strictEqual((await r.post("/api/settings/projects/harbor/new-agent", { name: "Harbor Review", provider: "codex" })).status, 201);
  const run = r.paseo.calls.find((c) => c[0] === "run")!;
  ok(!run.includes("--model") && !run.includes("--thinking"), "Paseo picks its own defaults");
  match(run.at(-1)!, /No task yet: get to know the project/);
  ok(!/Your role/.test(run.at(-1)!), "no role, no role line");
});

test("anything not offered is refused before Paseo is asked to make anything", async () => {
  await harbor();
  await harbor().catch(() => undefined);
  const r = await rig();
  const refused = async (body: Record<string, unknown>) => (await r.post("/api/settings/projects/harbor/new-agent", body)).status;
  strictEqual(await refused({ ...docs, name: "   " }), 400);
  strictEqual(await refused({ ...docs, name: "x".repeat(61) }), 400);
  strictEqual(await refused({ ...docs, provider: "opencode" }), 400, "no Leftoff hooks for it");
  strictEqual(await refused({ ...docs, model: "claude-made-up" }), 400);
  strictEqual(await refused({ ...docs, thinking: "medium" }), 400, "Sonnet offers low and high only");
  strictEqual(await refused({ ...docs, task: 42 }), 400);
  strictEqual(await refused({ ...docs, role: "y".repeat(201) }), 400);
  deepStrictEqual(r.paseo.calls, []);
});

test("if the agent cannot start, the workspace made for it is archived and the project is unchanged", async () => {
  const p = await harbor();
  const before = (await loadProject(p.root)).config.agents.length;
  const r = await rig(fakePaseo({ runFails: true }));
  const res = await r.post("/api/settings/projects/harbor/new-agent", docs);
  strictEqual(res.status, 502);
  match(((await res.json()) as any).error, /provider not ready/);
  deepStrictEqual(r.paseo.calls.map((c) => (c[0] === "run" ? "run" : c.slice(0, 2).join(" "))), ["workspace create", "run", "workspace archive"]);
  strictEqual(r.paseo.calls[2]![2], "ws-new");
  strictEqual((await loadProject(p.root)).config.agents.length, before);
});

test("a private project gets no new agents", async () => {
  await harbor({ visibility: "private" });
  const r = await rig();
  strictEqual((await r.get("/api/settings/projects/harbor/new-agent")).status, 404);
  strictEqual((await r.post("/api/settings/projects/harbor/new-agent", docs)).status, 404);
  deepStrictEqual(r.paseo.calls, []);
});

test("renaming a workspace agent renames its Paseo workspace too, so the name stays; the role is the team's description", async () => {
  const p = await harbor();
  await mkdir(join(process.env.PASEO_HOME!, "projects"), { recursive: true });
  await writeFile(join(process.env.PASEO_HOME!, "projects", "workspaces.json"), JSON.stringify([{ cwd: join(dir, "worktrees", "harbor-main"), title: "Harbor Main Dev", workspaceId: "ws-main", mainRepoRoot: p.root }]));
  const r = await rig();
  const res = await r.post("/api/settings/projects/harbor/agents/main-dev/profile", { name: "Harbor Lead", role: "architect; merges to main" });
  strictEqual(res.status, 200);
  deepStrictEqual(await res.json(), { id: "main-dev", label: "Harbor Lead", role: "architect; merges to main" });
  deepStrictEqual(r.paseo.calls, [["workspace", "rename", "ws-main", "Harbor Lead", "--json"]]);
  const saved = (await loadProject(p.root)).config.agents.find((a) => a.id === "main-dev")!;
  deepStrictEqual([saved.label, saved.role], ["Harbor Lead", "architect; merges to main"]);
  match(sessionBriefing(await loadProject(p.root), "ux"), /main-dev \(Harbor Lead\): architect; merges to main/);

  // An agent outside Paseo has no workspace to rename; an empty role removes it.
  strictEqual((await r.post("/api/settings/projects/harbor/agents/ux/profile", { name: "Harbor Design", role: "" })).status, 200);
  strictEqual(r.paseo.calls.length, 1);
  const ux = (await loadProject(p.root)).config.agents.find((a) => a.id === "ux")!;
  deepStrictEqual([ux.label, ux.role], ["Harbor Design", undefined]);
});

test("a rename Paseo refuses changes nothing, and a bad name or unknown agent is refused", async () => {
  const p = await harbor();
  await mkdir(join(process.env.PASEO_HOME!, "projects"), { recursive: true });
  await writeFile(join(process.env.PASEO_HOME!, "projects", "workspaces.json"), JSON.stringify([{ cwd: join(dir, "worktrees", "harbor-main"), title: "Harbor Main Dev", workspaceId: "ws-main", mainRepoRoot: p.root }]));
  const r = await rig(fakePaseo({ renameFails: true }));
  strictEqual((await r.post("/api/settings/projects/harbor/agents/main-dev/profile", { name: "Harbor Lead" })).status, 502);
  strictEqual((await loadProject(p.root)).config.agents.find((a) => a.id === "main-dev")!.label, "Harbor Main Dev");
  strictEqual((await r.post("/api/settings/projects/harbor/agents/main-dev/profile", { name: "" })).status, 400);
  strictEqual((await r.post("/api/settings/projects/harbor/agents/nobody/profile", { role: "x" })).status, 404);
});

test("Paseo's reason for a refusal is shown, never the command line it was given", async () => {
  const { paseoError } = await import("../src/agents/create.ts");
  const failed = Object.assign(new Error("Command failed: paseo run --title X -- Write the secret plan\n"), { stdout: "", stderr: "Error: provider claude-work is not ready\n" });
  strictEqual(paseoError(failed), "Error: provider claude-work is not ready");
  strictEqual(paseoError(Object.assign(new Error("Command failed: paseo run"), { stdout: JSON.stringify({ error: { code: "X", message: "Workspace not found" } }) })), "Workspace not found");
  strictEqual(paseoError(new Error("Command failed: paseo run --title X -- secret")), "no answer");
});
