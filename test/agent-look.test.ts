import { deepStrictEqual, match, rejects, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { beforeEach, test } from "node:test";
import { loadProject } from "../src/core/project.ts";
import { isolateHost, tempProject } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-look-");
});

test("leftoff agents look sets an agent's figure, keeps the other half, refuses a wrong word, and --clear forgets it (D-062)", async () => {
  const p = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code" }] });
  const cli = resolve("src/cli.ts");
  const run = async (...args: string[]) => (await promisify(execFile)(process.execPath, [cli, "agents", "look", "ux", ...args], { cwd: p.root, env: process.env })).stdout.trim();
  const look = async () => (await loadProject(p.root)).config.agents[0]!.look;
  strictEqual(await run("--gender", "woman"), "ux: woman");
  strictEqual(await run("--set", "cartoon"), "ux: woman, cartoon");
  deepStrictEqual(await look(), { gender: "woman", set: "cartoon" });
  await rejects(run("--set", "south-park"), (e: { stderr: string }) => (match(e.stderr, /Unknown set "south-park"/), true));
  deepStrictEqual(await look(), { gender: "woman", set: "cartoon" });
  strictEqual(await run("--clear"), "ux: the figure its id gives.");
  strictEqual(await look(), undefined);
});
