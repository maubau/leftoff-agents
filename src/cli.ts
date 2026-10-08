#!/usr/bin/env node
import { Command, Option } from "commander";
import { UserError } from "./core/errors.ts";
import { resolveProject, saveProject } from "./core/project.ts";
import { findAgentByName } from "./core/agents.ts";
import { buildSnapshot } from "./core/snapshot.ts";
import { renderBrief, writeState } from "./core/render.ts";
import { STATUSES } from "./core/report.ts";
import { runHook } from "./hooks/index.ts";
import { init } from "./commands/init.ts";
import { report } from "./commands/report.ts";
import { readAgentInbox, sendToAgent } from "./commands/inbox.ts";
import { doctor, installHooks, uninstallHooks } from "./commands/hosts.ts";
import { listProjects, unregisterProject } from "./commands/projects.ts";
import { loadConfig, loadSecrets } from "./core/config.ts";
import { rotateWebToken, storedWebToken, webLink } from "./core/web-token.ts";
import { findRepoRoot } from "./core/git.ts";
import { tryResolveProject } from "./core/project.ts";
import { askPm } from "./pm/pm.ts";
import { pmDoctor } from "./commands/pm.ts";
import { readSpend, spentThisMonth } from "./pm/ledger.ts";
import { connectTelegram } from "./commands/connect.ts";
import { installService, previewStandup, runHub } from "./commands/hub.ts";

const VERSION = "0.1.0";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `--body -` reads the report body from stdin, so agents can pipe Markdown in. */
async function resolveBody(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value !== "-") return value;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const program = new Command();

program
  .name("leftoff")
  .description("Leftoff Agents — pick up where your AI coding agents left off.")
  .version(VERSION);

program
  .command("init")
  .description("set this repository up for Leftoff and install the agent hooks")
  .option("--name <name>", "human-readable project name (default: directory name)")
  .option("--purpose <text>", "one line: what this project is for")
  .option("--private", "never send anything about this project to chat", false)
  .option("--no-hooks", "do not touch any host configuration")
  .option("--force", "rewrite project.yaml if it already exists", false)
  .action(async (options) => {
    const log = await init(process.cwd(), {
      name: options.name,
      purpose: options.purpose,
      private: options.private,
      hooks: options.hooks,
      force: options.force,
    });
    process.stdout.write(`${log.join("\n")}\n`);
  });

program
  .command("report")
  .description("record what this turn did (agents run this; humans rarely need to)")
  .addOption(new Option("--status <status>", "how the turn ended").choices([...STATUSES]).makeOptionMandatory())
  .option("--agent <id>", "which agent is reporting")
  .option("--host <host>", "claude-code | codex | other")
  .option("--done <item>", "an outcome finished this turn (repeatable)", collect, [])
  .option("--doing <item>", "work left half done (repeatable)", collect, [])
  .option("--blocked <item>", "what is stopping progress (repeatable)", collect, [])
  .option("--next <item>", "what should happen next (repeatable)", collect, [])
  .option("--found <item>", "something learned worth remembering (repeatable)", collect, [])
  .option("--decided <item>", "a choice you made, and why (repeatable)", collect, [])
  .option("--question <text>", "a question for the human owner")
  .option("--option <text>", "an answer option for --question (repeatable)", collect, [])
  .option("--recommend <text>", "which option you recommend")
  .option("--handoff <teammate: ask>", "work a teammate must do, e.g. \"main-dev: expose GET /api/bookings\" (repeatable)", collect, [])
  .option("--body <markdown>", 'longer notes; use "-" to read stdin')
  .option("--transcript <path>", "host transcript to read cost from")
  .option("--session <id>", "host session id")
  .option("--cost-usd <number>", "cost of this turn in USD", Number.parseFloat)
  .option("--model <name>", "model that did the work")
  .action(async (options) => {
    const project = await resolveProject();
    const { file, data } = await report(project, {
      ...options,
      body: await resolveBody(options.body),
    });
    process.stdout.write(`Reported ${data.status} for ${data.agent} → ${file}\n`);
  });

const inbox = program
  .command("inbox")
  .description("read the messages your project manager left for an agent")
  .option("--agent <id>", "which agent's inbox")
  .option("--peek", "show without marking as delivered", false)
  .action(async (options) => {
    const project = await resolveProject();
    const text = await readAgentInbox(project, { agent: options.agent, peek: options.peek });
    process.stdout.write(text ? `${text}\n` : "No pending messages.\n");
  });

