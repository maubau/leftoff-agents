import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { enqueue, markDelivered, pending, readInbox, renderForAgent } from "../src/core/inbox.ts";
import { appendFile } from "node:fs/promises";
import { cleanup, tempProject } from "./helpers.ts";

test("messages are pending until delivered, then stay in the log", async () => {
  const project = await tempProject();
  try {
    const first = await enqueue(project, "claude", "use Leaflet", "user");
    await enqueue(project, "claude", "drop German for now", "pm");
    strictEqual((await pending(project, "claude")).length, 2);

    await markDelivered(project, "claude", [first.id]);
    deepStrictEqual(
      (await pending(project, "claude")).map((m) => m.text),
      ["drop German for now"],
    );
    strictEqual((await readInbox(project, "claude")).length, 2);
  } finally {
    await cleanup(project.root);
  }
});

test("delivering twice is a no-op", async () => {
  const project = await tempProject();
  try {
    const message = await enqueue(project, "claude", "ok");
    await markDelivered(project, "claude", [message.id]);
    const first = (await readInbox(project, "claude"))[0]?.deliveredAt;
    await markDelivered(project, "claude", [message.id]);
    strictEqual((await readInbox(project, "claude"))[0]?.deliveredAt, first);
  } finally {
    await cleanup(project.root);
  }
});

test("a corrupted line does not lose the rest of the inbox", async () => {
  const project = await tempProject();
  try {
    await enqueue(project, "claude", "first");
    await appendFile(project.paths.inboxFor("claude"), "{not json\n", "utf8");
    await enqueue(project, "claude", "second");
    deepStrictEqual(
      (await pending(project, "claude")).map((m) => m.text),
      ["first", "second"],
    );
  } finally {
    await cleanup(project.root);
  }
});

test("an empty inbox renders as nothing at all", () => {
  strictEqual(renderForAgent([]), "");
});

test("rendered messages carry their text and a timestamp", async () => {
  const project = await tempProject();
  try {
    await enqueue(project, "claude", "solo IT ed EN");
    const text = renderForAgent(await pending(project, "claude"));
    ok(text.includes("solo IT ed EN"));
    ok(text.includes("project manager"));
  } finally {
    await cleanup(project.root);
  }
});
