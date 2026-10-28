import { ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { claudeWithoutPercent, type MeterWindow } from "../src/web/public/limits.js";

const episode = (account?: string): MeterWindow => ({ id: account ? `claude:${account.toLowerCase()}` : "claude", product: "Claude Code", label: "", ...(account ? { account } : {}), usedPercent: null });
const share = (account: string | undefined, label: string, used: number): MeterWindow => ({ id: `claude:${label}`, product: "Claude Code", label, ...(account ? { account } : {}), usedPercent: used });

test("a Claude account with no share at all is told where its percentage comes from (D-060)", () => {
  const w = episode("W");
  ok(claudeWithoutPercent(w, [w]), "an account whose only row is «n/a»");
  const def = episode();
  ok(claudeWithoutPercent(def, [def, share("W", "5-hour", 40)]), "another account's share does not count");
});

test("not said where it would be wrong: an account with its windows, a measured row, Codex, the PM's spend", () => {
  const reached = { ...episode("W"), reached: true };
  strictEqual(claudeWithoutPercent(reached, [reached, share("W", "5-hour", 100), share("W", "weekly", 60)]), false, "the account has its share beside the «reached» row");
  strictEqual(claudeWithoutPercent(share("W", "5-hour", 12), []), false);
  strictEqual(claudeWithoutPercent({ id: "codex:300", product: "Codex", label: "", usedPercent: null }, []), false);
  strictEqual(claudeWithoutPercent({ product: "PM", label: "", usedPercent: null, valueText: "$0.21 this month" }, []), false);
  strictEqual(claudeWithoutPercent(null, []), false);
});

test("the header passes every window to the rule, and the text is in all six languages", async () => {
  const app = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(app.includes("o.limits.map((w) => meter(w, o.limits))") && app.includes("claudeWithoutPercent(w, all) ?"));
  const i18n = await readFile(new URL("../src/web/public/i18n.js", import.meta.url), "utf8");
  strictEqual(i18n.match(/percentFromTerminal: "/g)?.length, 6);
});
