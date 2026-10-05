import { detectHost, resolveAgentId } from "../core/agents.ts";
import { enqueue, markDelivered, pending, renderForAgent } from "../core/inbox.ts";
import { UserError } from "../core/errors.ts";
import { findAgent, type Project } from "../core/project.ts";

/** Show an agent its pending messages and, unless peeking, mark them delivered. */
export async function readAgentInbox(
  project: Project,
  options: { agent?: string; peek: boolean },
): Promise<string> {
  const agentId = options.agent ?? (await resolveAgentId(project, detectHost()));
  const messages = await pending(project, agentId);
  if (messages.length === 0) return "";
  if (!options.peek) {
    await markDelivered(
      project,
      agentId,
      messages.map((m) => m.id),
    );
  }
  return renderForAgent(messages);
}

export async function sendToAgent(
  project: Project,
  agentId: string,
  text: string,
  from: "user" | "pm",
): Promise<void> {
  if (!findAgent(project, agentId)) {
    const known = project.config.agents.map((a) => a.id).join(", ") || "(none yet)";
    throw new UserError(`No agent "${agentId}" in ${project.id}`, `Known agents: ${known}`);
  }
  await enqueue(project, agentId, text, from);
}
