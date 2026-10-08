import { findPaseoAgent, listPaseoAgents, type ExecFn } from "../agents/delivery.ts";
import type { Config } from "../core/config.ts";
import { readDecisions } from "../core/decisions.ts";
import type { Project } from "../core/project.ts";
import type { Report, Status } from "../core/report.ts";
import { buildSnapshot, type Snapshot } from "../core/snapshot.ts";
import { agentName } from "../hub/messages.ts";
import { redact } from "../hub/redact.ts";
import type { Lang } from "../i18n/index.ts";
import { isMuted, type HubState } from "../hub/state.ts";
import { watchedProjects } from "../hub/watcher.ts";
import { claudeWindows } from "../limits/claude.ts";
import { readCodexLimits } from "../limits/codex.ts";
import type { LimitWindow } from "../limits/types.ts";
import { spentThisMonth } from "../pm/ledger.ts";
import { buildBoard, type Board } from "./board.ts";

/** What the browser is given. Plain data: the page renders it, it never computes status itself. */
export type Live = "running" | "idle" | "closed" | "unknown";

export interface WebAgent {
  id: string;
  name: string;
  host: string;
  /** How the PM reaches it: live through Paseo, or only by inbox. */
  control: "paseo" | "inbox";
  live: Live;
  status: Status | "none";
  lastAt: string | null;
  /** One line: what it last said it was doing, or had done. */
  summary: string;
  unreportedCommits: number;
  pendingInbox: number;
  /** The PM sent it something and is waiting for the answer. */
  awaiting: boolean;
  branch: string | null;
}

export interface Ask {
  projectId: string;
  projectName: string;
  agent: string;
  status: "blocked" | "needs_input";
  text: string;
  options: string[];
  recommend: string | null;
  at: string;
}

export interface WebProject {
  id: string;
  name: string;
  purpose: string;
  headline: Status | "quiet";
  lastActivityAt: string | null;
  agents: WebAgent[];
  counts: { todo: number; doing: number; blocked: number; done: number };
  branch: string;
  dirtyFiles: number;
  mutedUntil: string | null;
  costUsd: number;
  hasBacklog: boolean;
}

export interface Overview {
  generatedAt: string;
  language: Lang;
  timezone: string;
  channel: string;
  quietHours: boolean;
  /** What the PM pushes to chat on its own; the panel shows everything regardless. */
  notifyLevel: "critical" | "normal" | "all";
  pm: { spentUsd: number; budgetUsd: number };
  limits: Array<Pick<LimitWindow, "id" | "product" | "label" | "account" | "usedPercent" | "resetsAt" | "reached" | "observedAt">>;
  asks: Ask[];
  projects: WebProject[];
}

export interface TimelineReport {
  file: string;
  at: string;
  agent: string;
  status: Status;
  branch: string | null;
  done: string[];
  doing: string[];
  blocked: string[];
  next: string[];
  findings: string[];
  decisions: string[];
  question: Report["question"];
  commits: string[];
  body: string;
}

export interface ProjectDetail {
  generatedAt: string;
  project: WebProject;
  board: Board;
  reports: TimelineReport[];
  decisions: Array<{ at: string; by: string; text: string }>;
  commits: Array<{ sha: string; at: string; author: string; subject: string }>;
  asks: Ask[];
  /** The PM's draft instruction waiting for the owner's «sì» in this project's web thread. */
  draft: { agent: string; summary: string; prompt: string; expiresAt: string; /** Set for a teammate's handoff. */ from?: string } | null;
}

export interface DataSources {
  config: Config;
  state: () => HubState;
  exec?: ExecFn;
  now?: () => Date;
}

/**
 * Agents paste what they should not into reports, and decisions and drafts quote them: every
 * string that leaves for the browser is redacted, as the feed's already are. Deep, so a field added
 * to a view tomorrow is covered without anyone remembering to.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}

/** The same urgency order the snapshot uses for a project's headline. */
const URGENCY: ReadonlyArray<Status> = ["blocked", "needs_input", "idle", "done", "progress"];

/** Cheap short-lived memo, so a few open tabs polling do not each shell out to git and Paseo. */
function memo<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | undefined;
  return () => {
    if (!value || Date.now() - at > ttlMs) {
      at = Date.now();
      value = load().catch((error) => {
        value = undefined;
        throw error;
      });
    }
    return value;
  };
}

export class Data {
  readonly #src: DataSources;
  readonly #live = memo(8_000, async () => listPaseoAgents(this.#src.exec));
  readonly #windows = memo(30_000, async () => this.#loadWindows());
  /** `<project>:<agent>` → the workspace name, so a draft can be shown with the owner's own words. */
  readonly #labels = new Map<string, string>();
  readonly #snapshots = new Map<string, { at: number; value: Promise<Snapshot> }>();

