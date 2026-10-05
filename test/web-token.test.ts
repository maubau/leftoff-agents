import { match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { ConfigSchema, loadSecrets } from "../src/core/config.ts";
import { globalPaths } from "../src/core/paths.ts";
import { ensureWebToken, rotateWebToken, storedWebToken, webLink } from "../src/core/web-token.ts";
import { Hub } from "../src/hub/hub.ts";
import { Data } from "../src/web/data.ts";
import { Feed } from "../src/web/feed.ts";
import { WebServer } from "../src/web/server.ts";
import { isolateHost } from "./helpers.ts";

let dir = "";
beforeEach(async () => {
  dir = await isolateHost("leftoff-web-token-");
});

const mode = async (file: string) => ((await stat(file)).mode & 0o777).toString(8);
const secrets = () => readFile(globalPaths.secrets(), "utf8");

test("a password is generated once, private to the owner, and an existing one is never touched", async () => {
  const env: NodeJS.ProcessEnv = {};
  const first = await ensureWebToken(env);
  ok(first.created);
  match(first.token, /^[0-9a-f]{64}$/, "256 bits of randomness");
  strictEqual(env.LEFTOFF_WEB_TOKEN, first.token);
  strictEqual(await mode(globalPaths.secrets()), "600");
  strictEqual(await mode(dirname(globalPaths.secrets())), "700");
  strictEqual(await secrets(), `LEFTOFF_WEB_TOKEN=${first.token}\n`);

  // Next start: secrets.env is loaded into the environment, so the same one is found.
  const again: NodeJS.ProcessEnv = {};
  await loadSecrets(again);
  const second = await ensureWebToken(again);
  strictEqual(second.created, false);
  strictEqual(second.token, first.token);

  // One the owner chose, in the environment, wins and nothing is written.
  const chosen = await ensureWebToken({ LEFTOFF_WEB_TOKEN: "mine" });
  deepStrictEqualToken(chosen, "mine", false);
  strictEqual(await secrets(), `LEFTOFF_WEB_TOKEN=${first.token}\n`, "the file was not rewritten");
});

function deepStrictEqualToken(got: { token: string; created: boolean }, token: string, created: boolean): void {
  strictEqual(got.token, token);
  strictEqual(got.created, created);
}

test("other secrets survive, with or without a trailing newline, and keep their permissions", async () => {
  await mkdir(dirname(globalPaths.secrets()), { recursive: true });
  await writeFile(globalPaths.secrets(), "ANTHROPIC_API_KEY=sk-ant-keep\nTELEGRAM_BOT_TOKEN=123:abc", { mode: 0o600 });
  const { token } = await ensureWebToken({});
  strictEqual(await secrets(), `ANTHROPIC_API_KEY=sk-ant-keep\nTELEGRAM_BOT_TOKEN=123:abc\nLEFTOFF_WEB_TOKEN=${token}\n`);
  strictEqual(await mode(globalPaths.secrets()), "600");
});

test("rotating replaces only the panel password", async () => {
  await mkdir(dirname(globalPaths.secrets()), { recursive: true });
  await writeFile(globalPaths.secrets(), "A=1\nLEFTOFF_WEB_TOKEN=old\nB=2\n", { mode: 0o600 });
  const token = await rotateWebToken({});
  notStrictEqual(token, "old");
  strictEqual(await secrets(), `A=1\nLEFTOFF_WEB_TOKEN=${token}\nB=2\n`);
  strictEqual(await storedWebToken(), token);
  strictEqual(await mode(globalPaths.secrets()), "600");
});

test("the link opens on the right address; 0.0.0.0 becomes localhost", () => {
  const web = ConfigSchema.parse({}).web;
  strictEqual(webLink(web, "t0k"), "http://127.0.0.1:4777/?token=t0k");
  strictEqual(webLink({ ...web, host: "0.0.0.0", port: 9000 }, "t0k"), "http://localhost:9000/?token=t0k");
});

test("with the generated password the panel refuses everyone without it, and the link logs in", async () => {
  const env: NodeJS.ProcessEnv = {};
  const { token } = await ensureWebToken(env);
  const config = ConfigSchema.parse({ timezone: "Europe/Rome", limits: { enabled: false } });
  const feed = new Feed(join(dir, "feed.jsonl"));
  await feed.load();
  const mirror = new MirrorChannel(new ConsoleChannel(), feed);
  const hub = new Hub({ config, channel: mirror, log: () => undefined });
  await hub.start();
  const web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0, allowedHosts: [] }, data: new Data({ config, state: () => hub.state }), feed, mirror, token, log: () => undefined });
  await web.start();
  afterEach(async () => undefined);
  try {
    const url = `http://127.0.0.1:${web.port}`;
    // A local process with no password — an agent, say — gets nothing, reads or writes.
    strictEqual((await fetch(`${url}/api/overview`)).status, 401);
    strictEqual((await fetch(`${url}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "sì" }) })).status, 401);
    strictEqual((await fetch(`${url}/api/overview`, { headers: { authorization: "Bearer not-it" } })).status, 401);
    // The owner opens the link once and gets a cookie.
    const login = await fetch(webLink({ ...config.web, port: web.port }, token), { redirect: "manual" });
    strictEqual(login.status, 302);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    strictEqual((await fetch(`${url}/api/overview`, { headers: { cookie } })).status, 200);
  } finally {
    await web.stop();
    await hub.stop();
  }
});
