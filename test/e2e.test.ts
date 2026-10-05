import { ok, strictEqual, match } from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanup, commit, tempRepo } from "./helpers.ts";

const git = promisify(execFile);

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI as a subprocess, exactly as a host hook would. */
async function leftoff(
  cwd: string,
  args: string[],
  input = "",
  env: Record<string, string> = {},
): Promise<Run> {
  const configDir = env["LEFTOFF_CONFIG_DIR"] ?? (await mkdtemp(join(tmpdir(), "leftoff-cfg-")));
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env, LEFTOFF_CONFIG_DIR: configDir },
  });
  child.stdin.end(input);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += String(c)));
  child.stderr.on("data", (c) => (stderr += String(c)));
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 0)));
  return { code, stdout, stderr };
}

test("end to end: init, unreported work is caught, a report answers 'where did I leave off?'", async () => {
  const repo = await tempRepo("harbor");
  const configDir = await mkdtemp(join(tmpdir(), "leftoff-cfg-"));
  const env = { LEFTOFF_CONFIG_DIR: configDir };
  try {
    const init = await leftoff(repo, ["init", "--name", "Harbor", "--purpose", "Direct bookings", "--no-hooks"], "", env);
    match(init.stdout, /Created .*project\.yaml/);
    ok((await readFile(join(repo, "AGENTS.md"), "utf8")).includes("Leftoff: reporting protocol"));

    // An agent works and tries to end its turn without reporting.
    await commit(repo, "booking-form.ts", "export const form = true;\n", "add booking form");
    const stop = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo, session_id: "s1" }), env);
    const decision = JSON.parse(stop.stdout);
    strictEqual(decision.decision, "block");
    match(decision.reason, /leftoff report/);

    // It reports, as asked.
    await leftoff(
      repo,
      [
        "report", "--agent", "claude", "--host", "claude-code", "--status", "blocked",
        "--done", "Booking form with date validation",
        "--doing", "Airbnb iCal sync, about half",
        "--blocked", "Need the iCal URL of the listing",
        "--next", "Finish sync, then tests",
      ],
      "",
      env,
    );

    // Now the same Stop hook lets the turn end.
    const stopAgain = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo }), env);
    strictEqual(stopAgain.stdout.trim(), "");

    // And the human can see where things stand.
    const brief = await leftoff(repo, ["brief"], "", env);
    match(brief.stdout, /Booking form with date validation/);
    match(brief.stdout, /blocked/);

    const state = await readFile(join(repo, ".leftoff", "STATE.md"), "utf8");
    match(state, /Where we left off — Harbor/);
    match(state, /iCal URL/);
    ok(state.split("\n").length <= 30, "STATE.md must stay phone-sized");
  } finally {
    await cleanup(repo);
  }
});

test("end to end: a decision reaches the agent through its inbox", async () => {
  const repo = await tempRepo("storefront");
  const configDir = await mkdtemp(join(tmpdir(), "leftoff-cfg-"));
  const env = { LEFTOFF_CONFIG_DIR: configDir };
  try {
    await leftoff(repo, ["init", "--no-hooks"], "", env);
    await leftoff(repo, ["report", "--agent", "claude", "--host", "claude-code", "--status", "needs_input",
      "--question", "Leaflet or Google Maps?", "--option", "Leaflet", "--option", "Google Maps", "--recommend", "Leaflet"], "", env);

    await leftoff(repo, ["inbox", "send", "claude", "usa", "Leaflet"], "", env);

    // The session-start hook hands it over exactly once.
    const first = await leftoff(repo, ["hook", "claude-code", "session-start"], JSON.stringify({ cwd: repo }), env);
    match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /usa Leaflet/);
    strictEqual(JSON.parse(first.stdout).hookSpecificOutput.hookEventName, "SessionStart");

    const second = await leftoff(repo, ["hook", "claude-code", "session-start"], JSON.stringify({ cwd: repo }), env);
    const context = JSON.parse(second.stdout).hookSpecificOutput.additionalContext as string;
    ok(!context.includes("usa Leaflet"), "a delivered message must not be delivered twice");
    // Every session is still briefed on the protocol, whatever branch it is on.
    match(context, /leftoff report/);
  } finally {
    await cleanup(repo);
  }
});

test("a repository without leftoff init is left completely alone", async () => {
  const repo = await tempRepo("untouched");
  try {
    const stop = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo }));
    strictEqual(stop.stdout.trim(), "");
    strictEqual(stop.stderr.trim(), "");
  } finally {
    await cleanup(repo);
  }
});