  constructor(sources: DataSources) {
    this.#src = sources;
  }

  /** Never private: that word means "no output anywhere", and a browser is somewhere. */
  async projects(): Promise<Project[]> {
    return (await watchedProjects()).filter((p) => p.config.visibility !== "private");
  }

  async project(id: string): Promise<Project | undefined> {
    return (await this.projects()).find((p) => p.id === id);
  }

  async #snapshot(project: Project): Promise<Snapshot> {
    const hit = this.#snapshots.get(project.root);
    if (hit && Date.now() - hit.at < 5_000) return hit.value;
    const value = buildSnapshot(project, 14);
    this.#snapshots.set(project.root, { at: Date.now(), value });
    value.catch(() => this.#snapshots.delete(project.root));
    return value;
  }

  async #loadWindows(): Promise<LimitWindow[]> {
    const { limits, language } = this.#src.config;
    if (!limits.enabled) return [];
    const windows: LimitWindow[] = [];
    if (limits.codex) windows.push(...(await readCodexLimits({ language }).catch(() => [])));
    if (limits.claude) windows.push(...(await claudeWindows({ all: true }).catch(() => [])));
    return windows;
  }

  /**
   * Agents that reported a question or blocker and are working again now. The report was written at the
   * end of a turn, so a session that is running has started a new one: someone answered, usually the
   * owner in Paseo itself, which Leftoff does not hear. Until the agent reports again, "needs you" would
   * be a stale alarm.
   */
  async #resumed(project: Project, snapshot: Snapshot): Promise<Set<string>> {
    const live = await this.#live();
    const out = new Set<string>();
    for (const a of snapshot.agents) {
      if (a.last?.status !== "blocked" && a.last?.status !== "needs_input") continue;
      const link = project.config.agents.find((d) => d.id === a.id)?.paseoAgent;
      if (link && findPaseoAgent(live, link)?.status === "running") out.add(a.id);
    }
    return out;
  }

  async #webProject(project: Project, snapshot: Snapshot, board: Board, resumed: ReadonlySet<string> = new Set()): Promise<WebProject> {
    const state = this.#src.state();
    const now = (this.#src.now ?? (() => new Date()))();
    const live = await this.#live();
    const agents: WebAgent[] = snapshot.agents.filter((a) => !a.retired).map((a) => {
      const declared = project.config.agents.find((d) => d.id === a.id);
      const paseo = declared?.paseoAgent ? findPaseoAgent(live, declared.paseoAgent) : undefined;
      const last = a.last;
      if (declared?.label) this.#labels.set(`${project.id}:${a.id}`, declared.label);
      return {
        id: a.id,
        name: declared?.label ?? agentName(a.id),
        host: a.host,
        control: a.control,
        live: !declared?.paseoAgent ? "unknown" : !paseo ? "unknown" : paseo.status === "running" ? "running" : paseo.status === "closed" ? "closed" : "idle",
        status: resumed.has(a.id) ? "progress" : (last?.status ?? "none"),
        lastAt: last?.at ?? null,
        summary: last ? (last.doing[0] ?? last.blocked[0] ?? last.done[0] ?? last.next[0] ?? "") : "",
        unreportedCommits: a.unreportedCommits.length,
        pendingInbox: a.pendingInbox.length,
        awaiting: state.awaiting[`${project.id}:${a.id}`] !== undefined,
        branch: last?.branch ?? null,
      };
    });
    const until = state.mutes[project.id];
    return {
      id: project.id,
      name: project.config.name,
      purpose: project.config.purpose,
      headline: resumed.size ? (URGENCY.find((s) => agents.some((x) => x.status === s)) ?? "quiet") : snapshot.headline,
      lastActivityAt: snapshot.lastActivityAt ?? null,
      agents,
      counts: { todo: board.todo.length, doing: board.doing.length, blocked: board.blocked.length, done: board.doneTotal },
      branch: snapshot.git.branch,
      dirtyFiles: snapshot.git.dirtyFiles,
      mutedUntil: isMuted(state, project.id, now) && until ? until : null,
      costUsd: snapshot.costUsd,
      hasBacklog: snapshot.tasks.todo.length + snapshot.tasks.doing.length + snapshot.tasks.done.length > 0,
    };
  }

  #asks(project: Project, snapshot: Snapshot, resumed: ReadonlySet<string> = new Set()): Ask[] {
    const asks: Ask[] = [];
    for (const a of snapshot.agents) {
      if (resumed.has(a.id) || a.retired) continue;
      const r = a.last;
      if (!r || (r.status !== "blocked" && r.status !== "needs_input")) continue;
      asks.push({
        projectId: project.id,
        projectName: project.config.name,
        agent: a.id,
        status: r.status,
        text: r.question?.text ?? r.blocked[0] ?? r.next[0] ?? "",
        options: r.question?.options ?? [],
        recommend: r.question?.recommend ?? null,
        at: r.at,
      });
    }
    return asks;
  }

  async overview(): Promise<Overview> {
    const { config } = this.#src;
    const projects: WebProject[] = [];
    const asks: Ask[] = [];
    for (const project of await this.projects()) {
      try {
        const snapshot = await this.#snapshot(project);
        const resumed = await this.#resumed(project, snapshot);
        projects.push(await this.#webProject(project, snapshot, buildBoard(snapshot, new Date(), resumed), resumed));
        asks.push(...this.#asks(project, snapshot, resumed));
      } catch {
        // One broken repository must not blank the whole panel.
      }
    }
    // Waiting on the owner longest first; then by recency of activity.
    asks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const rank = (p: WebProject) => (p.headline === "blocked" || p.headline === "needs_input" ? 0 : p.agents.some((a) => a.live === "running") ? 1 : 2);
    projects.sort((a, b) => rank(a) - rank(b) || Date.parse(b.lastActivityAt ?? "0") - Date.parse(a.lastActivityAt ?? "0"));
    return redactDeep({
      generatedAt: new Date().toISOString(),
      language: config.language,
      timezone: config.timezone,
      channel: config.channel,
      quietHours: this.#src.state().quietHoursEnabled ?? config.notify.quietHours.enabled,
      notifyLevel: this.#src.state().notifyLevel ?? config.notify.level,
      pm: { spentUsd: await spentThisMonth().catch(() => 0), budgetUsd: config.pm.budget.monthlyUsd },
      limits: (await this.#windows().catch(() => [])).map(({ id, product, label, account, usedPercent, resetsAt, reached, observedAt }) => ({ id, product, label, ...(account ? { account } : {}), usedPercent, resetsAt, reached, observedAt })),
      asks,
      projects,
    });
  }

  async detail(id: string): Promise<ProjectDetail | undefined> {
    const project = await this.project(id);
    if (!project) return undefined;
    const snapshot = await this.#snapshot(project);
    const resumed = await this.#resumed(project, snapshot);
    const board = buildBoard(snapshot, new Date(), resumed);
    return redactDeep({
      generatedAt: new Date().toISOString(),
      project: await this.#webProject(project, snapshot, board, resumed),
      board,
      reports: snapshot.reports.slice(0, 40).map((r) => ({
        file: r.file, at: r.at, agent: r.agent, status: r.status, branch: r.branch ?? null,
        done: r.done, doing: r.doing, blocked: r.blocked, next: r.next, findings: r.findings, decisions: r.decisions,
        question: r.question, commits: r.commits, body: r.body,
      })),
      decisions: parseDecisions(await readDecisions(project)).slice(-25).reverse(),
      commits: snapshot.commits.slice(0, 30).map((c) => ({ sha: c.shortSha, at: c.at, author: c.author, subject: c.subject })),
      asks: this.#asks(project, snapshot, resumed),
      draft: this.draft(project.id),
    });
  }

  /**
   * What «sì» would send from this web thread: the instruction the PM drafted here, or else the
   * teammate's handoff shown in the project's thread (D-036), which the panel approves the same way.
   */
  draft(projectId: string | null): ProjectDetail["draft"] {
    const name = (id: string) => this.#labels.get(`${projectId ?? ""}:${id}`) ?? agentName(id);
    const now = Date.now();
    const draft = this.#src.state().proposals[`web-${projectId ?? "general"}`];
    if (draft && Date.parse(draft.expiresAt) > now) {
      return redactDeep({ agent: name(draft.agentId), summary: draft.summary, prompt: draft.prompt, expiresAt: draft.expiresAt });
    }
    const handoff = projectId ? (this.#src.state().handoffs ?? []).find((h) => h.projectId === projectId && h.expiresAt && Date.parse(h.expiresAt) > now) : undefined;
    return handoff
      ? redactDeep({ agent: name(handoff.to), summary: `🤝 ${name(handoff.from)} → ${name(handoff.to)}: ${handoff.ask}`, prompt: handoff.prompt, expiresAt: handoff.expiresAt!, from: name(handoff.from) })
      : null;
  }
}

/** `decisions.md`: `## 2026-10-02 07:03 — agent` then the text, then indented context. */
export function parseDecisions(markdown: string): Array<{ at: string; by: string; text: string }> {
  const out: Array<{ at: string; by: string; text: string }> = [];
  for (const block of markdown.split(/^## /m).slice(1)) {
    const [head = "", ...rest] = block.split("\n");
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (\w+)/.exec(head.trim());
    if (!m) continue;
    // Only the decision itself: the indented lines under it are context for the file's reader.
    const text = rest.filter((l) => l.trim() && !/^\s/.test(l)).join(" ").trim();
    if (text) out.push({ at: m[1]!, by: m[2]!, text });
  }
  return out;
}
