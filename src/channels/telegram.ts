import { Bot, GrammyError, InputFile, type Context } from "grammy";
import type { Config } from "../core/config.ts";
import { saveConfig } from "../core/config.ts";
import { UserError } from "../core/errors.ts";
import type { Channel, IncomingMessage } from "./channel.ts";

/** Telegram's limit is 4096 characters per message; leave room. */
const MAX_LEN = 3900;

export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LEN) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_LEN) {
    const cut = rest.lastIndexOf("\n", MAX_LEN);
    const at = cut > MAX_LEN / 2 ? cut : MAX_LEN;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * One bot in one forum supergroup: a topic per project and the General topic
 * for everything across projects (D-005). Long polling, so the server needs no
 * public address. Only allow-listed users are heard; everyone else is ignored
 * without a reply, so the bot does not even confirm it exists.
 */
export class TelegramChannel implements Channel {
  readonly name = "telegram";
  readonly #bot: Bot;
  readonly #config: Config;
  readonly #log: (line: string) => void;
  readonly #token: string;

  constructor(config: Config, token = process.env.TELEGRAM_BOT_TOKEN, log?: (line: string) => void) {
    if (!token) {
      throw new UserError("TELEGRAM_BOT_TOKEN is not set", "Add it to ~/.config/leftoff/secrets.env, then run `leftoff connect telegram`.");
    }
    if (!config.telegram.chatId) {
      throw new UserError("Telegram is not connected to a group yet", "Run `leftoff connect telegram`.");
    }
    this.#token = token;
    this.#bot = new Bot(token);
    this.#config = config;
    this.#log = log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  #threadFor(projectId: string | null): number | undefined {
    return projectId ? this.#config.telegram.topics[projectId] : undefined;
  }

  #projectFor(threadId: number | undefined): string | null {
    if (threadId === undefined) return null;
    for (const [projectId, id] of Object.entries(this.#config.telegram.topics)) if (id === threadId) return projectId;
    return null;
  }

  async #postVoice(threadId: number | undefined, audio: { bytes: Uint8Array }): Promise<void> {
    // sendVoice shows a waveform bubble only for Ogg/Opus; anything else becomes a file.
    await this.#bot.api.sendVoice(this.#config.telegram.chatId!, new InputFile(audio.bytes, "voice.ogg"), {
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    });
  }

  async #post(threadId: number | undefined, text: string): Promise<void> {
    const chatId = this.#config.telegram.chatId!;
    for (const part of splitMessage(text)) {
      await this.#bot.api.sendMessage(chatId, part, {
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        link_preview_options: { is_disabled: true },
      });
    }
  }

  /** Download a Telegram file. The token is in the URL, so it is never logged. */
  async #download(fileId: string): Promise<Uint8Array> {
    const file = await this.#bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file path");
    const response = await fetch(`https://api.telegram.org/file/bot${this.#token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    const allowed = new Set(this.#config.telegram.allowedUserIds);

    /** Only the owner, only in the bound group; everyone else gets silence. */
    const route = (ctx: Context) => {
      if (ctx.chat?.id !== this.#config.telegram.chatId || !ctx.from || !allowed.has(ctx.from.id)) return null;
      const message = ctx.message;
      const threadId = message?.is_topic_message ? message.message_thread_id : undefined;
      return {
        threadId,
        base: {
          projectId: this.#projectFor(threadId),
          threadKey: `telegram-${threadId ?? "general"}`,
          reply: (text: string) => this.#post(threadId, text),
          replyVoice: (audio: { bytes: Uint8Array }) => this.#postVoice(threadId, audio),
          typing: async () => {
            await this.#bot.api.sendChatAction(ctx.chat!.id, "typing", threadId !== undefined ? { message_thread_id: threadId } : {});
          },
        },
      };
    };

    this.#bot.on("message:text", async (ctx) => {
      const routed = route(ctx);
      if (routed) await onMessage({ ...routed.base, text: ctx.message.text });
    });
    this.#bot.on("message:voice", async (ctx) => {
      const routed = route(ctx);
      if (!routed) return;
      const voice = ctx.message.voice;
      await onMessage({
        ...routed.base,
        text: "",
        audio: {
          durationSec: voice.duration,
          download: async () => ({ bytes: await this.#download(voice.file_id), mime: voice.mime_type ?? "audio/ogg" }),
        },
      });
    });
    this.#bot.catch((error) => this.#log(`telegram: ${error.message}`));
    await this.#bot.init();
    // bot.start() resolves only when polling stops, so it is not awaited here.
    void this.#bot.start({ drop_pending_updates: false, allowed_updates: ["message"] });
  }

  async stop(): Promise<void> {
    await this.#bot.stop();
  }

  async send(projectId: string | null, text: string): Promise<void> {
    const threadId = this.#threadFor(projectId);
    // A project with no topic of its own speaks in General, with its name in front.
    const prefix = projectId && threadId === undefined ? `[${projectId}] ` : "";
    await this.#post(threadId, prefix + text);
  }

  async sendVoice(projectId: string | null, audio: { bytes: Uint8Array }): Promise<void> {
    await this.#postVoice(this.#threadFor(projectId), audio);
  }

  /** Create a topic for every project that lacks one. Needs the "Manage topics" admin right. */
  async ensureThreads(projects: Array<{ id: string; name: string }>): Promise<void> {
    let changed = false;
    for (const project of projects) {
      if (this.#config.telegram.topics[project.id] !== undefined) continue;
      try {
        const topic = await this.#bot.api.createForumTopic(this.#config.telegram.chatId!, project.name);
        this.#config.telegram.topics[project.id] = topic.message_thread_id;
        changed = true;
        this.#log(`telegram: created topic "${project.name}"`);
      } catch (error) {
        const why = error instanceof GrammyError ? error.description : (error as Error).message;
        this.#log(`telegram: could not create a topic for ${project.id} (${why}); it will speak in General`);
      }
    }
    if (changed) await saveConfig(this.#config);
  }
}
