import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConsoleChannel } from "../channels/console.ts";
import { MirrorChannel } from "../channels/mirror.ts";
import { TelegramChannel } from "../channels/telegram.ts";
import { resolveBinaryArgv } from "../core/binary.ts";
import { loadConfig, loadSecrets } from "../core/config.ts";
import { Hub } from "../hub/hub.ts";
import { createSpeech, defaultVoice } from "../voice/factory.ts";
import { watchedProjects } from "../hub/watcher.ts";
import { ensureWebToken } from "../core/web-token.ts";
import { Data } from "../web/data.ts";
import { Feed } from "../web/feed.ts";
import { WebServer } from "../web/server.ts";

const exec = promisify(execFile);

export async function runHub(options: { console: boolean }): Promise<void> {
  await loadSecrets();
  const config = await loadConfig();
  const inner = options.console ? new ConsoleChannel({ interactive: true }) : new TelegramChannel(config);
  // The control panel hears what the chat hears, and talks to the PM through the same door.
  const feed = new Feed();
  await feed.load();
  const channel = new MirrorChannel(inner, feed);
  const { transcriber, synthesizer, why } = createSpeech(config.voice, config.language);
  let web: WebServer | undefined;
  const hub = new Hub({
    config,
    channel,
    onContact: (contact) => void web?.contact(contact),
    ...(transcriber ? { transcriber } : {}),
    ...(synthesizer ? { synthesizer } : {}),
  });
  process.stderr.write(
    transcriber
      ? `voice: in ${transcriber.id} (${config.voice.model}, ${config.voice.language}); out ${synthesizer ? `${config.voice.speak.model ?? defaultVoice(config.language) ?? "no voice"}, mode ${config.voice.speak.mode}` : "off"}\n`
      : `voice: off (${why})\n`,
  );
  // The panel always has a password, even on loopback: otherwise any local process — the agents
  // included — could write to the PM's chat. Generated once; never logged.
  if (config.web.enabled) {
    const { created } = await ensureWebToken();
    if (created) process.stderr.write("control panel: a password was generated in secrets.env (LEFTOFF_WEB_TOKEN); get the link with `leftoff web link`\n");
  }
  const shutdown = async () => {
    await web?.stop();
    await hub.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await hub.start();
  web = config.web.enabled ? new WebServer({ config: config.web, data: new Data({ config, state: () => hub.state }), feed, mirror: channel, token: process.env.LEFTOFF_WEB_TOKEN }) : undefined;
  // The panel is a convenience on top of the hub: if it cannot start (port taken, no password for a
  // public address), the PM keeps working and says why.
  await web?.start().catch((e: Error) => process.stderr.write(`control panel not started: ${e.message}\n`));
  if (options.console) process.stdout.write("Hub running on the console. Type a question, or @project question. Ctrl-C to stop.\n");
}

/** What tomorrow's stand-up would say, without sending anything. */
export async function previewStandup(): Promise<string> {
  const config = await loadConfig();
  const hub = new Hub({ config, channel: new ConsoleChannel() });
  const projects = (await watchedProjects()).filter((p) => p.config.visibility !== "private");
  return hub.standup(projects);
}

const UNIT = "leftoff-hub.service";

/** A systemd user service, so the hub survives logouts and reboots. */
export async function installService(print: (line: string) => void): Promise<void> {
  const argv = await resolveBinaryArgv();
  const dir = join(homedir(), ".config", "systemd", "user");
  await mkdir(dir, { recursive: true });
  const unit = [
    "[Unit]",
    "Description=Leftoff Agents hub — the project manager for your coding agents",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${argv.join(" ")} hub`,
    "Restart=on-failure",
    "RestartSec=15",
    // The hub reads repos and writes only its own state; keep it modest.
    "Nice=10",
    `Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  await writeFile(join(dir, UNIT), unit, "utf8");
  print(`✓ Wrote ${join(dir, UNIT)}`);

  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", "--now", UNIT]);
  print("✓ Enabled and started. Logs:  journalctl --user -u leftoff-hub -f");

  const linger = await exec("loginctl", ["show-user", userInfo().username, "-p", "Linger"]).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  if (linger !== "Linger=yes") {
    print("! Without lingering the hub stops when you log out. Enable it once with:");
    print(`    sudo loginctl enable-linger ${userInfo().username}`);
  }
}