inbox
  .command("send <agent> <message...>")
  .description("queue a message for an agent (the PM does this for you from chat)")
  .option("--from <who>", "user | pm", "user")
  .action(async (agent, message, options) => {
    const project = await resolveProject();
    await sendToAgent(project, agent, message.join(" "), options.from === "pm" ? "pm" : "user");
    process.stdout.write(`Queued for ${agent}. It will see it at its next turn.\n`);
  });

program
  .command("brief")
  .description("where did I leave off? — the whole project in one screen")
  .option("--json", "machine-readable snapshot", false)
  .option("--days <n>", "how far back to look", (v) => Number.parseInt(v, 10), 14)
  .action(async (options) => {
    const project = await resolveProject();
    const snapshot = await buildSnapshot(project, options.days);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ...snapshot, project: { id: project.id, root: project.root, config: project.config } }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(`${renderBrief(snapshot)}\n`);
  });

program
  .command("state")
  .description("regenerate .leftoff/STATE.md")
  .action(async () => {
    const project = await resolveProject();
    const file = await writeState(await buildSnapshot(project));
    process.stdout.write(`${file}\n`);
  });

const projects = program.command("projects").description("the repositories Leftoff watches");

projects
  .command("list", { isDefault: true })
  .option("--json", "machine-readable", false)
  .action(async (options) => {
    const rows = await listProjects();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (rows.length === 0) {
      process.stdout.write("No projects yet. Run `leftoff init` inside a repository.\n");
      return;
    }
    for (const row of rows) {
      const when = row.lastActivityAt ? row.lastActivityAt.slice(0, 16).replace("T", " ") : "never";
      process.stdout.write(
        row.ok
          ? `${row.id.padEnd(20)} ${String(row.headline).padEnd(12)} last: ${when}  ${row.path}\n`
          : `${row.id.padEnd(20)} ✗ ${row.error}\n`,
      );
    }
  });

projects
  .command("forget <idOrPath>")
  .description("stop watching a project (leaves its files untouched)")
  .action(async (idOrPath) => {
    const removed = await unregisterProject(idOrPath);
    process.stdout.write(removed ? `Forgot ${idOrPath}.\n` : `Not watching ${idOrPath}.\n`);
  });

const agents = program.command("agents").description("this project's agents and their roles in the team");

agents
  .command("list", { isDefault: true })
  .action(async () => {
    const project = await resolveProject();
    const team = project.config.agents.filter((a) => !a.retired);
    if (team.length === 0) {
      process.stdout.write("No agents yet: an agent appears here after its first report.\n");
      return;
    }
    for (const a of team) {
      process.stdout.write(`${a.id.padEnd(22)} ${(a.label ?? "").padEnd(28)} ${a.role ?? "(no role: leftoff agents role <agent> \"…\")"}\n`);
    }
  });

agents
  .command("role <agent> [role...]")
  .description('what an agent does in the team, e.g. leftoff agents role main-dev "architect and backend; merges to main"; no role removes it')
  .action(async (wanted: string, words: string[]) => {
    const project = await resolveProject();
    const agent = findAgentByName(project, wanted);
    if (!agent) throw new UserError(`No agent "${wanted}" in ${project.id}`, `Known: ${project.config.agents.map((a) => a.id).join(", ") || "none yet"}.`);
    const role = words.join(" ").trim().slice(0, 200);
    if (role) agent.role = role;
    else delete agent.role;
    await saveProject(project.root, project.config);
    process.stdout.write(role ? `${agent.id}: ${role}\nIts teammates learn it at their next session.\n` : `${agent.id}: role removed.\n`);
  });

const hosts = program.command("hosts").description("manage the hooks Leftoff installs into your agents");

hosts
  .command("install")
  .option("--host <id>", "claude-code | codex")
  .action(async (options) => {
    process.stdout.write(`${(await installHooks(options.host)).join("\n")}\n`);
  });

hosts
  .command("uninstall")
  .option("--host <id>", "claude-code | codex")
  .action(async (options) => {
    process.stdout.write(`${(await uninstallHooks(options.host)).join("\n")}\n`);
  });

hosts
  .command("doctor", { isDefault: true })
  .description("check that every host is wired up correctly")
  .action(async () => {
    const { lines, healthy } = await doctor();
    process.stdout.write(`${lines.join("\n")}\n`);
    if (!healthy) process.exitCode = 1;
  });

