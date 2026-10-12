import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, test } from "node:test";
import { report } from "../src/commands/report.ts";
import { clearCommitCache } from "../src/core/activity.ts";
import { loadProject, type Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { emptyState, type HubState } from "../src/hub/state.ts";
import { acknowledge, scan, type HubEvent } from "../src/hub/watcher.ts";
import { commit, isolateHost, tempProject } from "./helpers.ts";

const exec = promisify(execFile);
const base = { done: [], doing: [], blocked: [], next: [], option: [] };
let log = "";

/** A `git` first on the PATH that writes down each call, then runs the real one. */
beforeEach(async () => {
  const dir = await isolateHost("leftoff-commit-scan-");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "bin");
  log = join(dir, "git-calls.log");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "git"), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${real}" "$@"\n`, "utf8");
  await chmod(join(bin, "git"), 0o755);
  if (!process.env.PATH!.startsWith(`${bin}:`)) process.env.PATH = `${bin}:${process.env.PATH}`;
  clearCommitCache();
});

/** The git commands run since the last call, by name. */
async function calls(): Promise<Record<string, number>> {
  const lines = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  await rm(log, { force: true });
  return lines.reduce<Record<string, number>>((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {});
}

async function project(): Promise<Project> {
  const p = await tempProject({ id: "ledger", name: "Ledger" });
  await registerProject("ledger", p.root);
  return p;
}

const minutes = (t0: number, m: number) => new Date(t0 + m * 60_000);
async function pass(p: Project, state: HubState, now: Date): Promise<HubEvent[]> {
  const events = await scan([await loadProject(p.root)], state, { now, unreportedAfterMinutes: 30, awaiting: state.awaiting });
  for (const event of events) acknowledge(state, event);
  return events.filter((e) => e.kind === "unreported");
}

/** Two commits after the baseline, flagged by a first pass; returns what that pass ran. */
async function flaggedOnce(p: Project, state: HubState, t0: number): Promise<Record<string, number>> {
  await pass(p, state, minutes(t0, 0)); // first sight: history is the baseline
  await commit(p.root, "a.ts", "export const a = 1;\n", "feat: a");
  await commit(p.root, "b.ts", "export const b = 1;\n", "feat: b");
  await calls();
  const first = await pass(p, state, minutes(t0, 40));
  deepStrictEqual(first.flatMap((e) => (e.kind === "unreported" ? e.commits.map((c) => c.subject) : [])).sort(), ["feat: a", "feat: b"]);
  return calls();
}

test("a commit is classified once: the next pass runs no diff-tree, and it is flagged once", async () => {
  const p = await project();
  const state = emptyState();
  const t0 = Date.now();
  ok(((await flaggedOnce(p, state, t0))["diff-tree"] ?? 0) > 0, "the first pass classifies them");
  deepStrictEqual(await pass(p, state, minutes(t0, 80)), [], "an unreported commit is flagged once");
  const again = await calls();
  strictEqual(again["diff-tree"], undefined, "the second pass classifies nothing again");
  strictEqual(again.show, undefined);
});

test("the watcher never runs git status: what is uncommitted is not its business", async () => {
  const p = await project();
  const state = emptyState();
  const t0 = Date.now();
  await writeFile(join(p.root, "draft.ts"), "// not committed\n", "utf8");
  strictEqual((await flaggedOnce(p, state, t0)).status, undefined);
  await pass(p, state, minutes(t0, 80));
  strictEqual((await calls()).status, undefined);
});

test("a file touched after the commit's own report is still new work, whatever was remembered", async () => {
  const p = await project();
  const state = emptyState();
  const t0 = Date.now();
  await pass(p, state, minutes(t0, 0));
  // Work, then its report, then one commit with both: the report covers the work.
  await writeFile(join(p.root, "work.ts"), "export const w = 1;\n", "utf8");
  await utimes(join(p.root, "work.ts"), new Date(t0 - 60_000), new Date(t0 - 60_000));
  await report(await loadProject(p.root), { ...base, agent: "claude", status: "done", done: ["work.ts"] });
  await exec("git", ["add", "-A"], { cwd: p.root });
  await exec("git", ["commit", "-q", "-m", "feat: work, reported"], { cwd: p.root });

  deepStrictEqual(await pass(p, state, minutes(t0, 40)), [], "covered by its own report");
  // Touched after the report: no longer covered, though the commit's files and the report's time are remembered.
  await utimes(join(p.root, "work.ts"), new Date(), new Date(Date.now() + 60_000));
  const flagged = await pass(p, state, minutes(t0, 80));
  deepStrictEqual(flagged.flatMap((e) => (e.kind === "unreported" ? e.commits.map((c) => c.subject) : [])), ["feat: work, reported"]);
});
