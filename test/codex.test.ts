import { ok, strictEqual, match, doesNotMatch } from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex } from "../src/hosts/codex.ts";
import type { HostRoot } from "../src/hosts/types.ts";

async function tempCodexHome(configToml?: string): Promise<HostRoot> {
  const dir = await mkdtemp(join(tmpdir(), "leftoff-codex-"));
  await mkdir(dir, { recursive: true });
  if (configToml !== undefined) await writeFile(join(dir, "config.toml"), configToml, "utf8");
  return { hostId: "codex", dir, origin: "test" };
}

const BIN = "/usr/local/bin/leftoff";

test("installs hooks and the notify program", async () => {
  const root = await tempCodexHome("");
  try {
    const result = await codex.install(root, BIN);
    ok(result.installed.includes("SessionStart"));
    ok(result.installed.includes("notify(agent-turn-complete)"));

    const hooks = JSON.parse(await readFile(join(root.dir, "hooks", "hooks.json"), "utf8"));
    strictEqual(hooks.hooks.SessionStart[0].hooks[0].command, `${BIN} hook codex session-start`);
    strictEqual(hooks.hooks.SessionStart[0].hooks[0].type, "command");

    match(await readFile(join(root.dir, "config.toml"), "utf8"), /^notify = \["\/usr\/local\/bin\/leftoff",/m);
  } finally {
    await rm(root.dir, { recursive: true, force: true });
  }
});

test("keeps the user's config.toml intact, comments and all", async () => {
  const original = [
    "# my settings",
    'model = "gpt-5.6-sol"',
    "",
    '[projects."/home/me/x"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  const root = await tempCodexHome(original);
  try {
    await codex.install(root, BIN);
    const after = await readFile(join(root.dir, "config.toml"), "utf8");
    ok(after.includes("# my settings"));
    ok(after.includes('model = "gpt-5.6-sol"'));
    ok(after.includes('[projects."/home/me/x"]'));
    // `notify` must land at the top level, above the first table.
    const lines = after.split("\n");
    ok(lines.findIndex((l) => l.startsWith("notify =")) < lines.findIndex((l) => l.startsWith("[")));
  } finally {
    await rm(root.dir, { recursive: true, force: true });
  }
});

test("refuses to clobber a notify program the user already set", async () => {
  const root = await tempCodexHome('notify = ["/usr/bin/my-notifier"]\n');
  try {
    await codex.install(root, BIN).then(
      () => ok(false, "expected install to refuse"),
      (error: Error) => match(error.message, /already sets `notify`/),
    );
    ok((await readFile(join(root.dir, "config.toml"), "utf8")).includes("my-notifier"));
  } finally {
    await rm(root.dir, { recursive: true, force: true });
  }
});

test("install is idempotent and uninstall reverses exactly what it added", async () => {
  const root = await tempCodexHome('model = "gpt-5.6-sol"\n');
  try {
    await codex.install(root, BIN);
    const second = await codex.install(root, BIN);
    strictEqual(second.installed.length, 0);

    await codex.uninstall(root);
    const config = await readFile(join(root.dir, "config.toml"), "utf8");
    doesNotMatch(config, /^notify =/m);
    ok(config.includes('model = "gpt-5.6-sol"'));

    const hooks = JSON.parse(await readFile(join(root.dir, "hooks", "hooks.json"), "utf8"));
    strictEqual(hooks.hooks, undefined);
  } finally {
    await rm(root.dir, { recursive: true, force: true });
  }
});

test("doctor reports what is missing before install and healthy after", async () => {
  const root = await tempCodexHome("");
  try {
    const before = await codex.status(root, BIN);
    ok(before.missing.includes("notify(agent-turn-complete)"));
    await codex.install(root, BIN);
    const after = await codex.status(root, BIN);
    strictEqual(after.missing.length, 0);
    strictEqual(after.stale.length, 0);
  } finally {
    await rm(root.dir, { recursive: true, force: true });
  }
});