program
  .command("ask <question...>")
  .description("ask the project manager, in plain language")
  .option("--project <id>", "the project to ask about (default: the repo you are in)")
  .option("--json", "include cost, model and tool calls", false)
  .action(async (words: string[], options) => {
    await loadSecrets();
    const config = await loadConfig();
    let project: { id: string; name: string } | undefined;
    if (options.project) {
      project = { id: options.project, name: options.project };
    } else if (await findRepoRoot(process.cwd())) {
      const here = await tryResolveProject();
      if (here) project = { id: here.id, name: here.config.name };
    }
    const result = await askPm({ question: words.join(" "), config, surface: "terminal", ...(project ? { project } : {}) });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...result, run: result.run && { ...result.run, text: undefined } }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${result.text}\n`);
    for (const notice of result.notices) process.stdout.write(`\n${notice}\n`);
    if (!result.skipped) process.stderr.write(`\n(${result.model} · $${result.costUsd.toFixed(4)})\n`);
  });

const pm = program.command("pm").description("the project manager's model, key and budget");

pm.command("doctor", { isDefault: true })
  .description("check the PM's configuration and that its key works (free call)")
  .action(async () => {
    const { lines, healthy } = await pmDoctor();
    process.stdout.write(`${lines.join("\n")}\n`);
    if (!healthy) process.exitCode = 1;
  });

pm.command("spend")
  .description("what the PM itself has cost")
  .action(async () => {
    const config = await loadConfig();
    const entries = await readSpend();
    const month = await spentThisMonth();
    process.stdout.write(
      `This month: $${month.toFixed(4)} of $${config.pm.budget.monthlyUsd.toFixed(2)} cap · ${entries.length} call(s) in total\n`,
    );
    for (const e of entries.slice(-10)) {
      process.stdout.write(`  ${e.at.slice(0, 16).replace("T", " ")}  ${e.purpose.padEnd(8)} ${e.model.padEnd(20)} $${e.costUsd.toFixed(4)}\n`);
    }
  });

program
  .command("connect <channel>")
  .description("connect the PM to a chat app (telegram)")
  .action(async (channel: string) => {
    if (channel !== "telegram") {
      process.stderr.write("Only telegram is supported for now. WhatsApp comes next.\n");
      process.exitCode = 1;
      return;
    }
    await connectTelegram((line) => process.stdout.write(`${line}\n`));
  });

const hub = program
  .command("hub")
  .description("run the always-on project manager: watch the projects, message you, answer you")
  .option("--console", "talk on this terminal instead of Telegram", false)
  .action(async (options) => {
    await runHub({ console: options.console });
  });

hub
  .command("install-service")
  .description("run the hub as a systemd user service, always on")
  .action(async () => {
    await installService((line) => process.stdout.write(`${line}\n`));
  });

hub
  .command("standup")
  .description("print what the stand-up would say now, without sending it")
  .action(async () => {
    process.stdout.write(`${await previewStandup()}\n`);
  });

const web = program.command("web").description("the control panel in the browser");

web
  .command("link", { isDefault: true })
  .description("print the address to open the panel, with its password (open it once)")
  .action(async () => {
    await loadSecrets();
    const config = await loadConfig();
    const token = await storedWebToken();
    if (!token) {
      process.stderr.write("No panel password yet: it is created the first time the hub starts (`leftoff hub`).\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${webLink(config.web, token)}\n`);
    process.stderr.write(
      `The panel listens on ${config.web.host} only. From another machine, tunnel first:  ssh -L ${config.web.port}:127.0.0.1:${config.web.port} <this machine>\n`,
    );
  });

web
  .command("rotate")
  .description("replace the panel password (restart the hub afterwards)")
  .action(async () => {
    await rotateWebToken();
    process.stdout.write("New password stored in secrets.env. Restart the hub (`systemctl --user restart leftoff-hub`), then get the link with `leftoff web link`.\n");
  });

program
  .command("hook <host> <event> [payload]")
  .description("internal: invoked by host hooks, not by you")
  .action(async (host, event, payload) => {
    process.exitCode = await runHook(host, event, payload === undefined ? [] : [payload]);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof UserError) {
    process.stderr.write(`${error.message}\n`);
    if (error.hint) process.stderr.write(`${error.hint}\n`);
    process.exit(1);
  }
  throw error;
}
