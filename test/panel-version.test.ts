import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DRAFT_TTL, readDrafts, versionSeen, writeDrafts } from "../src/web/public/panelversion.js";

test("the first version seen stays; another one later means a newer panel; an empty one says nothing (#134)", () => {
  deepStrictEqual(versionSeen(null, "a1b2c3"), { first: "a1b2c3", changed: false });
  deepStrictEqual(versionSeen("a1b2c3", "a1b2c3"), { first: "a1b2c3", changed: false });
  deepStrictEqual(versionSeen("a1b2c3", "d4e5f6"), { first: "a1b2c3", changed: true });
  deepStrictEqual(versionSeen("a1b2c3", ""), { first: "a1b2c3", changed: false }, "an older hub sends none");
  deepStrictEqual(versionSeen(null, null), { first: null, changed: false });
});

test("what is typed and not sent survives the reload, on the same page, for a few minutes", () => {
  const now = 1_000_000;
  const raw = writeDrafts({ hash: "#/tasks/OWN-7", pm: "where are we?", task: { id: "OWN-7", text: "the log says…" } }, now)!;
  deepStrictEqual(readDrafts(raw, "#/tasks/OWN-7", now + 1000), { pm: "where are we?", task: { id: "OWN-7", text: "the log says…" } });
  strictEqual(readDrafts(raw, "#/", now + 1000), null, "another page: not put back there");
  strictEqual(readDrafts(raw, "#/tasks/OWN-7", now + DRAFT_TTL + 1), null, "too old");
  strictEqual(writeDrafts({ hash: "#/", pm: "  ", task: { id: "OWN-1", text: "" } }), null, "nothing typed: nothing kept");
  deepStrictEqual(readDrafts(writeDrafts({ hash: "#/", pm: "hi" }, now)!, "#/", now), { pm: "hi", task: null });
  for (const bad of [null, "", "{", "[]", JSON.stringify({ at: "x" }), JSON.stringify({ at: now, hash: "#/" })]) strictEqual(readDrafts(bad, "#/", now), null, String(bad));
});

test("the page listens for the version, offers the reload at the top, and keeps the boxes' text", async () => {
  const app = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(app.includes('noteVersion(res.headers.get("x-leftoff-panel"));'), "on every API answer");
  ok(app.includes('es.addEventListener("version"'), "on every SSE connection");
  ok(app.includes("    newerBanner(),") && app.includes("onclick: reloadPanel"), "a band at the top with the reload");
  ok(app.includes("const kept = writeDrafts(unsentDrafts());") && app.includes("location.reload();"), "saved before reloading");
  ok(app.includes("if (restored.task?.id === x.id)") && app.includes("if (restored.pm)"), "put back after");
  const i18n = await readFile(new URL("../src/web/public/i18n.js", import.meta.url), "utf8");
  strictEqual(i18n.match(/newVersion: "/g)?.length, 6);
});
