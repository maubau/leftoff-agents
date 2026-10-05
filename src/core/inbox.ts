import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Project } from "./project.ts";

export const InboxMessageSchema = z.object({
  id: z.string(),
  at: z.iso.datetime({ offset: true }),
  /** Who the message speaks for: the user directly, or the PM relaying them. */
  from: z.enum(["user", "pm"]).default("pm"),
  text: z.string().min(1),
  /** Set once the agent has been shown the message. */
  deliveredAt: z.string().nullable().default(null),
});

export type InboxMessage = z.infer<typeof InboxMessageSchema>;

/**
 * The inbox is an append-only JSONL file per agent. Delivery is recorded by
 * rewriting the file with `deliveredAt` set; a crash mid-write at worst
 * re-delivers a message, which is harmless.
 */
export async function enqueue(
  project: Project,
  agentId: string,
  text: string,
  from: InboxMessage["from"] = "pm",
): Promise<InboxMessage> {
  const message: InboxMessage = {
    id: randomUUID(),
    at: new Date().toISOString(),
    from,
    text,
    deliveredAt: null,
  };
  await mkdir(project.paths.inbox, { recursive: true });
  await appendFile(project.paths.inboxFor(agentId), `${JSON.stringify(message)}\n`, "utf8");
  return message;
}

export async function readInbox(project: Project, agentId: string): Promise<InboxMessage[]> {
  const raw = await readFile(project.paths.inboxFor(agentId), "utf8").catch(() => "");
  const messages: InboxMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(InboxMessageSchema.parse(JSON.parse(line)));
    } catch {
      /* skip a corrupted line rather than lose the whole inbox */
    }
  }
  return messages;
}

export async function pending(project: Project, agentId: string): Promise<InboxMessage[]> {
  return (await readInbox(project, agentId)).filter((m) => m.deliveredAt === null);
}

export async function markDelivered(
  project: Project,
  agentId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const set = new Set(ids);
  const at = new Date().toISOString();
  const messages = (await readInbox(project, agentId)).map((m) =>
    set.has(m.id) && m.deliveredAt === null ? { ...m, deliveredAt: at } : m,
  );
  const body = messages.map((m) => JSON.stringify(m)).join("\n");
  await writeFile(project.paths.inboxFor(agentId), body ? `${body}\n` : "", "utf8");
}

/** Render pending messages as the block injected into an agent's context. */
export function renderForAgent(messages: readonly InboxMessage[]): string {
  if (messages.length === 0) return "";
  const lines = messages.map((m) => {
    const when = m.at.slice(0, 16).replace("T", " ");
    return `- (${when}) ${m.text}`;
  });
  return [
    "## Messages from your project manager",
    "",
    "These come from the human owner of this project. Treat them as instructions",
    "with priority over your current plan, and acknowledge them in your next report.",
    "",
    ...lines,
  ].join("\n");
}
