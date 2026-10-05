import { createInterface } from "node:readline";
import type { Channel, IncomingMessage } from "./channel.ts";

/**
 * The hub without a chat app: messages it would send are printed, and lines
 * typed on stdin are questions in the general conversation (or `@project …`).
 * For trying Leftoff before connecting Telegram, and for tests.
 */
export class ConsoleChannel implements Channel {
  readonly name = "console";
  readonly sent: Array<{ projectId: string | null; text: string }> = [];
  readonly voices: Array<{ projectId: string | null; bytes: number }> = [];
  readonly #interactive: boolean;
  #rl: ReturnType<typeof createInterface> | undefined;

  constructor(options: { interactive?: boolean } = {}) {
    this.#interactive = options.interactive ?? false;
  }

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    if (!this.#interactive) return;
    this.#rl = createInterface({ input: process.stdin });
    this.#rl.on("line", (line) => {
      const match = /^@(\S+)\s+(.*)$/.exec(line.trim());
      const projectId = match ? (match[1] ?? null) : null;
      const text = match ? (match[2] ?? "") : line.trim();
      if (!text) return;
      void onMessage({
        text,
        projectId,
        threadKey: `console-${projectId ?? "general"}`,
        reply: async (reply) => {
          process.stdout.write(`\n${reply}\n\n`);
        },
        typing: async () => undefined,
      });
    });
  }

  async stop(): Promise<void> {
    this.#rl?.close();
  }

  async sendVoice(projectId: string | null, audio: { bytes: Uint8Array }): Promise<void> {
    this.voices.push({ projectId, bytes: audio.bytes.length });
    if (this.#interactive) process.stdout.write(`\n— ${projectId ?? "general"} — 🔊 (${audio.bytes.length} bytes)\n`);
  }

  async send(projectId: string | null, text: string): Promise<void> {
    this.sent.push({ projectId, text });
    if (this.#interactive) process.stdout.write(`\n— ${projectId ?? "general"} —\n${text}\n`);
  }
}
