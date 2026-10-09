import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parse as parseYaml } from "yaml";
import { forgetPaseoModels } from "../src/agents/models.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { ConfigSchema, loadConfig, type Config } from "../src/core/config.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { Data } from "../src/web/data.ts";
import { Feed } from "../src/web/feed.ts";
import { WebServer } from "../src/web/server.ts";
import { Settings } from "../src/web/settings.ts";
import { isolateHost, tempProject } from "./helpers.ts";

const MAIN = "7a2e4c1d-0000-4000-8000-0000000main1";
let dir = "";
const servers: WebServer[] = [];

beforeEach(async () => {
  dir = await isolateHost("leftoff-settings-");
  forgetPaseoModels();
});
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

/** A pretend `paseo`: one Claude agent on Opus at high thinking, a provider the owner named, and a log of updates. */
function fakePaseo(options: { modelFlag?: boolean; status?: string } = {}) {
  const updates: string[][] = [];
  const state = { provider: "claude-work/claude-opus-5-5", thinking: "high" };
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    const [a, b, c] = args;
    if (a === "ls") return { stdout: JSON.stringify([{ id: MAIN, shortId: MAIN.slice(0, 7), provider: state.provider, thinking: state.thinking, status: options.status ?? "idle" }]) };
    if (a === "provider" && b === "models") {
      if (c !== "claude") throw new Error(`unknown provider ${c}`); // only the program answers, not the owner's name for it
      return {
        stdout: JSON.stringify([
          { model: "Opus 5.5", id: "claude-opus-5-5", thinkingOptionIds: ["low", "medium", "high", "max"], defaultThinkingOptionId: "medium" },
          { model: "Sonnet 5.5", id: "claude-sonnet-5-5", thinkingOptionIds: ["low", "high"], defaultThinkingOptionId: "high" },
        ]),
      };
    }
    if (a === "agent" && b === "update" && c === "--help") return { stdout: `Options:\n  --name <name>\n  --thinking <id>\n${options.modelFlag ? "  --model <id>\n" : ""}` };
    if (a === "agent" && b === "update") {
      updates.push(args);
      const flag = args[3];
      if (flag === "--model") state.provider = `claude-work/${args[4]}`;
      if (flag === "--thinking") state.thinking = args[4]!;
      return { stdout: JSON.stringify({ agentId: MAIN, notice: null }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  return { exec, updates };
}

async function rig(options: { provider?: "anthropic" | "openai-compatible"; paseo?: ReturnType<typeof fakePaseo> } = {}) {
  const config: Config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, pm: { provider: options.provider ?? "anthropic", ...(options.provider === "openai-compatible" ? { model: "local-model", baseUrl: "http://127.0.0.1:1" } : {}) } });
  const paseo = options.paseo ?? fakePaseo();
  const feed = new Feed(join(dir, "feed.jsonl"));
  await feed.load();
  const mirror = new MirrorChannel(new ConsoleChannel(), feed);
  const hub = new Hub({ config, channel: mirror, exec: paseo.exec, log: () => undefined });
  const web = new WebServer({
    config: { enabled: true, host: "127.0.0.1", port: 0 },
    data: new Data({ config, state: () => hub.state, exec: paseo.exec }),
    feed,
    mirror,
    settings: new Settings({ config, exec: paseo.exec }),
    log: () => undefined,
  });
  await web.start();
  servers.push(web);
  const url = `http://127.0.0.1:${web.port}`;
  return {
    config,
    paseo,
    get: (path: string) => fetch(url + path),
    post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
  };
}

async function harbor(extra: Record<string, unknown> = {}) {
  const p = await tempProject({
    id: "harbor",
    name: "Harbor",
    agents: [
      { id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: MAIN, label: "Harbor Main Dev" },
      { id: "ux", control: "inbox", host: "claude-code" },
    ],
    ...extra,
  });
  await registerProject("harbor", p.root);
  return p;
}

test("the PM's model and effort are offered from priced Anthropic models, and a change is saved and used at once", async () => {
  const file = join(process.env.LEFTOFF_CONFIG_DIR!, "config.yaml");
  await mkdir(process.env.LEFTOFF_CONFIG_DIR!, { recursive: true });
  await writeFile(file, "language: en\ntelegram:\n  chatId: -100123\npm:\n  model: claude-sonnet-5-5\n", "utf8");
  const r = await rig();
  const before = (await (await r.get("/api/settings/pm")).json()) as any;
  strictEqual(before.model, "claude-sonnet-5-5");
  deepStrictEqual(before.efforts, ["low", "medium", "high", "xhigh", "max"]);
  ok(before.models.some((m: any) => m.id === "claude-opus-5-5"));

  const after = (await (await r.post("/api/settings/pm", { model: "claude-opus-5-5", effort: "high" })).json()) as any;
  deepStrictEqual([after.model, after.effort], ["claude-opus-5-5", "high"]);
  deepStrictEqual([r.config.pm.model, r.config.pm.effort], ["claude-opus-5-5", "high"], "the running hub's next answer uses it");
  const saved = parseYaml(await readFile(file, "utf8"));
  deepStrictEqual([saved.pm.model, saved.pm.effort, saved.telegram.chatId], ["claude-opus-5-5", "high", -100123], "the rest of the owner's file is kept");
  strictEqual((await loadConfig()).pm.model, "claude-opus-5-5");
});

test("the PM refuses a model it does not offer, an unknown effort, a page from elsewhere, and a model change on a non-Anthropic server", async () => {
  const r = await rig();
  strictEqual((await r.post("/api/settings/pm", { model: "claude-made-up" })).status, 400);
  strictEqual((await r.post("/api/settings/pm", { effort: "turbo" })).status, 400);
  strictEqual((await r.post("/api/settings/pm", { effort: "max" }, { origin: "http://evil.example" })).status, 403);
  strictEqual((await r.post("/api/settings/pm", ["claude-opus-5-5"])).status, 400);
  strictEqual(r.config.pm.model, "claude-sonnet-5-5", "nothing changed");

  const local = await rig({ provider: "openai-compatible" });
  strictEqual(((await (await local.get("/api/settings/pm")).json()) as any).models.length, 0);
  const refused = await local.post("/api/settings/pm", { model: "claude-opus-5-5" });
  strictEqual(refused.status, 409);
  match(((await refused.json()) as any).error, /config\.yaml/);
  strictEqual((await local.post("/api/settings/pm", { effort: "medium" })).status, 200, "effort still applies");
});

test("each Paseo agent shows its model, thinking level and what it can switch to; others say why they cannot", async () => {
  await harbor();
  const r = await rig();
  const { agents } = (await (await r.get("/api/settings/projects/harbor/agents")).json()) as any;
  const main = agents.find((a: any) => a.id === "main-dev");
  deepStrictEqual(
    { provider: main.provider, model: main.model, thinking: main.thinking, canSetModel: main.canSetModel, canSetThinking: main.canSetThinking },
    { provider: "claude-work", model: "claude-opus-5-5", thinking: "high", canSetModel: false, canSetThinking: true },
  );
  deepStrictEqual(main.models.map((m: any) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5"], "asked of the program when the owner's provider name does not answer");
  const ux = agents.find((a: any) => a.id === "ux");
  deepStrictEqual([ux.reachable, ux.reason], [false, "not run by Paseo"]);
});

test("a thinking level is set through Paseo's command line, only from the levels the model offers", async () => {
  await harbor();
  const r = await rig();
  const res = await r.post("/api/settings/projects/harbor/agents/main-dev", { thinking: "max" });
  strictEqual(res.status, 200);
  strictEqual(((await res.json()) as any).agent.thinking, "max");
  deepStrictEqual(r.paseo.updates, [["agent", "update", MAIN, "--thinking", "max", "--json"]]);

  strictEqual((await r.post("/api/settings/projects/harbor/agents/main-dev", { thinking: "--model=x" })).status, 400);
  strictEqual((await r.post("/api/settings/projects/harbor/agents/ux", { thinking: "low" })).status, 409, "not a Paseo agent");
  strictEqual((await r.post("/api/settings/projects/harbor/agents/nobody", { thinking: "low" })).status, 404);
  strictEqual(r.paseo.updates.length, 1, "nothing refused reached Paseo");
});

test("a model switch waits for a Paseo that can do it, then goes first and the thinking level is checked against the new model", async () => {
  await harbor();
  const old = await rig();
  const refused = await old.post("/api/settings/projects/harbor/agents/main-dev", { model: "claude-sonnet-5-5" });
  strictEqual(refused.status, 409);
  match(((await refused.json()) as any).error, /Paseo's app/);
  deepStrictEqual(old.paseo.updates, []);

  forgetPaseoModels();
  const r = await rig({ paseo: fakePaseo({ modelFlag: true }) });
  strictEqual((await r.post("/api/settings/projects/harbor/agents/main-dev", { model: "claude-sonnet-5-5", thinking: "medium" })).status, 400, "Sonnet offers low and high only");
  const res = await r.post("/api/settings/projects/harbor/agents/main-dev", { model: "claude-sonnet-5-5", thinking: "low" });
  strictEqual(res.status, 200);
  deepStrictEqual(r.paseo.updates, [
    ["agent", "update", MAIN, "--model", "claude-sonnet-5-5", "--json"],
    ["agent", "update", MAIN, "--thinking", "low", "--json"],
  ]);
  const agent = ((await res.json()) as any).agent;
  deepStrictEqual([agent.model, agent.thinking], ["claude-sonnet-5-5", "low"]);
});

test("a private project's agents cannot be seen or changed, and a closed session cannot be changed", async () => {
  await harbor({ visibility: "private" });
  const r = await rig();
  strictEqual((await r.get("/api/settings/projects/harbor/agents")).status, 404);
  strictEqual((await r.post("/api/settings/projects/harbor/agents/main-dev", { thinking: "low" })).status, 404);

  const p = await tempProject({ id: "atlas", name: "Atlas", agents: [{ id: "main-dev", control: "paseo", host: "claude-code", paseoAgent: MAIN }] });
  await registerProject("atlas", p.root);
  const closed = await rig({ paseo: fakePaseo({ status: "closed" }) });
  const { agents } = (await (await closed.get("/api/settings/projects/atlas/agents")).json()) as any;
  deepStrictEqual([agents[0].reachable, agents[0].reason], [false, "its Paseo session is closed"]);
  strictEqual((await closed.post("/api/settings/projects/atlas/agents/main-dev", { thinking: "low" })).status, 409);
  deepStrictEqual([...r.paseo.updates, ...closed.paseo.updates], []);
});
