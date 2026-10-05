import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { byNewest, isBefore } from "./time.ts";
import type { Project } from "./project.ts";

/** What the agent wants the user to know about where its turn left the project. */
export const STATUSES = ["progress", "done", "blocked", "needs_input", "idle"] as const;
export type Status = (typeof STATUSES)[number];

/** Statuses that must reach the user promptly rather than wait for the stand-up. */
export const PUSH_STATUSES: readonly Status[] = ["done", "blocked", "needs_input", "idle"];

export const QuestionSchema = z.object({
  text: z.string().min(1),
  options: z.array(z.string()).default([]),
  /** The agent's own recommendation, so the user can reply "ok" and move on. */
  recommend: z.string().optional(),
});

export const UsageSchema = z.object({
  costUsd: z.number().nonnegative().optional(),
  model: z.string().optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
});

export const ReportSchema = z.object({
  schema: z.literal(1).default(1),
  agent: z.string().min(1),
  host: z.enum(["claude-code", "codex", "other"]).default("other"),
  at: z.iso.datetime({ offset: true }),
  status: z.enum(STATUSES),
  done: z.array(z.string()).default([]),
  doing: z.array(z.string()).default([]),
  blocked: z.array(z.string()).default([]),
  next: z.array(z.string()).default([]),
  /** Things learned this turn worth remembering: research results, constraints, surprises. */
  findings: z.array(z.string()).default([]),
  /** Choices the agent made within its own remit. Also appended to decisions.md. */
  decisions: z.array(z.string()).default([]),
  question: QuestionSchema.nullable().default(null),
  /** Filled in by Leftoff, not by the agent. */
  commits: z.array(z.string()).default([]),
  filesChanged: z.number().int().nonnegative().optional(),
  usage: UsageSchema.optional(),
  sessionId: z.string().optional(),
  /** Paseo agent id, so the PM can reach this exact agent with `paseo send`. */
  paseoAgent: z.string().optional(),
  /** Branch the agent worked on, when not the main checkout's. */
  branch: z.string().optional(),
  /** Absolute path of the linked worktree the agent worked in, if any. */
  worktree: z.string().optional(),
});

export type ReportData = z.infer<typeof ReportSchema>;

export interface Report extends ReportData {
  /** Path the report was read from, relative to the repo root. */
  file: string;
  /** Free-text Markdown after the frontmatter. */
  body: string;
}

/**
 * The local calendar day of a timestamp — the day the owner lived it. The
 * filename's HH:MM is local time too, so a report at 00:11 lands in the right
 * day's folder rather than in yesterday's UTC one.
 */
export function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeSlug(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Write a report under `.leftoff/reports/<day>/<hhmm>-<agent>.md`, adding a
 * numeric suffix rather than overwriting when an agent reports twice in a minute.
 */
export async function writeReport(project: Project, data: ReportData, body = ""): Promise<string> {
  const day = dayOf(data.at);
  const dir = project.paths.reportsDay(day);
  await mkdir(dir, { recursive: true });
  const base = `${timeSlug(data.at)}-${data.agent}`;
  const taken = new Set(await readdir(dir).catch(() => [] as string[]));
  let name = `${base}.md`;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}.md`;
  const file = join(dir, name);
  await writeFile(file, stringifyFrontmatter(data, body), "utf8");
  return file;
}

async function readReportFile(repoRoot: string, file: string): Promise<Report | null> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  const { data, body } = parseFrontmatter(raw);
  const parsed = ReportSchema.safeParse(data);
  if (!parsed.success) return null;
  return { ...parsed.data, body: body.trim(), file: file.slice(repoRoot.length + 1) };
}

export interface ReadReportsOptions {
  /** Only reports at or after this ISO timestamp. */
  since?: string;
  /** Keep only the newest N, after filtering. */
  limit?: number;
  agent?: string;
}

/** All reports in a project, newest first. Malformed files are skipped, not fatal. */
export async function readReports(
  project: Project,
  options: ReadReportsOptions = {},
): Promise<Report[]> {
  const days = (await readdir(project.paths.reports).catch(() => [] as string[]))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();

  const reports: Report[] = [];
  for (const day of days) {
    if (options.since && day < dayOf(options.since)) break;
    const dir = project.paths.reportsDay(day);
    const files = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();
    for (const f of files) {
      const report = await readReportFile(project.root, join(dir, f));
      if (!report) continue;
      if (options.since && isBefore(report.at, options.since)) continue;
      if (options.agent && report.agent !== options.agent) continue;
      reports.push(report);
    }
    if (options.limit && reports.length >= options.limit && !options.since) break;
  }
  reports.sort(byNewest);
  return options.limit ? reports.slice(0, options.limit) : reports;
}

export async function latestReport(project: Project, agent?: string): Promise<Report | undefined> {
  const opts: ReadReportsOptions = { limit: 1 };
  if (agent) opts.agent = agent;
  const [report] = await readReports(project, opts);
  return report;
}

/** The newest report per agent, so the PM can describe the whole team at once. */
/**
 * Every commit already attributed to some earlier report. Reports are the record
 * of who did what, so a commit must appear in exactly one of them.
 */
export async function claimedCommits(project: Project, agent?: string): Promise<Set<string>> {
  const opts: ReadReportsOptions = { limit: 100 };
  if (agent) opts.agent = agent;
  const claimed = new Set<string>();
  for (const report of await readReports(project, opts)) {
    for (const sha of report.commits) claimed.add(sha);
  }
  return claimed;
}

export async function latestPerAgent(project: Project): Promise<Map<string, Report>> {
  const reports = await readReports(project, { limit: 200 });
  const byAgent = new Map<string, Report>();
  for (const r of reports) if (!byAgent.has(r.agent)) byAgent.set(r.agent, r);
  return byAgent;
}
