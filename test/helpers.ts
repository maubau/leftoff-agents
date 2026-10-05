import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadProject, saveProject, ProjectSchema, type Project } from "../src/core/project.ts";

const exec = promisify(execFile);

export async function tempRepo(name = "demo"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "leftoff-test-"));
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "# demo\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

export async function tempProject(overrides: Partial<Parameters<typeof ProjectSchema.parse>[0]> = {}): Promise<Project> {
  const root = await tempRepo();
  await saveProject(root, ProjectSchema.parse({ name: "Demo", ...(overrides as object) }));
  return loadProject(root);
}

export async function commit(root: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(root, file), content, "utf8");
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-q", "-m", message], { cwd: root });
}

export async function cleanup(root: string): Promise<void> {
  await rm(join(root, ".."), { recursive: true, force: true });
}

/**
 * Point every host-data lookup at an empty temporary directory. Hub tests enable subscription
 * limits by default, and without this they would read the real Codex sessions of the machine
 * running them — a test that passes or fails depending on who ran it.
 */
export async function isolateHost(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  process.env.LEFTOFF_CONFIG_DIR = join(dir, "config");
  process.env.CODEX_HOME = join(dir, "codex");
  // Claude Code limits are tracked per account, and the account comes from this variable: a test
  // run from a Paseo session on a second subscription would otherwise write to one account's
  // file and read another's. Tests that need an account set it themselves.
  delete process.env.CLAUDE_CONFIG_DIR;
  // Who is running the tests must not leak into what they record: a session started by Paseo carries
  // its own identity in these, and hooks spawned by a test inherit it. Independent of how tests are launched.
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "PASEO_AGENT_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "LEFTOFF_AGENT"]) {
    delete process.env[key];
  }
  // Paseo's own registry too: a test must not meet the workspaces of the machine it runs on.
  process.env.PASEO_HOME = join(dir, "paseo");
  return dir;
}