test("init's own edits to AGENTS.md and CLAUDE.md are never mistaken for agent work", async () => {
  const repo = await tempRepo("fresh");
  const env = { LEFTOFF_CONFIG_DIR: await mkdtemp(join(tmpdir(), "leftoff-cfg-")) };
  try {
    await commit(repo, "CLAUDE.md", "# Project\n", "add claude.md");
    await leftoff(repo, ["init", "--no-hooks"], "", env);
    // Uncommitted: AGENTS.md created, CLAUDE.md modified, .leftoff/ added.
    const stop = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo }), env);
    strictEqual(stop.stdout.trim(), "", "the first turn after init must not be blocked for init's own changes");

    // Real work after init still counts.
    await commit(repo, "feature.ts", "export {};\n", "real work");
    const after = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo }), env);
    strictEqual(JSON.parse(after.stdout).decision, "block");
  } finally {
    await cleanup(repo);
  }
});

test("an agent in a Paseo-style worktree reports into the main checkout", async () => {
  const repo = await tempRepo("clipforge");
  const env = { LEFTOFF_CONFIG_DIR: await mkdtemp(join(tmpdir(), "leftoff-cfg-")) };
  const worktree = join(repo, "..", "hapless-vulture");
  try {
    // init on main, deliberately not committed: the worktree has no .leftoff/ of its own.
    await leftoff(repo, ["init", "--no-hooks"], "", env);
    await git("git", ["worktree", "add", "-q", "-b", "init-dev", worktree], { cwd: repo });

    // The agent works in the worktree and tries to stop without reporting.
    await commit(worktree, "edl.ts", "export const edl = {};\n", "feat: edl schema");
    const stop = await leftoff(worktree, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: worktree }), env);
    strictEqual(JSON.parse(stop.stdout).decision, "block", "work in a worktree must be caught");

    const reported = await leftoff(
      worktree,
      ["report", "--agent", "claude", "--host", "claude-code", "--status", "progress", "--done", "EDL schema"],
      "",
      env,
    );
    match(reported.stdout, new RegExp(`${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.leftoff/reports/`));

    // The owner, on main, sees it — with the branch it happened on.
    const brief = await leftoff(repo, ["brief"], "", env);
    match(brief.stdout, /EDL schema/);
    match(brief.stdout, /init-dev/);

    // And the agent is not nagged again for work it has reported.
    const again = await leftoff(worktree, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: worktree }), env);
    strictEqual(again.stdout.trim(), "");

    // A decision sent from main reaches the agent in its worktree.
    await leftoff(repo, ["inbox", "send", "claude", "prima", "i", "test"], "", env);
    const start = await leftoff(worktree, ["hook", "claude-code", "user-prompt-submit"], JSON.stringify({ cwd: worktree }), env);
    match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /prima i test/);
  } finally {
    await cleanup(repo);
  }
});

async function writeTranscript(dir: string, tools: string[], prompt = "analizza i concorrenti"): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const file = join(dir, "transcript.jsonl");
  const lines = [
    { type: "user", timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: "turno precedente" } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch" }] } },
    { type: "user", timestamp: new Date(Date.now() - 1_000).toISOString(), message: { content: [{ type: "text", text: prompt }] } },
    ...tools.map((name) => ({ type: "assistant", message: { content: [{ type: "tool_use", name }] } })),
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    // A sub-agent's own tool calls are not the main turn's.
    { type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", name: "WebFetch" }] } },
  ];
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

test("a research turn that changed nothing is asked for findings once; a chat turn is not", async () => {
  const repo = await tempRepo("research");
  const env = { LEFTOFF_CONFIG_DIR: await mkdtemp(join(tmpdir(), "leftoff-cfg-")) };
  try {
    await leftoff(repo, ["init", "--no-hooks"], "", env);

    const research = await writeTranscript(join(repo, ".."), ["Read", "WebSearch", "WebFetch"]);
    const stop = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo, transcript_path: research }), env);
    const decision = JSON.parse(stop.stdout);
    strictEqual(decision.decision, "block");
    match(decision.reason, /--found/);
    match(decision.reason, /just finish/);

    // Asked once: the host sets stop_hook_active on the retry.
    const retry = await leftoff(repo, ["hook", "claude-code", "stop"],
      JSON.stringify({ cwd: repo, transcript_path: research, stop_hook_active: true }), env);
    strictEqual(retry.stdout.trim(), "");

    // A light conversational turn passes untouched — the earlier turn's WebSearch does not count.
    const chat = await writeTranscript(join(repo, ".."), ["Read"], "grazie");
    const quiet = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo, transcript_path: chat }), env);
    strictEqual(quiet.stdout.trim(), "");
  } finally {
    await cleanup(repo);
  }
});

