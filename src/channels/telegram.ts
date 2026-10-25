import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Config } from "../core/config.ts";
import { saveConfig } from "../core/config.ts";
import { UserError } from "../core/errors.ts";
import type { Channel, IncomingMessage, OutgoingImage, SendOptions } from "./channel.ts";
import { telegramHtml } from "../web/public/codeblocks.js";

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
 * The buttons under a message. Telegram limits callback data to 64 bytes: a reply that fits travels in it, a longer one
 * (an agent's option, said with its name) is kept here and the button carries its key. Yes/No stay on one row; options,
 * longer, get a row each so they can be read.
 */
export function keyboard(choices: NonNullable<SendOptions["choices"]>, keep: (reply: string) => string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const rows = choices.length > 2 || choices.some((c) => c.label.length > 24);
  for (const choice of choices) {
    const data = `say:${choice.reply}`;
    kb.text(choice.label, Buffer.byteLength(data) <= 64 ? data : `pick:${keep(choice.reply)}`);
    if (rows) kb.row();
  }
  return kb;
}

/** Replies too long for a button's data, by key; the oldest go first. After a restart their buttons say nothing. */
const KEPT_MAX = 500;

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
  readonly #kept = new Map<string, string>();
  #nextKey = 0;
  /** Different at every start: a button left from before a restart finds nothing, never someone else's reply. */
  readonly #boot = Math.random().toString(36).slice(2, 8);

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

  async #post(threadId: number | undefined, text: string, options: SendOptions = {}): Promise<void> {
    const chatId = this.#config.telegram.chatId!;
    const parts = splitMessage(text);
    for (const [i, part] of parts.entries()) {
      // The buttons go under the last part: they answer the whole message.
      const choices = i === parts.length - 1 ? options.choices : undefined;
      const extra = {
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        link_preview_options: { is_disabled: true },
        ...(choices?.length ? { reply_markup: keyboard(choices, (reply) => this.#keep(reply)) } : {}),
      };
      // Code as code (D-068): a tap on <pre> or <code> copies it in Telegram. Everything else is escaped, so nothing in a
      // message becomes markup; if Telegram still refuses the HTML, the plain text goes instead.
      if (!part.includes("`")) {
        await this.#bot.api.sendMessage(chatId, part, extra);
        continue;
      }
      try {
        await this.#bot.api.sendMessage(chatId, telegramHtml(part), { ...extra, parse_mode: "HTML" });
      } catch {
        await this.#bot.api.sendMessage(chatId, part, extra);
      }
    }
  }

  async #postImage(threadId: number | undefined, image: OutgoingImage): Promise<void> {
    await this.#bot.api.sendPhoto(this.#config.telegram.chatId!, new InputFile(image.bytes, "office.png"), {
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      caption: image.caption.slice(0, 1000),
    });
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
      // A tapped button carries the message it was under: same chat, same thread.
      const message = ctx.message ?? ctx.callbackQuery?.message;
      const threadId = message?.is_topic_message ? message.message_thread_id : undefined;
      return {
        threadId,
        base: {
          projectId: this.#projectFor(threadId),
          threadKey: `telegram-${threadId ?? "general"}`,
          reply: (text: string, options?: SendOptions) => this.#post(threadId, text, options),
          replyImage: (image: OutgoingImage) => this.#postImage(threadId, image),
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
    // A tapped choice is the owner saying its words in that thread; the buttons go, so it cannot be tapped twice.
    this.#bot.on("callback_query:data", async (ctx) => {
      const routed = route(ctx);
      const data = ctx.callbackQuery.data;
      const reply = /^say:(.+)$/s.exec(data)?.[1] ?? this.#kept.get(/^pick:(\w+)$/.exec(data)?.[1] ?? "");
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (!routed || !reply) return;
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      await onMessage({ ...routed.base, text: reply });
    });
    this.#bot.catch((error) => this.#log(`telegram: ${error.message}`));
    await this.#bot.init();
    // bot.start() resolves only when polling stops, so it is not awaited here.
    void this.#bot.start({ drop_pending_updates: false, allowed_updates: ["message", "callback_query"] });
  }

  #keep(reply: string): string {
    const key = `${this.#boot}${(this.#nextKey++).toString(36)}`;
    this.#kept.set(key, reply);
    if (this.#kept.size > KEPT_MAX) this.#kept.delete(this.#kept.keys().next().value!);
    return key;
  }

  async stop(): Promise<void> {
    await this.#bot.stop();
  }

  async send(projectId: string | null, text: string, options?: SendOptions): Promise<void> {
    const threadId = this.#threadFor(projectId);
    // A project with no topic of its own speaks in General, with its name in front.
    const prefix = projectId && threadId === undefined ? `[${projectId}] ` : "";
    // Choices answer in the thread they were sent to: a project without a topic would answer in General.
    await this.#post(threadId, prefix + text, threadId === undefined && projectId ? {} : options);
  }

  async sendImage(projectId: string | null, image: OutgoingImage): Promise<void> {
    await this.#postImage(this.#threadFor(projectId), image);
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
