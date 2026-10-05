import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { activitySince } from "../src/core/activity.ts";
import { claimedCommits, latestReport } from "../src/core/report.ts";
import { report } from "../src/commands/report.ts";
import { loadProject } from "../src/core/project.ts";
import { cleanup, commit, tempProject } from "./helpers.ts";

const base = { status: "progress", done: [], doing: [], blocked: [], next: [], option: [] } as const;

test("a turn that changed nothing produces no activity", async () => {
  const project = await tempProject();
  try {
    await report(project, { ...base, agent: "claude", status: "done" });
    const fresh = await loadProject(project.root);
    const last = await latestReport(fresh, "claude");
    const activity = await activitySince(fresh, last?.at, await claimedCommits(fresh));
    strictEqual(activity.changed, false);
  } finally {
    await cleanup(project.root);
  }
});

test("a commit after the last report counts as unreported work", async () => {
  const project = await tempProject();
  try {
    await report(project, { ...base, agent: "claude", status: "done" });
    await commit(project.root, "feature.ts", "export const x = 1;\n", "add feature");
    const fresh = await loadProject(project.root);
    const last = await latestReport(fresh, "claude");
    const activity = await activitySince(fresh, last?.at, await claimedCommits(fresh));
    ok(activity.changed);
    strictEqual(activity.commits.length, 1);
  } finally {
    await cleanup(project.root);
  }
});

test("an uncommitted edit counts too, but Leftoff's own files never do", async () => {
  const project = await tempProject();
  try {
    await report(project, { ...base, agent: "claude", status: "done" });
    const fresh = await loadProject(project.root);
    const last = await latestReport(fresh, "claude");

    // Only .leftoff/ changed — that is Leftoff's own bookkeeping, not the agent's work.
    strictEqual((await activitySince(fresh, last?.at, await claimedCommits(fresh))).changed, false);

    await writeFile(join(project.root, "src.ts"), "let y = 2;\n", "utf8");
    const activity = await activitySince(fresh, last?.at, await claimedCommits(fresh));
    ok(activity.changed);
    ok(activity.dirtyFiles.includes("src.ts"));
  } finally {
    await cleanup(project.root);
  }
});

test("a stale dirty file from before the report does not trigger a nudge", async () => {
  const project = await tempProject();
  try {
    const file = join(project.root, "wip.ts");
    await writeFile(file, "// left over\n", "utf8");
    // Backdate the edit so it clearly predates the report.
    const past = new Date(Date.now() - 3_600_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(file, past, past);

    await report(project, { ...base, agent: "claude", status: "done" });
    const fresh = await loadProject(project.root);
    const last = await latestReport(fresh, "claude");
    const activity = await activitySince(fresh, last?.at, await claimedCommits(fresh));
    strictEqual(activity.dirtyFiles.includes("wip.ts"), false);
    ok((await readFile(file, "utf8")).includes("left over"));
  } finally {
    await cleanup(project.root);
  }
});