test("a reported research turn is not asked again, and its decisions reach decisions.md", async () => {
  const repo = await tempRepo("decide");
  const env = { LEFTOFF_CONFIG_DIR: await mkdtemp(join(tmpdir(), "leftoff-cfg-")) };
  try {
    await leftoff(repo, ["init", "--no-hooks"], "", env);
    const research = await writeTranscript(join(repo, ".."), ["WebSearch"]);
    await leftoff(repo, ["report", "--agent", "claude", "--status", "progress",
      "--found", "Klap non esporta EDL", "--decided", "Deepgram Nova-3 per l'ASR italiano: timestamp per parola"], "", env);

    const stop = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo, transcript_path: research }), env);
    strictEqual(stop.stdout.trim(), "", "already reported in this turn");

    const decisions = await readFile(join(repo, ".leftoff", "decisions.md"), "utf8");
    match(decisions, /Deepgram Nova-3/);
    match(decisions, /— agent/);
    const brief = await leftoff(repo, ["brief"], "", env);
    match(brief.stdout, /found: Klap non esporta EDL/);
    match(brief.stdout, /decided: Deepgram/);
  } finally {
    await cleanup(repo);
  }
});

test("sub-agents are never asked to report on the main agent's behalf", async () => {
  const repo = await tempRepo("subagent");
  const env = { LEFTOFF_CONFIG_DIR: await mkdtemp(join(tmpdir(), "leftoff-cfg-")) };
  try {
    await leftoff(repo, ["init", "--no-hooks"], "", env);
    await commit(repo, "work.ts", "export {};\n", "unreported work");
    const sub = await leftoff(repo, ["hook", "claude-code", "subagent-stop"], JSON.stringify({ cwd: repo }), env);
    strictEqual(sub.stdout.trim(), "");
  } finally {
    await cleanup(repo);
  }
});

test("re-running init to refresh the protocol block neither nags nor moves the baseline", async () => {
  const repo = await tempRepo("refresh");
  const env = { LEFTOFF_CONFIG_DIR: await mkdtemp(join(tmpdir(), "leftoff-cfg-")) };
  try {
    await leftoff(repo, ["init", "--no-hooks"], "", env);
    // Owner commits the setup, as they would.
    await git("git", ["add", "-A"], { cwd: repo });
    await git("git", ["commit", "-q", "-m", "set up leftoff"], { cwd: repo });
    const before = await readFile(join(repo, ".leftoff", "project.yaml"), "utf8");

    // Simulate a newer Leftoff with a different block: only the block differs from HEAD.
    const agents = join(repo, "AGENTS.md");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(agents, (await readFile(agents, "utf8")).replace("Two duties", "Two small duties"), "utf8");
    await leftoff(repo, ["init", "--no-hooks"], "", env);

    const stop = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo }), env);
    strictEqual(stop.stdout.trim(), "", "a protocol-block-only change is not agent work");
    strictEqual(await readFile(join(repo, ".leftoff", "project.yaml"), "utf8"), before);
  } finally {
    await cleanup(repo);
  }
});

test("reporting, then committing the work together with the report, is covered", async () => {
  const repo = await tempRepo("order");
  const env = { LEFTOFF_CONFIG_DIR: await mkdtemp(join(tmpdir(), "leftoff-cfg-")) };
  try {
    await leftoff(repo, ["init", "--no-hooks"], "", env);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repo, "feature.ts"), "export {};\n", "utf8");
    await leftoff(repo, ["report", "--agent", "claude", "--status", "done", "--done", "feature"], "", env);
    await git("git", ["add", "-A"], { cwd: repo });
    await git("git", ["commit", "-q", "-m", "feature, with its report"], { cwd: repo });
    const stop = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo }), env);
    strictEqual(stop.stdout.trim(), "");

    // Work done after the report and committed with it is still new work.
    await leftoff(repo, ["report", "--agent", "claude", "--status", "progress", "--done", "next step"], "", env);
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(repo, "later.ts"), "export const later = 1;\n", "utf8");
    await git("git", ["add", "-A"], { cwd: repo });
    await git("git", ["commit", "-q", "-m", "later work plus the old report"], { cwd: repo });
    const again = await leftoff(repo, ["hook", "claude-code", "stop"], JSON.stringify({ cwd: repo }), env);
    strictEqual(JSON.parse(again.stdout).decision, "block");
  } finally {
    await cleanup(repo);
  }
});
