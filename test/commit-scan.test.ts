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

/** A commit with an author date in the past, as a realigned repository or a branch from elsewhere brings. */
async function oldCommit(root: string, file: string, subject: string, daysAgo: number): Promise<void> {
  await writeFile(join(root, file), `export const x = "${subject}";\n`, "utf8");
  await exec("git", ["add", "-A"], { cwd: root });
  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  await exec("git", ["commit", "-q", "-m", subject], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date } });
}

test("history is never «unreported»: a realigned branch, a branch checked out, a worktree added bring old commits silently; new work still counts", async () => {
  const p = await project();
  const state = emptyState();
  await pass(p, state, new Date());

  // Realigned: commits authored days ago arrive on the same branch.
  for (let i = 0; i < 5; i++) await oldCommit(p.root, `old${i}.ts`, `chore: old ${i}`, 10 + i);
  deepStrictEqual(await pass(p, state, new Date()), [], "authored before the hub looked: history");

  // A branch checked out, with its own old history: only new work is told.
  await exec("git", ["checkout", "-q", "-b", "feature/import"], { cwd: p.root });
  for (let i = 0; i < 3; i++) await oldCommit(p.root, `imp${i}.ts`, `chore: imported ${i}`, 20 + i);
  deepStrictEqual(await pass(p, state, new Date()), [], "a branch seen for the first time is its history");
  await commit(p.root, "new.ts", "export const n = 1;\n", "feat: new work");
  const tb = Date.now();
  const later = await pass(p, state, minutes(tb, 40));
  deepStrictEqual(later.flatMap((e) => (e.kind === "unreported" ? e.commits.map((c) => c.subject) : [])), ["feat: new work"]);
  deepStrictEqual(await pass(p, state, minutes(tb, 120)), [], "told once");
});

test("new work is never lost: a commit in a branch new since the last pass, a branch left and taken back, an upgrade (second review)", async () => {
  const p = await project();
  // The project's own files committed first, so switching branches keeps them.
  await exec("git", ["add", "-A"], { cwd: p.root });
  await exec("git", ["commit", "-q", "--allow-empty", "-m", "chore: leftoff project"], { cwd: p.root });
  const state = emptyState();
  await pass(p, state, new Date());
  // A branch made and committed to between two passes: its commit is new work.
  await exec("git", ["checkout", "-q", "-b", "feature/fresh"], { cwd: p.root });
  await commit(p.root, "fresh.ts", "export const f = 1;\n", "feat: fresh");
  const t1 = Date.now();
  deepStrictEqual(await pass(p, state, new Date(t1)), [], "not yet due");
  // Left and taken back before it is due: still told.
  await exec("git", ["checkout", "-q", "-"], { cwd: p.root });
  await pass(p, state, minutes(t1, 5));
  await exec("git", ["checkout", "-q", "feature/fresh"], { cwd: p.root });
  const due = await pass(p, state, minutes(t1, 40));
  deepStrictEqual(due.flatMap((e) => (e.kind === "unreported" ? e.commits.map((c) => c.subject) : [])), ["feat: fresh"]);

  // An upgrade: a state from before the dates; a commit waiting is still told, old history is not.
  const q = await tempProject({ id: "atlas", name: "Atlas" });
  await registerProject("atlas", q.root);
  const old = emptyState();
  await pass(q, old, new Date());
  delete old.treesSeen;
  delete old.commitsPassAt;
  await oldCommit(q.root, "ancient.ts", "chore: ancient", 30);
  await commit(q.root, "waiting.ts", "export const w = 1;\n", "feat: waiting");
  const t2 = Date.now();
  const told = await pass(q, old, minutes(t2, 40));
  deepStrictEqual(told.flatMap((e) => (e.kind === "unreported" ? e.commits.map((c) => c.subject) : [])), ["feat: waiting"]);
});

test("a commit still waiting is told though a worktree or branch is added off it before it is due (second review, B2 and B3)", async () => {
  const p = await project();
  await exec("git", ["add", "-A"], { cwd: p.root });
  await exec("git", ["commit", "-q", "--allow-empty", "-m", "chore: leftoff project"], { cwd: p.root });
  const state = emptyState();
  await pass(p, state, new Date());
  await commit(p.root, "w.ts", "export const w = 1;\n", "feat: waiting on main");
  const t1 = Date.now();
  await pass(p, state, new Date(t1));
  // As Paseo does: a new worktree on a new branch, off the commit still waiting.
  const tree = join(p.root, "..", `wt-${Date.now()}`);
  await exec("git", ["worktree", "add", "-q", "-b", "feat/w", tree], { cwd: p.root });
  await exec("git", ["checkout", "-q", "-b", "feat/z"], { cwd: p.root });
  const due = await pass(p, state, minutes(t1, 40));
  ok(due.flatMap((e) => (e.kind === "unreported" ? e.commits.map((c) => c.subject) : [])).includes("feat: waiting on main"), "still told");
});
