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

/** How a message may be presented. Channels that cannot honour an option ignore it: the text is always complete. */
export interface SendOptions {
  /**
   * Quick answers the owner can tap under the message. Tapping one is exactly the owner sending its
   * `reply` in the same thread, so it goes through the same fixed approval list as a typed «yes».
   */
  choices?: Array<{ label: string; reply: string }>;
}

export interface OutgoingImage {
  /** PNG bytes. */
  bytes: Uint8Array;
  caption: string;
}

export interface IncomingMessage {
  /** Empty for voice notes; the hub fills it in from the transcript. */
  text: string;
  audio?: IncomingAudio;
  /** The project whose thread the message came from, or null for the general one. */
  projectId: string | null;
  /** Thread key for conversation memory. */
  threadKey: string;
  reply(text: string, options?: SendOptions): Promise<void>;
  /** Reply with a picture. Absent on channels that cannot show one. */
  replyImage?(image: OutgoingImage): Promise<void>;
  /** Reply with a voice note. Absent on channels that cannot send one. */
  replyVoice?(audio: OutgoingAudio): Promise<void>;
  typing(): Promise<void>;
}

/** What kind of step an activity-register line records, and between whom (agent ids of the project). */
export interface ActivityMeta {
  type: "instruction" | "handoff" | "delivered" | "status" | "reply" | "report" | "commits" | "task" | "expired";
  /** The agent the step is about: who reported, or who received. */
  agent?: string;
  /** For a handoff: the teammate it goes to (`agent` is who asked). */
  to?: string;
}

export interface Channel {
  readonly name: string;
  /** Start receiving. Resolves once the channel is listening. */
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  /** Send on the hub's own initiative to a project's thread, or the general one. */
  send(projectId: string | null, text: string, options?: SendOptions): Promise<void>;
  /**
   * Record something the hub chose *not* to send (see `notify.level`), for surfaces that show more than
   * the chat does — the control panel keeps it in its log. Channels with nothing to add omit it.
   */
  note?(projectId: string | null, text: string): Promise<void>;
  /**
   * Record a step between the PM and the agents in the activity register (D-052): an instruction or a handoff sent, a
   * delivery, an agent's intermediate answer, a task moved. Never chat: the control panel shows it on its own board.
   */
  activity?(projectId: string, text: string, meta: ActivityMeta): Promise<void>;
  /** Send a picture on the hub's own initiative. */
  sendImage?(projectId: string | null, image: OutgoingImage): Promise<void>;
  /** Send a voice note on the hub's own initiative. */
  sendVoice?(projectId: string | null, audio: OutgoingAudio): Promise<void>;
  /** Make sure every project has somewhere to talk. */
  ensureThreads?(projects: Array<{ id: string; name: string }>): Promise<void>;
}
