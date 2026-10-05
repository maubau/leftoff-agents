import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { claudeWindows, currentClaudeAccount, readClaudeState, recordClaudeLimit, recordClaudeOk } from "../src/limits/claude.ts";
import { evaluateLimits } from "../src/limits/evaluate.ts";
import { windowName } from "../src/limits/format.ts";
import { isolateHost } from "./helpers.ts";

const TZ = "Europe/Rome";
const work = { slug: "work", label: "Work" };

beforeEach(async () => {
  await isolateHost("leftoff-accounts-");
});

test("the account comes from the config directory Claude Code was started with", async () => {
  deepStrictEqual(await currentClaudeAccount({}), { slug: "", label: "" });
  deepStrictEqual(await currentClaudeAccount({ CLAUDE_CONFIG_DIR: `${process.env.HOME}/.claude` }), { slug: "", label: "" });
  const other = await currentClaudeAccount({ CLAUDE_CONFIG_DIR: "/nowhere/.claude-ufficio" });
  strictEqual(other.slug, "ufficio");
  strictEqual(other.label, "ufficio");
});

test("a limit on one account never shows on, or clears from, the other", async () => {
  const now = Date.parse("2026-10-06T13:00:00+02:00");
  await recordClaudeLimit({ error: "rate_limit", error_details: "You've hit your session limit · resets 3pm (Europe/Rome)" }, now, TZ, undefined, work);
  strictEqual((await readClaudeState({ slug: "", label: "" })).limited, false, "the default account is untouched");
  strictEqual((await readClaudeState(work)).limited, true);

  // The default account finishing a turn proves nothing about the other one.
  await recordClaudeOk(now + 60_000);
  strictEqual((await readClaudeState(work)).limited, true);
  await recordClaudeOk(now + 120_000, work);
  strictEqual((await readClaudeState(work)).limited, false);
});

test("each account is its own window, named after it", async () => {
  const now = Date.parse("2026-10-06T13:00:00+02:00");
  await recordClaudeLimit({ error: "rate_limit", error_details: "You've hit your session limit · resets 3pm (Europe/Rome)" }, now, TZ);
  await recordClaudeLimit({ error: "rate_limit", error_details: "You've hit your session limit · resets 5pm (Europe/Rome)" }, now, TZ, undefined, work);
  const windows = await claudeWindows();
  deepStrictEqual(windows.map((w) => [w.id, w.account ?? null, w.reached]).sort(), [["claude", null, true], ["claude:work", "Work", true]]);
  strictEqual(windowName(windows.find((w) => w.id === "claude:work")!, "it"), "Claude Code (Work)");

  const memory = {};
  const alerts = evaluateLimits(windows, memory, { now, warnAtPercent: 80, language: "it", timezone: TZ });
  deepStrictEqual(alerts.map((a) => a.windowId).sort(), ["claude", "claude:work"]);
  match(alerts.find((a) => a.windowId === "claude:work")!.text, /Claude Code \(Work\) ha raggiunto il limite/);
});
