import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { MirrorChannel } from "../src/channels/mirror.ts";
import { keyboard } from "../src/channels/telegram.ts";
import type { Report } from "../src/core/report.ts";
import { optionChoices } from "../src/hub/hub.ts";
import { Feed } from "../src/web/feed.ts";
import { isolateHost } from "./helpers.ts";

let dir = "";
beforeEach(async () => {
  dir = await isolateHost("leftoff-buttons-");
});

const asking = (options: string[], recommend?: string) => ({ question: { text: "Which way?", options, ...(recommend ? { recommend } : {}) } }) as unknown as Report;

test("an agent's question comes with one button per option; a tap says the option and whose question it answers", () => {
  const made = optionChoices(asking(["Resume the update now", "Wait for the plan"], "Resume the update now"), "Orla")!;
  deepStrictEqual(made.choices, [
    { label: "★ Resume the update now", reply: "Orla: Resume the update now" },
    { label: "Wait for the plan", reply: "Orla: Wait for the plan" },
  ]);
  strictEqual(optionChoices(asking([]), "Orla"), undefined, "no options, no buttons");
  strictEqual(optionChoices({ question: null } as unknown as Report, "Orla"), undefined);
  const long = optionChoices(asking(["x".repeat(80)]), "Orla")!.choices![0]!;
  strictEqual(long.label.length, 60, "the label is shortened");
  strictEqual(long.reply, `Orla: ${"x".repeat(80)}`, "the reply never is");
});

test("Telegram: a reply that fits goes in the button, a longer one is kept and found again; options get a row each", () => {
  const kept = new Map<string, string>();
  const keep = (reply: string) => {
    const key = `k${kept.size}`;
    kept.set(key, reply);
    return key;
  };
  const yesNo = keyboard([{ label: "Yes", reply: "yes" }, { label: "No", reply: "no" }], keep).inline_keyboard;
  deepStrictEqual(yesNo.map((row) => row.map((b) => ("callback_data" in b ? b.callback_data : ""))), [["say:yes", "say:no"]], "Yes/No on one row");

  const reply = "Leftoff Agents Main Dev: Resume the update of the Leftoff in use now";
  const rows = keyboard([{ label: "A", reply }, { label: "B", reply: "Orla: Wait" }, { label: "C", reply: "Orla: Never" }], keep).inline_keyboard.filter((r) => r.length);
  strictEqual(rows.length, 3, "a row each");
  const data = rows.map((r) => (r[0] && "callback_data" in r[0] ? r[0].callback_data : ""));
  ok(data.every((d) => Buffer.byteLength(d!) <= 64), "Telegram's 64 bytes");
  match(data[0]!, /^pick:k0$/);
  strictEqual(kept.get("k0"), reply, "the whole reply, kept");
  strictEqual(data[1], "say:Orla: Wait");
});

test("the panel's conversation keeps the buttons a message came with", async () => {
  const feed = new Feed(join(dir, "feed.jsonl"));
  const mirror = new MirrorChannel(new ConsoleChannel(), feed);
  await mirror.send("harbor", "Orla needs you", { choices: [{ label: "Resume", reply: "Orla: Resume" }] });
  await mirror.send("harbor", "Plain news");
  const [withButtons, plain] = feed.recent();
  deepStrictEqual(withButtons!.choices, [{ label: "Resume", reply: "Orla: Resume" }]);
  strictEqual(plain!.choices, undefined);
});
