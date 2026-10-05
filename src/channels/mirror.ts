import type { Feed, FeedEntry } from "../web/feed.ts";
import type { Channel, IncomingMessage, OutgoingAudio } from "./channel.ts";

/**
 * Wraps the real chat channel so the control panel hears everything the chat does, without the
 * hub knowing: what the PM sends on its own, the owner's messages, and the PM's answers. It also
 * lets the browser talk to the hub through the same door Telegram uses — `hub.handle()` — so a
 * question typed in the panel is answered by exactly the same PM, with the same approval rule
 * for instructions to agents.
 */
export class MirrorChannel implements Channel {
  readonly #inner: Channel;
  readonly #feed: Feed;
  #onMessage: ((message: IncomingMessage) => Promise<void>) | undefined;

  constructor(inner: Channel, feed: Feed) {
    this.#inner = inner;
    this.#feed = feed;
  }

  get name(): string {
    return this.#inner.name;
  }

  #source(): FeedEntry["source"] {
    return this.#inner.name === "telegram" ? "telegram" : "console";
  }

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#onMessage = onMessage;
    await this.#inner.start(async (message) => {
      const source = this.#source();
      const spoken = message.audio && !message.text;
      await this.#record(message.projectId, "owner", source, "ask", spoken ? "🎙️ (nota vocale)" : message.text);
      await onMessage({
        ...message,
        reply: async (text) => {
          // The feed gets the words even if the chat app is down; the chat app still decides delivery.
          await this.#record(message.projectId, "pm", source, "reply", text);
          await message.reply(text);
        },
      });
    });
  }

  stop(): Promise<void> {
    return this.#inner.stop();
  }

  async send(projectId: string | null, text: string): Promise<void> {
    await this.#inner.send(projectId, text);
    // After the send: a message the chat refused to take was not "said".
    await this.#record(projectId, "pm", this.#source(), "push", text);
  }

  /** Held back from the chat by the notification level: the panel still keeps it, marked as not sent. */
  async note(projectId: string | null, text: string): Promise<void> {
    await this.#record(projectId, "pm", "hub", "log", text);
  }

  sendVoice(projectId: string | null, audio: OutgoingAudio): Promise<void> {
    return this.#inner.sendVoice ? this.#inner.sendVoice(projectId, audio) : Promise.resolve();
  }

  async ensureThreads(projects: Array<{ id: string; name: string }>): Promise<void> {
    await this.#inner.ensureThreads?.(projects);
  }

  /**
   * The owner writes from the browser. Replies go to the panel only — Telegram is not where
   * this conversation is happening. Resolves when the hub has finished answering.
   */
  async fromWeb(projectId: string | null, text: string, typing: (on: boolean) => void = () => undefined): Promise<void> {
    if (!this.#onMessage) throw new Error("the hub is not listening yet");
    await this.#onMessage({
      text,
      projectId,
      threadKey: `web-${projectId ?? "general"}`,
      reply: async (reply) => {
        await this.#record(projectId, "pm", "web", "reply", reply);
      },
      typing: async () => typing(true),
    });
  }

  async #record(projectId: string | null, role: FeedEntry["role"], source: FeedEntry["source"], kind: FeedEntry["kind"], text: string): Promise<void> {
    if (!text.trim()) return;
    await this.#feed.append({ projectId, role, source, kind, text }).catch(() => undefined);
  }

  /** The owner's own message, as typed in the panel. */
  async recordOwner(projectId: string | null, text: string): Promise<FeedEntry> {
    return this.#feed.append({ projectId, role: "owner", source: "web", kind: "ask", text });
  }
}
