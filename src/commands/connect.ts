import { Bot } from "grammy";
import { loadConfig, loadSecrets, saveConfig } from "../core/config.ts";
import { UserError } from "../core/errors.ts";
import { TelegramChannel } from "../channels/telegram.ts";
import { watchedProjects } from "../hub/watcher.ts";

const WAIT_MS = 10 * 60_000;

/**
 * Bind Leftoff to one Telegram forum group, interactively:
 * the owner sends /connect in the group, which tells us the group, proves who
 * the owner is (their user id becomes the allow-list) and lets us check the
 * bot's rights before creating one topic per project.
 */
export async function connectTelegram(print: (line: string) => void): Promise<void> {
  await loadSecrets();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new UserError(
      "TELEGRAM_BOT_TOKEN is not set",
      "Create the bot with @BotFather, then store the token in ~/.config/leftoff/secrets.env as TELEGRAM_BOT_TOKEN=…",
    );
  }
  const bot = new Bot(token);
  const me = await bot.api.getMe().catch(() => {
    throw new UserError("Telegram rejected the token", "Check TELEGRAM_BOT_TOKEN in secrets.env.");
  });

  print(`Bot: @${me.username}`);
  print("");
  print("Now, in Telegram:");
  print("  1. Create a group, open its settings and turn on Topics.");
  print(`  2. Add @${me.username} to the group and make it an administrator`);
  print('     with the "Manage topics" right.');
  print("  3. Send  /connect  in the group.");
  print("");
  print("Waiting for /connect (10 minutes)…");

  const deadline = Date.now() + WAIT_MS;
  let offset = 0;
  while (Date.now() < deadline) {
    const updates = await bot.api.getUpdates({ offset, timeout: 30, allowed_updates: ["message"] });
    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (msg) {
        const kind = msg.chat.type === "supergroup" && "is_forum" in msg.chat && msg.chat.is_forum ? "forum" : msg.chat.type;
        print(`· message in a ${kind} chat from ${msg.from?.first_name ?? "?"}: ${(msg.text ?? "(no text)").slice(0, 30)}`);
      }
      if (!msg?.text || !/^\/(connect|collega)(@\w+)?\b/.test(msg.text) || !msg.from) continue;

      if (msg.chat.type !== "supergroup" || !("is_forum" in msg.chat) || !msg.chat.is_forum) {
        await bot.api.sendMessage(msg.chat.id, "This group does not have Topics turned on. Turn them on in the group settings and send /connect again.");
        print("✗ That group does not have Topics enabled yet. Enable them and send /connect again.");
        continue;
      }
      const member = await bot.api.getChatMember(msg.chat.id, me.id);
      const canTopics = member.status === "administrator" && member.can_manage_topics;
      if (!canTopics) {
        await bot.api.sendMessage(msg.chat.id, "Make me an administrator with the \"Manage topics\" right, then send /connect again.", {
          ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
        });
        print('✗ The bot is not an admin with "Manage topics". Fix it and send /connect again.');
        continue;
      }

      // Confirm the update so the hub does not see /connect again.
      await bot.api.getUpdates({ offset, timeout: 0 });

      const config = await loadConfig();
      config.channel = "telegram";
      config.telegram.chatId = msg.chat.id;
      config.telegram.allowedUserIds = [...new Set([...config.telegram.allowedUserIds, msg.from.id])];
      await saveConfig(config);
      print(`✓ Connected to "${msg.chat.title}"; only you (${msg.from.first_name}, id ${msg.from.id}) can talk to the PM.`);

      const channel = new TelegramChannel(config, token, print);
      const projects = (await watchedProjects()).filter((p) => p.config.visibility !== "private");
      await channel.ensureThreads(projects.map((p) => ({ id: p.id, name: p.config.name })));
      await channel.send(
        null,
        "👋 Hi, I'm the project manager of your agents.\n" +
          "Here in General I answer about every project and send the stand-up each morning. " +
          "Each project has its own topic, where I tell you when an agent finishes, gets blocked or needs you.\n" +
          "Just write to me, for example: \"where are we?\".",
      );
      for (const project of projects) {
        await channel.send(project.id, `Topic for ${project.config.name}. Ask me \"where are we?\" any time.`);
      }
      print(`✓ ${projects.length} project topic(s) ready. Start the hub with:  leftoff hub install-service`);
      return;
    }
  }
  throw new UserError("Timed out waiting for /connect", "Run `leftoff connect telegram` again when ready.");
}
