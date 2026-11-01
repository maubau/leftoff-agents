import { match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { IncomingMessage } from "../src/channels/channel.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { Hub } from "../src/hub/hub.ts";
import { Data } from "../src/web/data.ts";
import { Feed } from "../src/web/feed.ts";
import { LOGIN_TTL_MS, LoginLinks } from "../src/web/login-links.ts";
import { WebServer } from "../src/web/server.ts";
import { isolateHost } from "./helpers.ts";

/** One-time links into the panel (D-073). An invented password; nothing leaves the machine. */
const TOKEN = "panel-password-for-tests-only-000000";
let dir = "";
beforeEach(async () => {
  dir = await isolateHost("leftoff-login-");
});

test("a link opens once, within ten minutes, and never again", () => {
  const links = new LoginLinks();
  const now = Date.now();
  const code = links.issue(now);
  ok(code.length >= 30 && !code.includes(TOKEN));
  strictEqual(links.consume(code, now + 1000), true);
  strictEqual(links.consume(code, now + 2000), false, "used");
  const late = links.issue(now);
  strictEqual(links.consume(late, now + LOGIN_TTL_MS + 1), false, "expired");
  strictEqual(links.consume("made-up", now), false);
});

test("/panel answers a one-time link; opening it signs the browser in with the password's cookie, once", async () => {
  const logins = new LoginLinks();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const feed = new Feed(join(dir, "feed.jsonl"));
  await feed.load();
  const mirror = new MirrorChannel(new ConsoleChannel(), feed);
  let base = "";
  const hub = new Hub({ config, channel: mirror, log: () => undefined, panelLink: () => `${base}/?login=${logins.issue()}` });
  const web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port: 0 }, data: new Data({ config, state: () => hub.state }), feed, mirror, token: TOKEN, logins, log: () => undefined });
  await web.start();
  base = `http://127.0.0.1:${web.port}`;
  try {
    const replies: string[] = [];
    await hub.handle({ text: "/pannello", projectId: null, threadKey: "general", reply: async (r) => void replies.push(r), typing: async () => undefined } as IncomingMessage);
    const text = replies.at(-1)!;
    match(text, /works once, within 10 minutes/);
    ok(!text.includes(TOKEN), "the password never goes to chat");
    const link = /(http:\S+\?login=\S+)/.exec(text)![1]!;

    const first = await fetch(link, { redirect: "manual" });
    strictEqual(first.status, 302);
    const cookie = first.headers.get("set-cookie")!;
    match(cookie, /leftoff_web=.*HttpOnly; SameSite=Strict/);
    strictEqual((await fetch(`${base}/api/overview`, { headers: { cookie: cookie.split(";")[0]! } })).status, 200, "signed in");
    strictEqual((await fetch(link, { redirect: "manual" })).status, 401, "a second opening is refused");
    match(await (await fetch(`${base}/`)).text(), /Send \/panel \(\/pannello\) to the Leftoff bot/, "the page says how to get in");
  } finally {
    await web.stop();
  }
});
