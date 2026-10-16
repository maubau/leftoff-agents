import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { claudeCode } from "../src/hosts/claude-code.ts";
import { claudeWindows, recordClaudeLimit } from "../src/limits/claude.ts";
import { usageFrom } from "../src/limits/claude-usage.ts";
import { runStatusline } from "../src/limits/statusline.ts";
import { isolateHost } from "./helpers.ts";

let dir = "";
beforeEach(async () => {
  dir = await isolateHost("leftoff-claude-usage-");
});

const now = Date.parse("2026-10-16T12:00:00Z");
const input = (five: number, week: number) => ({
  model: { display_name: "Opus 5.5" },
  rate_limits: {
    five_hour: { used_percentage: five, resets_at: Math.round((now + 3 * 3_600_000) / 1000) },
    seven_day: { used_percentage: week, resets_at: Math.round((now + 3 * 86_400_000) / 1000) },
  },
});

test("the status line's input gives the subscription's two windows; without rate_limits there is nothing", () => {
  const usage = usageFrom(input(46, 15), now)!;
  deepStrictEqual([usage.fiveHour!.percent, usage.sevenDay!.percent, usage.fiveHour!.resetsAt], [46, 15, Math.round((now + 3 * 3_600_000) / 1000) * 1000]);
  strictEqual(usageFrom({ model: { display_name: "Opus 5.5" } }, now), null, "an API key, or an older Claude Code");
  strictEqual(usageFrom(null, now), null);
});

test("leftoff statusline keeps the usage per account and prints one short line; bad input prints the model at most", async () => {
  strictEqual(await runStatusline(JSON.stringify(input(46, 15)), {}, now), "Opus 5.5 · 5-hour 46% · weekly 15%");
  const work = join(dir, ".claude-work");
  await runStatusline(JSON.stringify(input(80, 30)), { CLAUDE_CONFIG_DIR: work }, now);
  const windows = await claudeWindows({ now, language: "en" });
  deepStrictEqual(
    windows.map((w) => [w.id, w.label, w.usedPercent]).sort(),
    [["claude:300", "5-hour", 46], ["claude:10080", "weekly", 15], ["claude:work:300", "5-hour", 80], ["claude:work:10080", "weekly", 30]].sort(),
    "two windows per account, and the usage files are not accounts of their own",
  );
  strictEqual(await runStatusline("not json", {}, now), "");
  strictEqual(await runStatusline(JSON.stringify({ model: { display_name: "Opus 5.5" } }), {}, now), "Opus 5.5");
});

test("a reading past its reset says nothing; a reached limit still shows next to the percentages", async () => {
  await runStatusline(JSON.stringify(input(100, 15)), {}, now);
  deepStrictEqual((await claudeWindows({ now: now + 4 * 3_600_000 })).map((w) => w.id), ["claude:10080"], "the 5-hour window has reset");
  await recordClaudeLimit({ error: "rate_limit", error_details: "5-hour limit reached ∙ resets 3pm (Europe/Rome)" }, now, "Europe/Rome");
  const ids = (await claudeWindows({ now })).map((w) => w.id).sort();
  deepStrictEqual(ids, ["claude", "claude:10080", "claude:300"]);
});

test("init adds Leftoff's status line only where none is set, and uninstall takes back only its own", async () => {
  const root = { hostId: "claude-code" as const, dir: join(dir, "claude"), origin: "test" };
  await mkdir(root.dir, { recursive: true });
  const installed = await claudeCode.install(root, "/usr/bin/leftoff");
  ok(installed.installed.includes("statusLine"));
  const settings = JSON.parse(await readFile(join(root.dir, "settings.json"), "utf8"));
  deepStrictEqual(settings.statusLine, { type: "command", command: "/usr/bin/leftoff statusline" });
  await claudeCode.uninstall(root);
  strictEqual(JSON.parse(await readFile(join(root.dir, "settings.json"), "utf8")).statusLine, undefined);

  await writeFile(join(root.dir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "~/bin/my-line.sh" } }), "utf8");
  const kept = await claudeCode.install(root, "/usr/bin/leftoff");
  match(kept.manual.join(" "), /A status line is already set/);
  strictEqual(JSON.parse(await readFile(join(root.dir, "settings.json"), "utf8")).statusLine.command, "~/bin/my-line.sh", "the owner's own stays");
  await claudeCode.uninstall(root);
  strictEqual(JSON.parse(await readFile(join(root.dir, "settings.json"), "utf8")).statusLine.command, "~/bin/my-line.sh");
});
