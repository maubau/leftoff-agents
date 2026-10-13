import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { choicesOf, liveChoices, optionReply, threadOf, type FeedEntryLike } from "../src/web/public/choices.js";

let n = 0;
const yesNo = [{ label: "✅ Yes, send", reply: "yes" }, { label: "✖ No", reply: "no" }];
const pm = (projectId: string | null, extra: Partial<FeedEntryLike> = {}): FeedEntryLike => ({ id: `e${++n}`, projectId, role: "pm", source: "telegram", kind: "push", ...extra });
const owner = (projectId: string | null): FeedEntryLike => ({ id: `e${++n}`, projectId, role: "owner", source: "web", kind: "ask" });

test("only the last message with buttons of each thread shows them, until the owner writes there", () => {
  const old = pm("orchard", { choices: yesNo });
  const last = pm("orchard", { choices: [{ label: "★ A", reply: "Wren: A" }] });
  const general = pm(null, { choices: yesNo });
  const plain = pm("orchard");
  deepStrictEqual([...liveChoices([old, general, last, plain])].sort(), [general.id, last.id].sort(), "one per thread, not the older one; a message without buttons does not hide them");
  deepStrictEqual([...liveChoices([old, general, last, owner("orchard")])], [general.id], "the owner wrote in that thread: answered");
  deepStrictEqual([...liveChoices([general, owner("orchard")])], [general.id], "writing in another thread changes nothing here");
  strictEqual(threadOf({ projectId: null }), "general");
});

test("a reply given in Telegram keeps its buttons there: its «yes» waits in Telegram's thread", () => {
  const fromTelegram = pm("orchard", { kind: "reply", source: "telegram", choices: yesNo });
  const fromPanel = pm("atlas", { kind: "reply", source: "web", choices: yesNo });
  const pushed = pm(null, { kind: "push", source: "telegram", choices: yesNo });
  deepStrictEqual([...liveChoices([fromTelegram, fromPanel, pushed])].sort(), [fromPanel.id, pushed.id].sort());
  deepStrictEqual([...liveChoices([null, undefined, pm(null, { choices: [] })])], [], "nothing odd breaks it");
});

test("buttons are only what can be said; an option's chip says «<agent>: <option>», as Telegram's", () => {
  deepStrictEqual(choicesOf({ choices: [{ label: "A", reply: "Wren: A" }, { label: "B", reply: " " }, { label: 3, reply: "x" } as never, null as never] }), [{ label: "A", reply: "Wren: A" }]);
  deepStrictEqual(choicesOf(null), []);
  strictEqual(optionReply("Wren", "Option A"), "Wren: Option A");
});

test("the page wires the buttons to these rules: sent in the message's thread, and the ask chips say it at once", async () => {
  const app = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(app.includes("liveChoices(S.feed)"), "the chat asks which messages keep their buttons");
  match(app, /onclick: \(\) => send\(c\.reply, e\.projectId\)/, "a tap says the reply in the message's own thread");
  match(app, /send\(optionReply\(a\.agentName/, "an option chip sends «<agent>: <option>» at once");
  ok(!app.includes("prefill("), "no longer just typed into the box");
});
