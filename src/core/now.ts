import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { redact } from "../hub/redact.ts";
import { configRoot } from "./paths.ts";
import type { Project } from "./project.ts";

/**
 * What an agent is doing now (D-043), between two reports: the request its current turn started from —
 * whoever wrote it, in Paseo or through Leftoff — and its latest step, read from its own transcript.
 * Kept on this machine, outside the repository; never shown for a private project.
 */
export interface Now {
  /** The message that opened the turn: one line, secrets redacted, cut at 300 characters. */
  request: string;
  since: string;
  /** Set when the turn ended (Stop, or Codex's end-of-turn notice). */
  ended?: string;
  /** Its latest step: a command, a file it edits or reads, a search, a sub-agent, or its last words. */
  step?: string;
  stepAt?: string;
}

interface Stored {
  request: string;
  at: string;
  host: string;
  transcript?: string;
  endedAt?: string;
}

const REQUEST_MAX = 300;
const STEP_MAX = 140;
/** Only the end of a transcript is read: the latest step is there, and transcripts grow to megabytes. */
const TAIL_BYTES = 256 * 1024;

const file = (projectId: string, agentId: string) => join(configRoot(), "activity", projectId, `${agentId}.json`);

const oneLine = (text: string, max: number) => {
  const line = redact(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

async function store(projectId: string, agentId: string, record: Stored): Promise<void> {
  const target = file(projectId, agentId);
  await mkdir(join(configRoot(), "activity", projectId), { recursive: true, mode: 0o700 });
  // Written whole, then moved: a reader never sees half a file.
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}

async function load(projectId: string, agentId: string): Promise<Stored | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file(projectId, agentId), "utf8")) as Stored;
    return typeof parsed.request === "string" && typeof parsed.at === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A turn starts (UserPromptSubmit): what it was asked, and where its transcript is. */
export async function recordTurnStart(project: Project, agentId: string, host: string, payload: { prompt?: unknown; transcript_path?: unknown }, now = new Date()): Promise<void> {
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) return;
  await store(project.id, agentId, {
    request: oneLine(payload.prompt, REQUEST_MAX),
    at: now.toISOString(),
    host,
    ...(typeof payload.transcript_path === "string" && payload.transcript_path ? { transcript: payload.transcript_path } : {}),
  });
}

/** The turn ended (Stop, Codex notify): the request stays, as what it last worked on, until its report. */
export async function recordTurnEnd(project: Project, agentId: string, now = new Date()): Promise<void> {
  const record = await load(project.id, agentId);
  if (!record || record.endedAt) return;
  await store(project.id, agentId, { ...record, endedAt: now.toISOString() });
}

/** The agent's current (or last unreported) turn, with its latest step when the transcript tells it. */
export async function readNow(project: Pick<Project, "id">, agentId: string): Promise<Now | undefined> {
  const record = await load(project.id, agentId);
  if (!record) return undefined;
  const step = record.transcript ? await latestStep(record.transcript, record.at) : undefined;
  return {
    request: record.request,
    since: record.at,
    ...(record.endedAt ? { ended: record.endedAt } : {}),
    ...(step ? { step: step.text, stepAt: step.at } : {}),
  };
}

async function tail(path: string): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // the first line is cut in half
    return lines;
  } finally {
    await handle.close();
  }
}

/** The last step at or after `since`, newest first through the transcript's end. Claude Code's and Codex's formats. */
export async function latestStep(path: string, since: string): Promise<{ text: string; at: string } | undefined> {
  let lines: string[];
  try {
    lines = await tail(path);
  } catch {
    return undefined;
  }
  const from = Date.parse(since) - 2000;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (at && Date.parse(at) < from) return undefined; // older than this turn: nothing yet
    const text = stepOf(entry);
    if (text) return { text: oneLine(text, STEP_MAX), at: at ?? since };
  }
  return undefined;
}

function stepOf(entry: Record<string, unknown>): string | undefined {
  // Claude Code: { type: "assistant", message: { content: [ {type:"tool_use", name, input} | {type:"text", text} ] } }
  if (entry.type === "assistant" && !entry.isSidechain) {
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return undefined;
    for (let j = content.length - 1; j >= 0; j--) {
      const item = content[j] as { type?: string; name?: string; input?: Record<string, unknown>; text?: string };
      if (item.type === "tool_use" && item.name) return describeTool(item.name, item.input ?? {});
      if (item.type === "text" && item.text?.trim()) return `💬 ${item.text.trim()}`;
    }
    return undefined;
  }
  // Codex: { type: "response_item", payload: { type: "function_call", name, arguments } | { type: "message", role, content } }
  if (entry.type === "response_item") {
    const payload = entry.payload as { type?: string; name?: string; arguments?: string; role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (payload?.type === "function_call" && payload.name) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(payload.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        /* keep the name alone */
      }
      if (payload.name === "apply_patch") return "✎ patch";
      const command = Array.isArray(args.command) ? (args.command as unknown[]).map(String).join(" ") : typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : undefined;
      // Codex runs commands as `bash -lc "<script>"`: the script is what was run.
      return command ? `$ ${command.replace(/^(?:ba|z)?sh -l?c /, "")}` : `⚙ ${payload.name}`;
    }
    if (payload?.type === "message" && payload.role === "assistant") {
      const text = payload.content?.map((c) => c.text ?? "").join(" ").trim();
      return text ? `💬 ${text}` : undefined;
    }
  }
  return undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One line for a Claude Code tool call: what it runs, edits, reads or looks for — never the content it writes. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const file = () => basename(str(input.file_path) || str(input.notebook_path) || str(input.path)) || "";
  switch (name) {
    case "Bash":
      return `$ ${str(input.command).split("\n")[0]}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `✎ ${file()}`;
    case "Read":
      return `📖 ${file()}`;
    case "Grep":
    case "Glob":
      return `🔎 ${str(input.pattern)}`;
    case "WebSearch":
      return `🌐 ${str(input.query)}`;
    case "WebFetch": {
      try {
        return `🌐 ${new URL(str(input.url)).host}`;
      } catch {
        return "🌐 web";
      }
    }
    case "Task":
    case "Agent":
      return `🤖 ${str(input.description) || "sub-agent"}`;
    case "TodoWrite": {
      const doing = Array.isArray(input.todos) ? (input.todos as Array<{ status?: string; content?: string; activeForm?: string }>).find((t) => t.status === "in_progress") : undefined;
      return doing ? `☑ ${doing.activeForm ?? doing.content ?? ""}` : "☑ plan";
    }
    default:
      return `⚙ ${name}`;
  }
}
