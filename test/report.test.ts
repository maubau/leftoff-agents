import { ok, strictEqual, deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { report } from "../src/commands/report.ts";
import { loadProject } from "../src/core/project.ts";
import { latestPerAgent, readReports } from "../src/core/report.ts";
import { cleanup, commit, tempProject } from "./helpers.ts";

const base = {
  status: "progress",
  done: [] as string[],
  doing: [] as string[],
  blocked: [] as string[],
  next: [] as string[],
  option: [] as string[],
};

test("a report captures the commits made since the previous one", async () => {
  const project = await tempProject();
  try {
    await commit(project.root, "a.txt", "a", "first change");
    // With no previous report, everything recent is attributed to this one.
    const first = await report(project, { ...base, agent: "claude", status: "progress", done: ["step one"] });
    ok(first.data.commits.length >= 1);

    await commit(project.root, "b.txt", "b", "second change");
    const second = await report(await loadProject(project.root), {
      ...base,
      agent: "claude",
      status: "done",
      done: ["step two"],
    });
    // Only the new commit belongs to the second report.
    strictEqual(second.data.commits.length, 1);
    ok(second.data.commits[0] !== first.data.commits[0]);
  } finally {
    await cleanup(project.root);
  }
});

test("reporting registers the agent in project.yaml", async () => {
  const project = await tempProject();
  try {
    await report(project, { ...base, agent: "codex", host: "codex", status: "idle" });
    const reloaded = await loadProject(project.root);
    deepStrictEqual(
      reloaded.config.agents.map((a) => [a.id, a.host]),
      [["codex", "codex"]],
    );
  } finally {
    await cleanup(project.root);
  }
});

test("a question survives the round trip", async () => {
  const project = await tempProject();
  try {
    const { file } = await report(project, {
      ...base,
      agent: "claude",
      status: "needs_input",
      question: "Leaflet or Google Maps?",
      option: ["Leaflet", "Google Maps"],
      recommend: "Leaflet",
    });
    ok((await readFile(file, "utf8")).includes("Leaflet"));
    const [stored] = await readReports(await loadProject(project.root));
    strictEqual(stored?.question?.recommend, "Leaflet");
    deepStrictEqual(stored?.question?.options, ["Leaflet", "Google Maps"]);
  } finally {
    await cleanup(project.root);
  }
});

test("two agents reporting in the same minute do not overwrite each other", async () => {
  const project = await tempProject();
  try {
    const at = new Date().toISOString();
    await report(project, { ...base, agent: "claude", status: "done", at });
    await report(await loadProject(project.root), { ...base, agent: "claude", status: "progress", at });
    const reports = await readReports(await loadProject(project.root));
    strictEqual(reports.length, 2);
    strictEqual(new Set(reports.map((r) => r.file)).size, 2);
  } finally {
    await cleanup(project.root);
  }
});

test("latestPerAgent returns the newest report of each agent", async () => {
  const project = await tempProject();
  try {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    await report(project, { ...base, agent: "claude", status: "progress", at: old });
    await report(await loadProject(project.root), { ...base, agent: "claude", status: "done" });
    await report(await loadProject(project.root), { ...base, agent: "codex", status: "blocked" });
    const latest = await latestPerAgent(await loadProject(project.root));
    strictEqual(latest.get("claude")?.status, "done");
    strictEqual(latest.get("codex")?.status, "blocked");
  } finally {
    await cleanup(project.root);
  }
});
