/**
 * What the hub needs from a chat app. Telegram implements it now; WhatsApp
 * (OpenWA) is M3. Routing is by project: `null` means the general conversation.
 */
export interface IncomingAudio {
  durationSec: number;
  /** Fetched lazily, so a note that is refused is never downloaded. */
  download(): Promise<{ bytes: Uint8Array; mime: string }>;
}

export interface OutgoingAudio {
  bytes: Uint8Array;
  mime: string;
}

export interface IncomingMessage {
  /** Empty for voice notes; the hub fills it in from the transcript. */
  text: string;
  audio?: IncomingAudio;
  /** The project whose thread the message came from, or null for the general one. */
  projectId: string | null;
  /** Thread key for conversation memory. */
  threadKey: string;
  reply(text: string): Promise<void>;
  /** Reply with a voice note. Absent on channels that cannot send one. */
  replyVoice?(audio: OutgoingAudio): Promise<void>;
  typing(): Promise<void>;
}

export interface Channel {
  readonly name: string;
  /** Start receiving. Resolves once the channel is listening. */
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  /** Send on the hub's own initiative to a project's thread, or the general one. */
  send(projectId: string | null, text: string): Promise<void>;
  /**
   * Record something the hub chose *not* to send (see `notify.level`), for surfaces that show more than
   * the chat does — the control panel keeps it in its log. Channels with nothing to add omit it.
   */
  note?(projectId: string | null, text: string): Promise<void>;
  /** Send a voice note on the hub's own initiative. */
  sendVoice?(projectId: string | null, audio: OutgoingAudio): Promise<void>;
  /** Make sure every project has somewhere to talk. */
  ensureThreads?(projects: Array<{ id: string; name: string }>): Promise<void>;
}
