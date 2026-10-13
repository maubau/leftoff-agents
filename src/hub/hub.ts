import type { ActivityMeta, Channel, IncomingMessage, SendOptions } from "../channels/channel.ts";
import type { Config, NotifyLevel } from "../core/config.ts";
import { loadProject, saveProject, tryResolveProject, type Project } from "../core/project.ts";
import { latestReport, readReports, type Report } from "../core/report.ts";
import { buildSnapshot } from "../core/snapshot.ts";
import { recordSpend, spentSince } from "../pm/ledger.ts";
import { askPm } from "../pm/pm.ts";
import { createTasksAction, removeTasksAction } from "../pm/tasks.ts";
import type { ModelProvider } from "../pm/provider.ts";
import { askLive, deliverToAgent, deliverToSession, findPaseoAgent, listPaseoAgents, reachability, sendViaPaseo, type Delivery, type ExecFn } from "../agents/delivery.ts";
import { enqueue, markDelivered, pending } from "../core/inbox.ts";
import { recordDecision } from "../core/decisions.ts";
import { turnEndedAt } from "../core/now.ts";
import { isApproval, isCancellation } from "./approval.ts";
import { NAME_MAX, NewProjectError, STEPS } from "../commands/new-project.ts";
import type { ProjectJobs } from "./project-jobs.ts";
import { claudeWindows } from "../limits/claude.ts";
import { readCodexLimits } from "../limits/codex.ts";
import { evaluateLimits, isClaude } from "../limits/evaluate.ts";
import { alertLevel, canonicalCommand, languageOptions, OFF, ON, VOICE_MODES } from "../i18n/commands.ts";
import { LANGUAGES, LOCALES, messages, parseLanguage, type Lang, type Messages } from "../i18n/index.ts";
import { limitsSummary } from "../limits/format.ts";
import type { LimitAlert, LimitWindow, StoppedAgent } from "../limits/types.ts";
import { spokenText } from "../voice/spoken.ts";
import type { Synthesizer } from "../voice/synthesizer.ts";
import type { Transcriber } from "../voice/transcriber.ts";
import { remember, recentTurns } from "./chat-memory.ts";
import { inQuietHours, localParts, standupDue } from "./clock.ts";
import { discoverAgents } from "../agents/discovery.ts";
import { badgeName, displayName, findAgentByName, findTeammate } from "../core/agents.ts";
import { draftMessage, handoffMessage, planMessage, reportMessage, sentMessage, standupMessage, unreportedMessage } from "./messages.ts";
import { createTask, dropProposedTask, readTasks, updateTask } from "../core/backlog.ts";
import { AUTO, PROPOSED, missing, newPlanId, phasesOf, planLabel, planTasks, type Plan } from "../core/plan.ts";
import { redact } from "./redact.ts";
import { looksIrreversible } from "./autonomy.ts";
import { emptyState, isMuted, loadState, projectMode, saveState, type HubState, type PendingHandoff, type ProjectMode, type Proposal, type QueuedDelivery, type ResumeTarget, type AgentDraft } from "./state.ts";
import { acknowledge, scan, watchedProjects, type HubEvent } from "./watcher.ts";
import { projectOffice } from "../office/model.ts";
import { officePng } from "../office/render.ts";

/** What the hub needs to add an agent from chat: the panel's own way (its Settings), so both make the same agent. */
export interface AgentMaker {
  newAgentOptions(): Promise<{ providers: Array<{ id: string; label: string }> }>;
  createAgent(project: Project, input: { name?: unknown; role?: unknown; provider?: unknown }): Promise<{ agent: { label: string } }>;
}

/** The longest a choice's reply may be: Telegram carries at most 64 bytes, and the channel adds «say:». */
const CHOICE_BYTES = 60;

/** Statuses worth waking the owner for after quiet hours; the rest wait for the stand-up. */
const URGENT = new Set(["blocked", "needs_input"]);
/** How many held messages a summary names by their first line; the rest are counted. */
const DIGEST_LINES = 6;
/** Providers can take a moment to reopen a window; never wake an agent at the exact boundary. */
const RESET_GRACE_MS = 60_000;

export interface HubOptions {
  config: Config;
  channel: Channel;
  provider?: ModelProvider;
  transcriber?: Transcriber;
  synthesizer?: Synthesizer;
  /** Runs `paseo`; replaced in tests. */
  exec?: ExecFn;
  /** Told each time the PM writes to an agent, for the panel's office. Private projects included: the listener filters. */
  onContact?: (contact: Contact) => void;
  log?: (line: string) => void;
  /** The time, in ms, for chat's burst cap and its summaries (D-052): one clock for both. Tests set it. */
  clock?: () => number;
}

/** The PM wrote to an agent: a status question, an instruction (restarts too), or a teammate's handoff. */
export interface Contact {
  project: string;
  agent: string;
  kind: "status" | "command" | "handoff";
}

export class Hub {
  readonly #config: Config;
  readonly #channel: Channel;
  readonly #provider: ModelProvider | undefined;
  readonly #transcriber: Transcriber | undefined;
  readonly #synthesizer: Synthesizer | undefined;
  readonly #exec: ExecFn | undefined;
  readonly #onContact: ((contact: Contact) => void) | undefined;
  readonly #log: (line: string) => void;
  #state: HubState = emptyState();
  #timer: NodeJS.Timeout | undefined;
  #deliveryTimer: NodeJS.Timeout | undefined;
  #flushing = false;
  #ticking = false;
  /** When the PM last spoke on its own in each thread ("" is the general one), and what waits for a summary (D-052). */
  readonly #pushes = new Map<string, number[]>();
  #projects: ProjectJobs | undefined;
  #agents: AgentMaker | undefined;
  readonly #clock: () => number;
  readonly #digests = new Map<string, { projectId: string | null; texts: string[]; since: number }>();

  constructor(options: HubOptions) {
    this.#config = options.config;
    this.#channel = options.channel;
    this.#provider = options.provider;
    this.#transcriber = options.transcriber;
    this.#synthesizer = options.synthesizer;
    this.#clock = options.clock ?? Date.now;
    this.#exec = options.exec;
    this.#onContact = options.onContact;
    this.#log = options.log ?? ((line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  }

  /** A listener that fails must not cost the delivery it is told about. */
  #contact(project: string, agent: string, kind: Contact["kind"]): void {
    try {
      this.#onContact?.({ project, agent, kind });
    } catch (error) {
      this.#log(`contact listener failed: ${(error as Error).message}`);
    }
  }

  /** Control or autonomous (D-041). */
  projectMode(projectId: string): ProjectMode {
    return projectMode(this.#state, projectId);
  }

  /**
   * The owner set a project's mode: from the panel, or by saying yes to it in chat. Recorded in the
   * project's decisions; from the panel it is also said in the project's thread, so chat knows.
   */
  /** New projects (D-056): made by the same jobs as the panel's, once the hub has its state. */
  attachProjects(jobs: ProjectJobs): void {
    this.#projects = jobs;
  }

  /** Agents added from chat (D-056), made by the panel's own code. */
  attachAgents(maker: AgentMaker): void {
    this.#agents = maker;
  }

  async setProjectMode(projectId: string, mode: ProjectMode, by: "panel" | "chat"): Promise<boolean> {
    const project = (await this.#chatProjects()).find((p) => p.id === projectId);
    if (!project) return false;
    if (mode === "autonomous") this.#state.modes[projectId] = "autonomous";
    else delete this.#state.modes[projectId];
    for (const [key, ask] of Object.entries(this.#state.modeRequests)) if (ask.projectId === projectId) delete this.#state.modeRequests[key];
    await saveState(this.#state);
    await recordDecision(project, { at: new Date().toISOString(), by: "user", text: this.#m.modes.decision(mode), why: by === "panel" ? "control panel" : "chat" }).catch((e: Error) =>
      this.#log(`could not record the mode: ${e.message}`),
    );
    this.#log(`${projectId} is now ${mode}, from the ${by}`);
    if (by === "panel") await this.#send(projectId, this.#m.modes.changed(project.config.name, mode));
    return true;
  }

  get state(): HubState {
    return this.#state;
  }

  /** The owner's language: what /lingua last set, else the configured default. */
  get #lang(): Lang {
    return this.#state.language ?? this.#config.language;
  }

  get #m(): Messages {
    return messages(this.#lang);
  }

  /** How much of its own initiative the PM may push to chat: what /avvisi last set, else the config. */
  #level(): NotifyLevel {
    return this.#state.notifyLevel ?? this.#config.notify.level;
  }

  /** Is an event that needs at least `need` worth a message at the current level? */
  #wants(need: NotifyLevel): boolean {
    const rank = { critical: 0, normal: 1, all: 2 } as const;
    return rank[this.#level()] >= rank[need];
  }

  /** Held back from the chat: the control panel still shows it, marked as not sent. */
  async #hold(projectId: string | null, text: string): Promise<void> {
    await this.#channel.note?.(projectId, redact(text)).catch((e: Error) => this.#log(`note failed: ${e.message}`));
  }

  /**
   * A step between the PM and the agents (D-052): the activity register, never the chat and never Telegram, whatever
   * the level, the mute or the hour. Recorded for what was *done*, which autonomy does not change. Never for a private project.
   */
  async #activity(project: Project, text: string, meta: ActivityMeta): Promise<void> {
    if (!this.#chatVisible(project)) return;
    await this.#channel.activity?.(project.id, redact(text), meta).catch((e: Error) => this.#log(`activity failed: ${e.message}`));
  }

  async start(): Promise<void> {
    this.#state = (await loadState()) ?? emptyState();
    // Targets armed before the session was recorded: pin them to today's link, the best evidence left.
    for (const target of this.#state.resumeTargets) {
      if (target.paseoAgent) continue;
      Object.assign(target, await this.#withIdentity(target));
    }
    const projects = await this.#chatProjects();
    await this.#channel.ensureThreads?.(projects.map((p) => ({ id: p.id, name: p.config.name })));
    await this.#channel.start((message) => this.handle(message));
    await this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#config.notify.pollSeconds * 1000);
    // Queued messages go out soon after the agent's turn ends, not up to a whole poll later (D-042).
    // Between passes it asks Paseo only when a hook says a queued agent's turn ended (D-055): `paseo ls` costs a second.
    this.#deliveryTimer = setInterval(() => void this.flushDeliveries(new Date(), { whenTurnEnded: true }).catch((e: Error) => this.#log(`delivery queue error: ${e.message}`)), 15_000);
    this.#log(`hub up: ${projects.length} project(s), polling every ${this.#config.notify.pollSeconds}s`);
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    clearInterval(this.#deliveryTimer);
    await this.#channel.stop();
    await saveState(this.#state);
  }

  /** Projects that may appear in chat: never the private ones. */
  async #chatProjects(): Promise<Project[]> {
    return (await watchedProjects()).filter((p) => p.config.visibility !== "private");
  }

  /**
   * What the PM says in chat on its own. A safety net (D-052): past `notify.burst.max` in a thread within the window, the
   * rest wait to go out together as one summary; the panel shows each at once. What asks for a «sì» always goes out.
   */
  async #send(projectId: string | null, text: string, options?: SendOptions, capped = !options?.choices): Promise<void> {
    const thread = projectId ?? "";
    const now = this.#clock();
    // Only what asks for the owner's «sì» (a draft's Yes/No) passes the cap; an agent's options are news like any other.
    if (capped) {
      const { max, minutes } = this.#config.notify.burst;
      const recent = (this.#pushes.get(thread) ?? []).filter((t) => now - t < minutes * 60_000);
      this.#pushes.set(thread, recent);
      const held = this.#digests.get(thread);
      // Once some are held, the next ones join them: the summary keeps the order things happened in.
      if (held || recent.length >= max) {
        if (held) held.texts.push(text);
        else this.#digests.set(thread, { projectId, texts: [text], since: now });
        await this.#hold(projectId, text);
        return;
      }
    }
    await this.#channel.send(projectId, redact(text), options);
    this.#pushes.set(thread, [...(this.#pushes.get(thread) ?? []), now]);
  }

  /** The held messages of a thread whose window has passed go out as one, with the first line of each. */
  async #flushDigests(): Promise<void> {
    if (!this.#digests.size) return;
    // The same clock #send stamps with, read now — not the start of the pass, which may be seconds earlier.
    const now = this.#clock();
    const window = this.#config.notify.burst.minutes * 60_000;
    const visible = await this.#chatProjects();
    for (const [thread, digest] of [...this.#digests]) {
      if (now - digest.since < window) continue;
      this.#digests.delete(thread);
      const project = digest.projectId === null ? null : visible.find((p) => p.id === digest.projectId);
      // Turned private, or gone, while its messages waited: chat says nothing about it.
      if (project === undefined) continue;
      const lines = digest.texts.slice(0, DIGEST_LINES).map((t) => {
        const line = t.split("\n").find((l) => l.trim())?.trim() ?? "";
        return line.length > 100 ? `${line.slice(0, 99)}…` : line;
      });
      await this.#channel.send(digest.projectId, redact(this.#m.activity.digest(digest.texts.length, project?.config.name ?? null, lines)));
      this.#pushes.set(thread, [now]);
    }
  }

  /** The buttons under anything «sì» would send: tapping one says the word for the owner. */
  #choices(): SendOptions {
    const m = this.#m.delivery;
    return { choices: [{ label: m.choiceSend, reply: m.yesWord }, { label: m.choiceDrop, reply: m.noWord }] };
  }

  /** One pass: events, the quiet-hours queue, the stand-up. Never overlaps itself. */
  async tick(now = new Date()): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const { config } = { config: this.#config };
      const projects = await this.#chatProjects();
      this.#housekeeping(now);
      // Agents Paseo runs in a project's workspaces are listed from the start, not after their first report.
      await this.#discover().catch((e: Error) => this.#log(`agent discovery error: ${e.message}`));
      const events = await scan(projects, this.#state, {
        now,
        unreportedAfterMinutes: config.notify.unreportedAfterMinutes,
        awaiting: this.#state.awaiting,
      });
      const quiet = this.#quietHoursEnabled() && inQuietHours(now, config.timezone, config.notify.quietHours);

      for (const event of events) {
        await this.#deliver(event, quiet, now);
        acknowledge(this.#state, event);
      }
      await this.flushDeliveries(now).catch((e: Error) => this.#log(`delivery queue error: ${e.message}`));
      await this.#catchUpInboxes(now, quiet, projects).catch((e: Error) => this.#log(`inbox catch-up error: ${e.message}`));
      await this.#checkPlans(now, quiet, projects).catch((e: Error) => this.#log(`plan check error: ${e.message}`));
      await this.#forwardHandoffs(now, quiet, projects).catch((e: Error) => this.#log(`handoff forwarding error: ${e.message}`));
      await this.#showHandoffs(now, quiet, projects).catch((e: Error) => this.#log(`handoff error: ${e.message}`));
      await this.#checkLimits(now, quiet);
      // Following the work is a courtesy on top of the rest: an error here must never cost the
      // owner the queue, the stand-up or the saved state of this pass.
      await this.#checkStale(now, projects).catch((e: Error) => this.#log(`status check error: ${e.message}`));

      if (!quiet && this.#state.queued.length) {
        // A project can turn private while its notice waits: look again at the moment of sending.
        const visibleNow = new Set((await this.#chatProjects()).map((p) => p.id));
        while (this.#state.queued[0]) {
          const item = this.#state.queued[0];
          // Everything the text reveals, including the project whose topic it is going to.
          const subjects = [...(item.about ?? []), ...(item.projectId ? [item.projectId] : [])];
          if (!subjects.some((id) => !visibleNow.has(id))) await this.#send(item.projectId, item.text);
          this.#state.queued.shift();
        }
      }
      if (!quiet) await this.#flushDigests().catch((e: Error) => this.#log(`summary error: ${e.message}`));
      if (!quiet && standupDue(now, config.timezone, config.notify.standupAt, this.#state.lastStandup)) {
        const standup = await this.standup(projects, now);
        await this.#send(null, standup);
        // The morning stand-up is the message most worth hearing; only when voice is "always".
        if (this.#speakMode() === "always") {
          const audio = await this.#speak(standup, null);
          if (audio) await this.#channel.sendVoice?.(null, audio).catch((e: Error) => this.#log(`voice stand-up failed: ${e.message}`));
        }
        this.#state.lastStandup = localParts(now, config.timezone).day;
      }
      await saveState(this.#state);
    } catch (error) {
      this.#log(`tick failed: ${(error as Error).message}`);
    } finally {
      this.#ticking = false;
    }
  }

  async #discover(): Promise<void> {
    for (const project of await watchedProjects()) {
      if (await discoverAgents(project)) this.#log(`registered the Paseo agents of ${project.id}`);
    }
  }

  /** Subscription windows: Codex from its session logs, Claude from the limit hook. */
  async #windows(): Promise<LimitWindow[]> {
    const { limits } = this.#config;
    if (!limits.enabled) return [];
    const windows: LimitWindow[] = [];
    if (limits.codex) windows.push(...(await readCodexLimits({ language: this.#lang }).catch(() => [])));
    if (limits.claude) {
      windows.push(...(await claudeWindows().catch(() => [])));
    }
    return windows;
  }

  async #checkLimits(now: Date, quiet: boolean): Promise<void> {
    const { limits, timezone } = this.#config;
    const language = this.#lang;
    if (!limits.enabled) return;
    const windows = await this.#windows();
    // Commit alert memory only after outbound delivery succeeds, so a transient
    // channel failure retries instead of silently consuming the notification.
    const nextMemory = structuredClone(this.#state.limits);
    const alerts = evaluateLimits(windows, nextMemory, {
      now: now.getTime(),
      warnAtPercent: limits.warnAtPercent,
      language,
      timezone,
    });

    // Reconcile on every reading, not on alerts: alerts are deduplicated per episode, so an
    // agent that stopped on the same limit after the first alert would otherwise be forgotten.
    const armedVisible = new Map<string, number>();
    for (const window of windows) {
      // A limit that has already lifted is not in force: a stale "reached" reading must arm nothing.
      if (!window.reached || (window.resetsAt !== null && window.resetsAt <= now.getTime())) continue;
      const count = await this.#armResume(window, now);
      if (count) armedVisible.set(window.id, (armedVisible.get(window.id) ?? 0) + count);
    }
    for (const alert of alerts) {
      if (alert.kind !== "back") continue;
      for (const target of this.#state.resumeTargets) {
        if (target.windowId === alert.windowId && target.resumeAt === null) target.resumeAt = now.getTime() + RESET_GRACE_MS;
      }
    }

    const resumed = await this.#resumeDue(now);
    const used = new Set<string>();
    for (const alert of alerts) {
      let text = alert.text;
      const about: string[] = [];
      const count = alert.kind === "reached" ? (armedVisible.get(alert.windowId) ?? 0) : 0;
      if (count > 0) {
        text += this.#m.hub.restartScheduled(count);
      }
      // A restart notice rides on the first alert of one of its windows, once.
      const mine = resumed.filter((r) => !used.has(r.key) && r.windowIds.includes(alert.windowId));
      for (const notice of mine) {
        used.add(notice.key);
        text += `\n${notice.text}`;
        about.push(notice.projectId);
      }
      // The restart itself already happened regardless of quiet hours; only the
      // owner-facing notification follows their current quiet-hours preference. A limit reached stops
      // work and is critical; a warning, or "available again", is not.
      if (!this.#wants(alert.kind === "reached" ? "critical" : "normal")) {
        await this.#hold(null, text);
        continue;
      }
      await this.#deliverLimit({ ...alert, text }, quiet, now, about);
    }
    // A persisted target can become due even if the host no longer exposes the
    // old window. Still wake it; the normal durable queue delivers its notice.
    for (const notice of resumed) {
      if (used.has(notice.key)) continue;
      // A session that could not be restarted stays stopped: that is critical. One that was asked to resume is news.
      if (!this.#wants(notice.critical ? "critical" : "normal")) {
        await this.#hold(null, notice.text);
        continue;
      }
      this.#state.queued.push({ projectId: null, text: notice.text, at: now.toISOString(), key: `resume:${notice.key}`, about: [notice.projectId] });
    }
    this.#state.limits = nextMemory;
  }

  /** Chat may mention a project only while it is not private — checked when it matters, not once. */
  #chatVisible(project: Project): boolean {
    return project.config.visibility !== "private";
  }

  /** The limit episode a window belongs to; a restart is owed once per episode and session. */
  #episode(window: LimitWindow): string {
    return isClaude(window.id) ? `${window.id}:${window.observedAt}` : `${window.id}:${window.resetsAt ?? "?"}`;
  }

  async #targetsForWindow(window: LimitWindow): Promise<StoppedAgent[]> {
    if (window.targets?.length) return window.targets;
    if (!window.source?.cwd || !window.id.startsWith("codex:")) return [];
    const project = await tryResolveProject(window.source.cwd);
    if (!project) return [];
    const reports = await readReports(project, { limit: 200 });
    const exact = window.source.sessionId ? reports.find((r) => r.sessionId === window.source?.sessionId) : undefined;
    if (exact) {
      return [
        {
          projectRoot: project.root,
          projectId: project.id,
          agentId: exact.agent,
          ...(exact.paseoAgent ? { paseoAgent: exact.paseoAgent } : {}),
          sessionId: window.source.sessionId!,
        },
      ];
    }
    const candidates = project.config.agents.filter((a) => a.host === "codex");
    const fallback = candidates.length === 1 ? candidates[0] : project.config.agents.find((a) => a.id === "codex");
    return fallback ? [{ projectRoot: project.root, projectId: project.id, agentId: fallback.id }] : [];
  }

  /**
   * Pin the stopped session. When nothing says which Paseo session it was, the link the
   * project has *right now* is the best evidence — and it is recorded now, at the moment
   * the limit is seen, because a later report from a different session can rebind it.
   */
  async #withIdentity(target: StoppedAgent): Promise<StoppedAgent> {
    if (target.paseoAgent) return target;
    const project = await loadProject(target.projectRoot).catch(() => null);
    const link = project?.config.agents.find((a) => a.id === target.agentId)?.paseoAgent;
    return link ? { ...target, paseoAgent: link } : target;
  }

  /** Arm the agents a limit stopped; returns how many *new, chat-visible* ones, for the owner's notice. */
  async #armResume(window: LimitWindow, now: Date): Promise<number> {
    const episode = this.#episode(window);
    let visible = 0;
    for (const raw of await this.#targetsForWindow(window)) {
      // Keyed by what the source reported, before any link is looked up (see ResumeTarget.serveKey).
      const serveKey = `${episode}|${raw.projectRoot}|${raw.agentId}|${raw.paseoAgent ?? ""}`;
      if (this.#state.resumeServed.includes(serveKey)) continue;
      if (this.#state.resumeTargets.some((item) => item.windowId === window.id && item.serveKey === serveKey)) continue;
      const target = await this.#withIdentity(raw);
      this.#state.resumeTargets.push({
        windowId: window.id,
        product: window.product,
        episode,
        serveKey,
        ...target,
        resumeAt: window.resetsAt === null ? null : window.resetsAt + RESET_GRACE_MS,
        armedAt: now.toISOString(),
      });
      const project = await loadProject(target.projectRoot).catch(() => null);
      if (project && this.#chatVisible(project)) visible++;
    }
    return visible;
  }

  /**
   * Wake the agents whose limits have all lifted. One agent can be blocked by several
   * windows at once (5 hours and the week): it restarts once, after the last of them —
   * a restart that cannot work is worse than a late one.
   */
  async #resumeDue(now: Date): Promise<Array<{ key: string; windowIds: string[]; projectId: string; text: string; critical: boolean }>> {
    const notices: Array<{ key: string; windowIds: string[]; projectId: string; text: string; critical: boolean }> = [];
    const groups = new Map<string, ResumeTarget[]>();
    for (const target of this.#state.resumeTargets) {
      const key = [target.product, target.projectRoot, target.agentId, target.paseoAgent ?? ""].join("|");
      groups.set(key, [...(groups.get(key) ?? []), target]);
    }
    const finished = new Set<ResumeTarget>();
    for (const [groupKey, group] of groups) {
      if (group.some((t) => t.resumeAt === null || t.resumeAt > now.getTime())) continue;
      const first = group[0]!;
      const m = this.#m.hub;
      try {
        const project = await loadProject(first.projectRoot).catch(() => null);
        for (const t of group) finished.add(t);
        if (!project) {
          this.#log(`automatic restart dropped: ${first.projectId} is gone`);
          continue;
        }
        const instruction = m.resumeInstruction(first.product);
        const delivery = await deliverToSession(project, first.agentId, instruction, first.paseoAgent ? { paseoAgent: first.paseoAgent } : {}, this.#exec);
        for (const t of group) {
          this.#state.resumeServed.push(t.serveKey ?? `${t.episode ?? "legacy"}|${t.projectRoot}|${t.agentId}|${t.paseoAgent ?? ""}`);
        }
        this.#state.resumeServed = this.#state.resumeServed.slice(-500);
        if (delivery.via !== "none") {
          this.#contact(project.id, first.agentId, "command");
          this.#state.awaiting[`${project.id}:${first.agentId}`] = now.toISOString();
          await recordDecision(project, {
            at: now.toISOString(),
            by: "pm",
            text: `${m.autoRestartDecision}: ${displayName(project, first.agentId)}`,
            why: `${first.product}; ${delivery.via}`,
          }).catch((e: Error) => this.#log(`could not record automatic restart: ${e.message}`));
        } else {
          this.#log(`automatic restart for ${project.id}/${first.agentId} not sent: ${delivery.reason}`);
        }
        // The action is done either way; whether chat may *hear* of it is decided now, with the
        // project's current visibility — private projects produce no chat output at all.
        if (!this.#chatVisible(project)) continue;
        const name = `${displayName(project, first.agentId)} (${project.config.name})`;
        const text = delivery.via === "none" ? m.restartUnreachable(name) : m.restartAsked(name, delivery.via === "inbox");
        notices.push({ key: groupKey, windowIds: group.map((t) => t.windowId), projectId: project.id, text, critical: delivery.via === "none" });
      } catch (error) {
        for (const t of group) finished.delete(t);
        this.#log(`automatic restart failed for ${first.projectId}/${first.agentId}: ${(error as Error).message}`);
      }
    }
    this.#state.resumeTargets = this.#state.resumeTargets.filter((t) => !finished.has(t));
    return notices;
  }

  /**
   * At night these wait for the morning — unless the story ended while the owner
   * slept: a "back" for a limit they were never told about is nothing to say.
   */
  async #deliverLimit(alert: LimitAlert, quiet: boolean, now: Date, about: string[] = []): Promise<void> {
    if (!quiet) {
      await this.#send(null, alert.text);
      this.#log(`sent limit ${alert.kind} for ${alert.windowId}`);
      return;
    }
    const prefix = `limit:${alert.windowId}:`;
    if (alert.kind === "back") {
      const before = this.#state.queued.length;
      this.#state.queued = this.#state.queued.filter((q) => !q.key?.startsWith(prefix));
      if (this.#state.queued.length !== before) return;
    }
    this.#state.queued.push({ projectId: null, text: alert.text, at: now.toISOString(), key: `${prefix}${alert.kind}`, ...(about.length ? { about } : {}) });
  }

  async #deliver(event: HubEvent, quiet: boolean, now: Date): Promise<void> {
    const lang = this.#lang;
    // Queued even while the project is muted: they wait for the owner, and are shown once it is not.
    if (event.kind === "report" && event.report.handoffs.length) await this.#queueHandoffs(event.project, event.report, now, quiet);
    if (event.kind === "unreported") {
      // Commits nobody reported are a step, not news: the register has them (D-052).
      await this.#activity(event.project, unreportedMessage(event.branch, event.commits, lang), { type: "commits" });
      return;
    }
    const { project, report } = event;
    let text = reportMessage(report, lang, badgeName(project, report.agent));
    const isReply = event.reply === true;
    const key = `${project.id}:${report.agent}`;
    const askedByHub = this.#state.statusAskedBy[key] === "auto";
    let between = false;
    let status = false;
    if (isReply) {
      // The answer to an instruction moves the task it carried out (D-051).
      const task = this.#state.taskOf[key];
      if (task) {
        delete this.#state.taskOf[key];
        const finished = report.status === "done" || report.status === "idle";
        const moved = await updateTask(project, task, { status: finished ? "Done" : "In Progress" }).catch((e: Error) => this.#log(`could not move ${task}: ${e.message}`));
        if (moved) await this.#activity(project, this.#m.activity.task(task, moved.title, finished ? "Done" : "In Progress"), { type: "task", agent: report.agent });
      }
      status = this.#state.statusAsked[key] !== undefined && this.#state.statusAsked[key] === this.#state.awaiting[key];
      const who = displayName(project, report.agent);
      const asker = this.#state.handoffReplies[key];
      delete this.#state.handoffReplies[key];
      const asked = this.#state.teamQuestions?.[key] !== undefined;
      if (asked) delete this.#state.teamQuestions[key];
      const head = asker ? this.#m.handoff.reply(who, displayName(project, asker)) : asked ? this.#m.hub.replyQuestion(who) : status ? this.#m.hub.replyStatus(who) : this.#m.hub.replyInstruction(who);
      text = `↩️ ${head}:\n${text}`;
      // A teammate's answer to a teammate, or to the PM's own automatic question, is a step between them.
      between = asker !== undefined || (status && askedByHub);
    }
    // Every report is in the register; chat has the dialogue and the closures only (D-052), at any level. Something that
    // needs the owner, or answers what they asked, is critical, and so is an instruction carried out; work an agent
    // finished on its own is news. A progress report, or an answer that is not the end of it, is a step.
    await this.#activity(project, text, { type: isReply ? "reply" : "report", agent: report.agent });
    const urgent = URGENT.has(report.status);
    const closes = report.status === "done" || report.status === "idle";
    const need: NotifyLevel | undefined = urgent ? "critical" : between ? undefined : isReply ? (status || closes ? "critical" : undefined) : closes ? "normal" : undefined;
    if (!need || isMuted(this.#state, project.id, now)) return;
    if (!this.#wants(need)) {
      // A closure the level keeps out of chat is still one: the panel's conversation has it, marked as not sent.
      await this.#hold(project.id, text);
      return;
    }
    if (quiet) {
      // Quiet hours: blockers and answers wait for the morning, everything else for the stand-up.
      if (urgent || isReply) this.#state.queued.push({ projectId: project.id, text, at: now.toISOString() });
      return;
    }
    await this.#send(project.id, text, optionChoices(report, displayName(project, report.agent)), true);
    this.#log(`sent report for ${project.id}`);
  }

  async standup(projects: readonly Project[], now = new Date()): Promise<string> {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
    const rows = [];
    let devUsd = 0;
    let devReported = false;
    const monthAgo = now.getTime() - 30 * 86_400_000;
    for (const project of projects) {
      const snapshot = await buildSnapshot(project, 30);
      const lastWeek = await readReports(project, { since: weekAgo });
      for (const r of lastWeek) {
        if (r.usage?.costUsd === undefined) continue;
        devUsd += r.usage.costUsd;
        devReported = true;
      }
      // A project quiet for a month that waits on nobody is not news; one with no
      // report yet is, so the owner sees it is followed but silent.
      const waiting = snapshot.agents.some((a) => a.last && ["blocked", "needs_input"].includes(a.last.status));
      if (snapshot.lastActivityAt && Date.parse(snapshot.lastActivityAt) < monthAgo && !waiting) continue;
      rows.push({ project, snapshot, reportsLastDay: lastWeek.filter((r) => r.at >= dayAgo).length });
    }
    const pmUsd = await spentSince(weekAgo);
    const text = standupMessage(rows, { devUsd: devReported ? devUsd : null, pmUsd }, now, this.#lang, this.#config.timezone);
    const limits = limitsSummary(await this.#windows(), now.getTime(), this.#lang);
    return limits ? `${text}\n${limits}` : text;
  }

  /** A message from the owner: a command, or a question for the PM. */
  async handle(message: IncomingMessage): Promise<void> {
    let text = message.text.trim();
    let fromVoice = false;
    if (message.audio) {
      const heard = await this.#hear(message);
      if (heard === null) return;
      text = heard;
      fromVoice = true;
    }
    const command = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
    if (command) {
      await this.#command(command[1] ?? "", command[2] ?? "", message);
      return;
    }

    const projects = await this.#chatProjects();
    const project = projects.find((p) => p.id === message.projectId);

    // A draft is waiting in this thread: the owner's own words decide its fate — matched
    // here, by a fixed list, never by the model. Anything else is a request for changes.
    const draft = this.#pendingDraft(message.threadKey);
    if (draft) {
      if (isApproval(text)) return this.#approve(draft, projects, message, fromVoice);
      if (isCancellation(text)) {
        delete this.#state.proposals[message.threadKey];
        await saveState(this.#state);
        await this.#answer(message, this.#m.hub.dropped, fromVoice);
        return;
      }
    }
    // A teammate's handoff shown in this project's thread is decided the same way, by the same words.
    const handoff = draft ? undefined : this.#shownHandoff(message.projectId);
    if (handoff) {
      if (isApproval(text)) return this.#approveHandoff(handoff, projects, message, fromVoice);
      if (isCancellation(text)) {
        this.#state.handoffs = this.#state.handoffs.filter((h) => h !== handoff);
        await saveState(this.#state);
        await this.#answer(message, this.#m.hub.dropped, fromVoice);
        return;
      }
    }

    // Turning autonomy on, asked in chat, waits for the same fixed words (D-041).
    const modeAsk = draft || handoff ? undefined : this.#pendingModeRequest(message.threadKey);
    if (modeAsk) {
      const asked = projects.find((p) => p.id === modeAsk.projectId);
      if (isApproval(text) && asked) {
        await this.setProjectMode(asked.id, "autonomous", "chat");
        await this.#answer(message, this.#m.modes.changed(asked.config.name, "autonomous"), fromVoice);
        return;
      }
      if (isCancellation(text)) {
        delete this.#state.modeRequests[message.threadKey];
        await saveState(this.#state);
        await this.#answer(message, this.#m.hub.dropped, fromVoice);
        return;
      }
    }

    // The consolidated plan shown in this thread is approved or sent back by the same fixed words (D-051).
    const shownPlan = draft || handoff || modeAsk ? undefined : this.#shownPlan(message.threadKey);
    if (shownPlan) {
      if (isApproval(text)) return this.#approvePlan(shownPlan, projects, message, fromVoice);
      if (isCancellation(text)) {
        shownPlan.status = "collecting";
        delete shownPlan.threadKey;
        delete shownPlan.expiresAt;
        await saveState(this.#state);
        await this.#answer(message, this.#m.plan.revise, fromVoice);
        return;
      }
    }

    // A new project shown in this thread is made only on the same fixed words (D-056), in every mode.
    const newProject = draft || handoff || modeAsk || shownPlan ? undefined : this.#pendingProjectDraft(message.threadKey);
    if (newProject) {
      if (isApproval(text)) return this.#createProject(newProject, message);
      if (isCancellation(text)) {
        delete this.#state.projectDrafts[message.threadKey];
        await saveState(this.#state);
        await this.#answer(message, this.#m.newProject.dropped, fromVoice);
        return;
      }
    }

    // An agent being added in this thread: each answer is the owner's, and only the fixed «sì» makes it (D-056).
    const agentDraft = draft || handoff || modeAsk || shownPlan || newProject ? undefined : this.#pendingAgentDraft(message.threadKey);
    if (agentDraft && (await this.#agentAnswer(agentDraft, text, projects, message, fromVoice))) return;

    await message.typing().catch(() => undefined);
    // What went out in an autonomous project during this turn: told to the owner even if the model fails afterwards.
    const sent: string[] = [];
    try {
      const history = await recentTurns(message.threadKey);
      let proposed: Proposal | undefined;
      let modeAsked: string | undefined;
      let planSubmitted: string | undefined;
      let projectAsked: { name: string; purpose: string; text: string } | undefined;
      const commands = this.#config.commands;
      const result = await askPm({
        question: text,
        config: this.#config,
        surface: "chat",
        history,
        ...(project ? { project: { id: project.id, name: project.config.name } } : {}),
        ...(this.#provider ? { provider: this.#provider } : {}),
        ...(fromVoice ? { fromVoice: true } : {}),
        notes: [
          draft
            ? `A draft for ${displayName(project ?? { config: { agents: [] } }, draft.agentId)} (${draft.projectId}) is waiting for the owner's approval: «${draft.prompt}». If the owner is asking for changes to it, call propose_agent_command again with the complete revised prompt.`
            : handoff && project
              ? `A handoff from ${displayName(project, handoff.from)} to ${displayName(project, handoff.to)} (agent id ${handoff.to}) is waiting for the owner's approval in this thread: «${handoff.prompt}». If the owner is asking for changes to it, call propose_agent_command for ${handoff.to} with the complete revised prompt; it replaces the handoff.`
              : "",
          this.#modeNote(projects, project),
        ]
          .filter(Boolean)
          .join("\n"),
        actions: {
          mute: async (projectId, hours) => this.#mute(projectId, hours),
          unmute: async (projectId) => {
            delete this.#state.mutes[projectId];
            await saveState(this.#state);
            return `${projectId} unmuted`;
          },
          askStatus: async (input) => this.#askStatus(projects, input, "pm"),
          askTeam: async (input) => this.#askTeam(projects, input),
          setRole: async (input) => this.#setRole(projects, input),
          createTasks: async (input) => createTasksAction(projects, input, { language: this.#lang }),
          removeTasks: async (input) => removeTasksAction(projects, input),
          ...(commands.enabled
            ? {
                proposeCommand: async (input) => {
                  const made = await this.#propose(input, projects);
                  // Autonomous (D-041): it goes out now, each one as it is written, exactly as the PM wrote it.
                  const target = made.autoSend && made.proposal ? projects.find((p) => p.id === made.proposal!.projectId) : undefined;
                  if (target && made.proposal) {
                    try {
                      const handoffFrom = this.#adoptShownHandoff(message.projectId, made.proposal.agentId);
                      const done = await this.#sendInstruction(target, { ...made.proposal, ...(handoffFrom ? { handoffFrom } : {}) }, "pm");
                      sent.push(done.text);
                      // What the PM tells the owner must be what happened: sent, queued behind a turn, or waiting.
                      if (done.delivery.via === "inbox") {
                        return { content: `Not sent yet: ${made.proposal.agentId} cannot be reached now (${done.delivery.reason}). It waits in its inbox and goes out as soon as its Paseo session is active again. Tell the owner it is waiting, not sent; the notice below says so.` };
                      }
                      if (done.delivery.queued) {
                        return { content: `${made.proposal.agentId} is working: the instruction goes out when its current turn ends, without interrupting it. Tell the owner it is queued; the notice below says so.` };
                      }
                      return made.outcome;
                    } catch (error) {
                      this.#log(`autonomous send failed: ${(error as Error).message}`);
                      proposed = made.proposal;
                      return { content: "Sending failed; it is shown to the owner as a draft instead, to send with a yes. Say so in one line." };
                    }
                  }
                  if (made.proposal) proposed = made.proposal;
                  return made.outcome;
                },
              }
            : {}),
          setMode: async (input) => {
            const made = await this.#modeChange(projects, input, Boolean(draft || handoff));
            if (made.ask) modeAsked = made.ask;
            return made.outcome;
          },
          ...(this.#projects
            ? {
                proposeProject: async (input) => {
                  // Never the PM's own idea (D-041), and never a second «sì» in one thread.
                  if (!input.ownerAsked) return { content: "Refused: a new project is made only when the owner asks for it. Do not propose it.", isError: true };
                  if (this.#approvableIn(message)) return { content: this.#m.newProject.busy, isError: true };
                  const made = await this.#projectDraft(input.name, input.purpose);
                  if (!made.ready) return { content: `It cannot be made: ${made.text} Tell the owner.`, isError: true };
                  projectAsked = { name: input.name, purpose: input.purpose, text: made.text };
                  return { content: "The owner is shown what will be made, with Yes and No, right after your reply. Say in one line what you propose; do not ask yourself." };
                },
              }
            : {}),
          requestPlans: async (input) => this.#requestPlans(projects, input),
          readPlan: async (input) => this.#readPlan(projects, input.project),
          revisePlanTask: async (input) => this.#revisePlanTask(projects, input),
          submitPlan: async (input) => {
            const made = await this.#submitPlan(projects, input, Boolean(draft || handoff || modeAsk));
            if (made.submitted) planSubmitted = made.submitted;
            return made.outcome;
          },
          dropPlan: async (input) => this.#dropPlan(projects, input.project),
        },
      });
      const sentNote = sent.join("\n");
      const waits = proposed;
      const block = waits ? [waits.hold ? this.#m.modes[waits.hold] : "", await this.#draftBlock(waits, projects)].filter(Boolean).join("\n\n") : "";
      // A mode question and a draft in one reply would make «sì» ambiguous: the draft wins.
      const modeQuestion = modeAsked && !waits ? projects.find((p) => p.id === modeAsked) : undefined;
      const question = modeQuestion ? this.#m.modes.confirm(modeQuestion.config.name) : "";
      // The plan is approvable only if nothing else waits for a «sì» in this reply.
      const planProject = planSubmitted && !waits && !modeQuestion ? projects.find((p) => p.id === planSubmitted) : undefined;
      const planBlock = planProject ? await this.#planBlock(planProject) : "";
      const projectBlock = projectAsked && !waits && !modeQuestion && !planBlock ? projectAsked.text : "";
      await message.reply(
        redact([result.text, sentNote, block, question, planBlock, projectBlock, ...result.notices].filter(Boolean).join("\n\n")),
        waits || modeQuestion || planBlock || projectBlock ? this.#choices() : undefined,
      );
      if (projectAsked && projectBlock) await this.#holdProjectDraft(message, projectAsked.name, projectAsked.purpose);
      if (planProject && planBlock) {
        const plan = this.#state.plans[planProject.id]!;
        plan.status = "shown";
        plan.threadKey = message.threadKey;
        plan.shownAt = new Date().toISOString();
        plan.expiresAt = new Date(Date.now() + this.#config.commands.proposalTtlMinutes * 60_000).toISOString();
        await saveState(this.#state);
      }
      // Only now is the draft approvable: the owner has been shown exactly this text. A model
      // failure above, or a reply that never went out, leaves nothing a stray «sì» could send.
      if (waits) await this.#commitDraft(message.threadKey, waits, message.projectId);
      if (modeQuestion) {
        this.#state.modeRequests[message.threadKey] = { projectId: modeQuestion.id, expiresAt: new Date(Date.now() + this.#config.commands.proposalTtlMinutes * 60_000).toISOString() };
        await saveState(this.#state);
      }
      // The text always goes first and always goes whole; the voice is the gist on top.
      if (!result.skipped && message.replyVoice && this.#shouldSpeak(fromVoice)) {
        const ask = waits || modeQuestion || planBlock ? this.#m.hub.sayYesToSend : "";
        const audio = await this.#speak(result.text + ask, message.projectId);
        if (audio) await message.replyVoice(audio).catch((e: Error) => this.#log(`voice reply failed: ${e.message}`));
      }
      if (!result.skipped) {
        await remember(message.threadKey, [
          { role: "user", text },
          {
            role: "assistant",
            text: waits ? `${result.text}\n${this.#m.hub.draftShownNote(waits.summary)}` : sentNote ? `${result.text}\n${sentNote}` : result.text,
          },
        ]);
      }
      this.#log(`answered in ${message.threadKey} ($${result.costUsd.toFixed(4)})`);
    } catch (error) {
      this.#log(`answer failed: ${(error as Error).message}`);
      const waiting = this.#pendingDraft(message.threadKey);
      await message.reply([this.#m.hub.modelDown(Boolean(waiting)), ...sent].join("\n\n"));
    }
  }

  /** Reply (and speak, when the owner is in voice mode) with a fixed, non-model message. */
  async #answer(message: IncomingMessage, text: string, fromVoice: boolean): Promise<void> {
    await message.reply(redact(text));
    if (message.replyVoice && this.#shouldSpeak(fromVoice)) {
      const audio = await this.#speak(text, message.projectId);
      if (audio) await message.replyVoice(audio).catch((e: Error) => this.#log(`voice reply failed: ${e.message}`));
    }
  }

  #pendingDraft(threadKey: string, now = Date.now()): Proposal | undefined {
    const draft = this.#state.proposals[threadKey];
    if (!draft) return undefined;
    if (Date.parse(draft.expiresAt) <= now) {
      delete this.#state.proposals[threadKey];
      return undefined;
    }
    return draft;
  }

  /** Instructions sent for a project in the last 24 hours: the ceiling is per project, so one team in a loop cannot silence the others (D-057). */
  #sentToday(projectId: string): number {
    return this.#state.sent[projectId]?.length ?? 0;
  }

  #noteSent(projectId: string, at: string): void {
    (this.#state.sent[projectId] ??= []).push(at);
  }

  /** Daily ceiling bookkeeping and stale drafts; cheap, once per tick. */
  #housekeeping(now: Date): void {
    const dayAgo = now.getTime() - 86_400_000;
    this.#state.sent = recent(this.#state.sent, dayAgo);
    this.#state.autoForwarded = recent(this.#state.autoForwarded, now.getTime() - 3_600_000);
    this.#state.asks = this.#state.asks.filter((at) => Date.parse(at) > dayAgo);
    for (const [key, at] of Object.entries(this.#state.statusAsked)) {
      if (Date.parse(at) < dayAgo) {
        delete this.#state.statusAsked[key];
        delete this.#state.statusAskedBy[key];
      }
    }
    for (const [key, at] of Object.entries(this.#state.awaiting)) if (Date.parse(at) < dayAgo) delete this.#state.awaiting[key];
    for (const key of Object.keys(this.#state.handoffReplies)) if (!this.#state.awaiting[key]) delete this.#state.handoffReplies[key];
    // A handoff never shown in a week (a project muted or silent all along) is no longer what the agent needs.
    const weekAgo = now.getTime() - 7 * 86_400_000;
    this.#state.handoffs = this.#state.handoffs.filter((h) => h.shownAt || Date.parse(h.createdAt) > weekAgo);
    for (const key of Object.keys(this.#state.proposals)) this.#pendingDraft(key, now.getTime());
    for (const key of Object.keys(this.#state.modeRequests)) this.#pendingModeRequest(key, now.getTime());
  }

  /**
   * The PM's tool lands here. It stores a draft — redacted, so what is shown is what is
   * sent — and returns; nothing leaves the machine until the owner says yes.
   */
  async #propose(
    input: { project: string; agent: string; prompt: string; summary: string; ownerAsked?: boolean; irreversible?: boolean },
    projects: readonly Project[],
  ): Promise<{ outcome: { content: string; isError?: boolean }; proposal?: Proposal; autoSend: boolean }> {
    const wanted = input.project.trim().toLowerCase();
    const project =
      projects.find((p) => p.id === wanted || p.config.name.toLowerCase() === wanted) ??
      projects.find((p) => p.id.includes(wanted) || p.config.name.toLowerCase().includes(wanted));
    if (!project) {
      return { outcome: { content: `No project "${input.project}". Known: ${projects.map((p) => p.id).join(", ")}`, isError: true }, autoSend: false };
    }
    const agent = findAgentByName(project, input.agent);
    if (!agent) {
      const known = project.config.agents.map((a) => a.id).join(", ") || "none yet — an agent appears here after its first report";
      return { outcome: { content: `No agent "${input.agent}" in ${project.id}. Known: ${known}`, isError: true }, autoSend: false };
    }
    const prompt = redact(input.prompt.trim());
    if (!prompt) return { outcome: { content: "The prompt is empty.", isError: true }, autoSend: false };
    if (prompt.length > 8000) return { outcome: { content: "The prompt is too long (max 8000 characters); tighten it.", isError: true }, autoSend: false };

    // Prepared, not yet stored: it becomes approvable only once the owner has been shown it.
    const now = new Date().toISOString();
    const proposal: Proposal = {
      id: Math.random().toString(36).slice(2, 10),
      projectId: project.id,
      agentId: agent.id,
      prompt,
      summary: input.summary.trim().slice(0, 300),
      createdAt: now,
      expiresAt: now,
    };
    const task = (input as { task?: string }).task?.trim().toUpperCase();
    if (task && (await readTasks(project)).some((t) => t.id.toUpperCase() === task)) proposal.task = task;
    // Autonomous (D-041): what the owner asked for goes out at once, unless it looks irreversible —
    // to the PM or to the fixed check in code, either is enough — or the daily cap is reached.
    if (projectMode(this.#state, project.id) === "autonomous") {
      if (input.irreversible !== false || looksIrreversible(prompt)) proposal.hold = "risky";
      else if (input.ownerAsked !== true) proposal.hold = "initiative";
      else if (this.#sentToday(project.id) < this.#config.commands.maxPerDay) {
        return {
          proposal,
          autoSend: true,
          outcome: {
            content:
              `Autonomous mode: this instruction goes to ${agent.id} (${project.config.name}) right after your reply, word for word, and the owner is told it was sent. ` +
              "Reply in one or two sentences with what you are sending and any assumption; do not ask for approval and do not repeat the prompt.",
          },
        };
      }
    }
    return {
      proposal,
      autoSend: false,
      outcome: {
        content:
          (proposal.hold
            ? `Autonomous mode, but this waits for the owner's yes (${proposal.hold === "risky" ? "it looks destructive or irreversible" : "it is your idea, not their request"}); the reason is shown with it. `
            : "") +
          `Draft stored for ${agent.id} (${project.config.name}). It is displayed to the owner automatically, word for word, right after your reply, and nothing is sent until they approve. ` +
          "Reply with a one-to-three sentence spoken-style summary of the intent and any assumption; do not repeat the prompt.",
      },
    };
  }

  /** A chat request to make a project autonomous, still waiting for the owner's words. */
  #pendingModeRequest(threadKey: string, now = Date.now()): { projectId: string; expiresAt: string } | undefined {
    const ask = this.#state.modeRequests[threadKey];
    if (!ask) return undefined;
    if (Date.parse(ask.expiresAt) <= now) {
      delete this.#state.modeRequests[threadKey];
      return undefined;
    }
    return ask;
  }

  /** What the PM needs to know of the modes to phrase its answer: this project's, or which ones are autonomous. */
  #modeNote(projects: readonly Project[], project: Project | undefined): string {
    if (project) return `This project is in ${projectMode(this.#state, project.id)} mode (set_project_mode changes it, on the owner's word).`;
    const autonomous = projects.filter((p) => projectMode(this.#state, p.id) === "autonomous").map((p) => p.id);
    return autonomous.length ? `Projects in autonomous mode: ${autonomous.join(", ")}; all others are in control mode.` : "";
  }

  /** The PM's set_project_mode: back to control at once; autonomy is asked of the owner (D-041). */
  async #modeChange(
    projects: readonly Project[],
    input: { project: string; mode: ProjectMode },
    threadBusy: boolean,
  ): Promise<{ outcome: { content: string; isError?: boolean }; ask?: string }> {
    const wanted = input.project.trim().toLowerCase();
    const project =
      projects.find((p) => p.id === wanted || p.config.name.toLowerCase() === wanted) ??
      projects.find((p) => p.id.includes(wanted) || p.config.name.toLowerCase().includes(wanted));
    if (!project) return { outcome: { content: `No project "${input.project}". Known: ${projects.map((p) => p.id).join(", ")}`, isError: true } };
    const name = project.config.name;
    if (projectMode(this.#state, project.id) === input.mode) return { outcome: { content: this.#m.modes.already(name, input.mode) } };
    if (input.mode === "control") {
      await this.setProjectMode(project.id, "control", "chat");
      return { outcome: { content: `Done: ${name} is in control mode now; every instruction waits for the owner's yes. Tell them in one line.` } };
    }
    if (threadBusy) return { outcome: { content: "Something waits for the owner's yes in this thread: they must decide it before autonomy can be asked.", isError: true } };
    return {
      ask: project.id,
      outcome: { content: `The owner is asked to confirm autonomous mode for ${name}: the question, with Yes and No, is shown right after your reply. Say in one or two sentences what it will change; do not ask yourself.` },
    };
  }

  /**
   * A teammate's handoff shown in this thread that a new instruction to the same agent replaces: it is
   * dropped, and the answer is routed back to the teammate who asked. Undefined when there is none.
   */
  #adoptShownHandoff(threadProject: string | null, agentId: string): string | undefined {
    const shown = this.#shownHandoff(threadProject);
    if (!shown || shown.to !== agentId) return undefined;
    this.#state.handoffs = this.#state.handoffs.filter((h) => h !== shown);
    return shown.from;
  }

  /** Send an instruction exactly as stored, record it, and wait for the answer. Returns what to tell the owner. */
  async #sendInstruction(project: Project, draft: Proposal, by: "user" | "pm"): Promise<{ text: string; delivery: Delivery }> {
    const m = this.#m.hub;
    const delivery = await deliverToAgent(project, draft.agentId, draft.prompt, this.#exec);
    const at = new Date().toISOString();
    this.#noteSent(project.id, at);
    this.#afterDelivery(project, draft.agentId, delivery, { text: draft.prompt, kind: draft.handoffFrom ? "handoff" : "command", ...(draft.handoffFrom ? { handoffFrom: draft.handoffFrom } : {}) }, at);
    await this.#trackTask(project, draft.agentId, delivery, { task: draft.task, title: draft.summary || draft.prompt, labels: draft.handoffFrom ? ["handoff"] : [] });
    await saveState(this.#state);
    await recordDecision(project, {
      at,
      by,
      text: m.instructionDecision(displayName(project, draft.agentId), draft.summary),
      why: by === "pm" ? `${this.#m.modes.autoWhy}. ${m.instructionWhy(draft.prompt)}` : m.instructionWhy(draft.prompt),
    }).catch((e: Error) => this.#log(`could not record the decision: ${e.message}`));
    this.#log(`${delivery.queued ? "queued" : "sent"} instruction to ${project.id}/${draft.agentId} via ${delivery.via}${by === "pm" ? " (autonomous)" : ""}`);
    const text = sentMessage(displayName(project, draft.agentId), project.config.name, delivery, this.#lang);
    await this.#activity(
      project,
      `${this.#m.activity.instruction(displayName(project, draft.agentId), draft.summary || draft.prompt.split("\n")[0]!.slice(0, 200))}\n${text}`,
      draft.handoffFrom ? { type: "handoff", agent: draft.handoffFrom, to: draft.agentId } : { type: "instruction", agent: draft.agentId },
    );
    return { text, delivery };
  }

  /** Automatic asks happen by day only: the owner's night is not spent on status updates. */
  #withinStatusHours(now: Date): boolean {
    const { hours } = this.#config.statusChecks;
    return !inQuietHours(now, this.#config.timezone, { start: hours.end, end: hours.start });
  }

  /**
   * The PM following the work: an agent that has been *working* for a long while without a
   * report gets asked for one — a fixed question, by day, rationed per agent and per day.
   */
  async #checkStale(now: Date, projects: readonly Project[]): Promise<void> {
    const cfg = this.#config.statusChecks;
    if (!cfg.enabled || !this.#withinStatusHours(now) || this.#state.asks.length >= cfg.maxPerDay) return;
    let live: Awaited<ReturnType<typeof listPaseoAgents>> | undefined;
    // Each ask spends the owner's subscription: near a limit, the PM keeps quiet instead of
    // using up what the agents need to finish their work.
    const strained = new Set<string>();
    for (const w of await this.#windows()) {
      const open = w.resetsAt === null || w.resetsAt > now.getTime();
      if (open && (w.reached || (w.usedPercent ?? 0) >= this.#config.limits.warnAtPercent)) strained.add(w.product);
    }
    for (const project of projects) {
      // A muted project is one the owner does not want to hear about: do not poke its agents either.
      if (isMuted(this.#state, project.id, now)) continue;
      for (const agent of project.config.agents) {
        if (agent.control !== "paseo" || !agent.paseoAgent) continue;
        if (strained.has(agent.host === "codex" ? "Codex" : "Claude Code")) continue;
        const last = await latestReport(project, agent.id);
        if (!last || now.getTime() - Date.parse(last.at) < cfg.staleAfterMinutes * 60_000) continue;
        live ??= await listPaseoAgents(this.#exec);
        if (findPaseoAgent(live, agent.paseoAgent)?.status !== "running") continue;
        const outcome = await this.#askStatus(projects, { project: project.id, agent: agent.id }, "auto", now);
        if (!outcome.isError) this.#log(`asked ${project.id}/${agent.id} for a status update`);
        if (this.#state.asks.length >= cfg.maxPerDay) return;
      }
    }
  }

  /** Ask an agent for a report. Every refusal says why, so the PM can tell the owner the truth. */
  async #askStatus(
    projects: readonly Project[],
    input: { project: string; agent: string },
    source: "pm" | "auto",
    at = new Date(),
  ): Promise<{ content: string; isError?: boolean }> {
    const refuse = (content: string) => ({ content, isError: true as const });
    const cfg = this.#config.statusChecks;
    const wanted = input.project.trim().toLowerCase();
    const project =
      projects.find((p) => p.id === wanted || p.config.name.toLowerCase() === wanted) ??
      projects.find((p) => p.id.includes(wanted) || p.config.name.toLowerCase().includes(wanted));
    if (!project) return refuse(`No project "${input.project}". Known: ${projects.map((p) => p.id).join(", ")}`);
    const agent = project.config.agents.find((a) => a.id === input.agent.trim().toLowerCase());
    if (!agent) return refuse(`No agent "${input.agent}" in ${project.id}. Known: ${project.config.agents.map((a) => a.id).join(", ") || "none yet"}`);

    const key = `${project.id}:${agent.id}`;
    const now = at.getTime();
    const label = `${displayName(project, agent.id)} (${project.config.name})`;
    if (this.#state.awaiting[key]) return refuse(`${label} is already expected to answer something; wait for its report.`);
    const lastAsk = this.#state.statusAsked[key];
    const gap = source === "auto" ? cfg.minIntervalMinutes : 20;
    if (lastAsk && now - Date.parse(lastAsk) < gap * 60_000) {
      return refuse(`${label} was asked ${Math.max(1, Math.round((now - Date.parse(lastAsk)) / 60_000))} minutes ago; its answer is awaited.`);
    }
    if (this.#state.asks.length >= cfg.maxPerDay) return refuse(`The daily ceiling of ${cfg.maxPerDay} status asks has been reached.`);

    // Only a first look: the question itself goes out through askLive, on a fresh answer.
    const reach = await reachability(project, agent.id, this.#exec, { fresh: false });
    if (reach.via !== "paseo") return refuse(`${label} cannot be reached live (${reach.reason}); its last report is the latest status.`);
    const unreported = (await buildSnapshot(project)).agents.find((a) => a.id === agent.id)?.unreportedCommits.length ?? 0;
    if (!reach.busy && unreported === 0) {
      return refuse(`${label} is idle and has nothing unreported: its last report is the current status. Asking would only wake it for nothing.`);
    }

    const question = this.#m.hub.statusQuestion;
    const sent = await askLive(project, agent.id, question, this.#exec);
    if (!sent.sent) return refuse(`${label} could not be asked: ${sent.reason}.`);

    const iso = at.toISOString();
    // Awaited from now either way: a working agent's next report answers the question, even before it is asked.
    this.#state.awaiting[key] = iso;
    if (sent.queued) {
      // Working: the question waits for the end of its turn, and is dropped if that turn ends with a report (D-042).
      this.#queueDelivery(project, agent.id, { text: question, kind: "status" }, iso);
    } else {
      this.#contact(project.id, agent.id, "status");
    }
    this.#state.statusAsked[key] = iso;
    this.#state.statusAskedBy[key] = source;
    this.#state.asks.push(iso);
    await saveState(this.#state);
    await this.#activity(project, this.#m.activity.statusAsked(displayName(project, agent.id), sent.queued === true), { type: "status", agent: agent.id });
    return {
      content: sent.queued
        ? `${label} is working, so the question waits until its current turn ends — it is not interrupted — and is dropped if that turn ends with a report anyway. Its next report reaches the owner automatically; tell them so.`
        : `Asked ${label} for a status report (it was idle: this starts a short turn). Its next report reaches the owner automatically; tell them you asked.`,
    };
  }

  /**
   * A question for an agent, asked by the PM for the owner (D-058): a fixed read-only frame around it, no approval
   * (it asks, it changes nothing), the project's daily ceiling, and its answer — the agent's next report — told to the
   * owner as one. A question that reads like a destructive action is refused: that is an instruction, and needs a yes.
   */
  async #askTeam(projects: readonly Project[], input: { project: string; agent: string; question: string }): Promise<{ content: string; isError?: boolean }> {
    const refuse = (content: string) => ({ content, isError: true as const });
    const wanted = input.project.trim().toLowerCase();
    const project =
      projects.find((p) => p.id === wanted || p.config.name.toLowerCase() === wanted) ??
      projects.find((p) => p.id.includes(wanted) || p.config.name.toLowerCase().includes(wanted));
    if (!project) return refuse(`No project "${input.project}". Known: ${projects.map((p) => p.id).join(", ")}`);
    const name = input.agent.trim().toLowerCase();
    const agent = project.config.agents.find((a) => a.id === name || displayName(project, a.id).toLowerCase() === name);
    if (!agent) return refuse(`No agent "${input.agent}" in ${project.id}. Known: ${project.config.agents.map((a) => a.id).join(", ") || "none yet"}`);
    const question = redact(input.question.replace(/\s+/g, " ").trim()).slice(0, 1000);
    if (!question) return refuse("The question is empty.");
    if (looksIrreversible(question)) return refuse("That reads like an action, not a question: propose it as an instruction (propose_agent_command) for the owner's yes.");
    const cap = this.#config.commands.maxPerDay;
    if (this.#sentToday(project.id) >= cap) return refuse(`The daily ceiling of ${cap} messages to ${project.config.name}'s agents has been reached; answer from what you know and say so.`);
    const key = `${project.id}:${agent.id}`;
    const label = `${displayName(project, agent.id)} (${project.config.name})`;
    if (this.#state.awaiting[key]) return refuse(`${label} is already expected to answer something; its next report will arrive by itself. Ask it later.`);

    const text = this.#m.hub.teamQuestion(question);
    const sent = await askLive(project, agent.id, text, this.#exec);
    if (!sent.sent) return refuse(`${label} cannot be asked now: ${sent.reason}.`);
    const iso = new Date().toISOString();
    this.#state.awaiting[key] = iso;
    this.#state.teamQuestions ??= {};
    this.#state.teamQuestions[key] = iso;
    // A question waits for the end of a working agent's turn like an instruction, and is never dropped (D-042).
    if (sent.queued) this.#queueDelivery(project, agent.id, { text, kind: "command" }, iso);
    else this.#contact(project.id, agent.id, "status");
    this.#noteSent(project.id, iso);
    await saveState(this.#state);
    await this.#activity(project, this.#m.activity.questionAsked(displayName(project, agent.id), question), { type: "status", agent: agent.id });
    return {
      content: sent.queued
        ? `${label} is working: the question reaches it when its current turn ends, without interrupting it. Its answer reaches the owner by itself; tell them whom you asked.`
        : `Asked ${label}. Its answer reaches the owner by itself when it reports; tell them whom you asked and what, in one line.`,
    };
  }

  /**
   * After a delivery: one that went out is a contact, and its answer is awaited from now. One that was queued
   * (the agent was working) becomes both when it goes out, at the end of the agent's turn (D-042).
   */
  #afterDelivery(project: Project, agentId: string, delivery: Delivery, item: Omit<QueuedDelivery, "id" | "projectId" | "agentId" | "paseoAgent" | "queuedAt">, at: string): void {
    if (delivery.queued) {
      this.#queueDelivery(project, agentId, item, at);
      return;
    }
    const key = `${project.id}:${agentId}`;
    // The office shows the PM walking over only when the message reached the agent, not when it waits in an inbox.
    if (delivery.via === "paseo") this.#contact(project.id, agentId, item.kind);
    this.#state.awaiting[key] = at;
    if (item.handoffFrom) this.#state.handoffReplies[key] = item.handoffFrom;
  }

  /**
   * Instructions left in a Paseo agent's inbox — its session was closed, or Paseo refused them — go out as soon
   * as Paseo lists the session as idle again, all in one message so a second one cannot interrupt the first
   * (D-050). Only the owner's instructions: Leftoff's own reminders wait for the agent's next turn as before.
   */
  async #catchUpInboxes(now: Date, quiet: boolean, projects: readonly Project[]): Promise<void> {
    const candidates = projects.flatMap((p) => p.config.agents.filter((a) => !a.retired && a.control === "paseo" && a.paseoAgent).map((a) => ({ project: p, agent: a })));
    if (candidates.length === 0) return;
    let live: Awaited<ReturnType<typeof listPaseoAgents>> | undefined;
    for (const { project, agent } of candidates) {
      const waiting = (await pending(project, agent.id)).filter((m) => m.from === "user");
      if (waiting.length === 0) continue;
      live ??= await listPaseoAgents(this.#exec, { fresh: true });
      const session = findPaseoAgent(live, agent.paseoAgent!);
      if (session?.status !== "idle") continue;
      const text = waiting.length === 1 ? waiting[0]!.text : waiting.map((m) => m.text).join("\n\n---\n\n");
      if (!(await sendViaPaseo(agent.paseoAgent!, text, this.#exec))) continue;
      await markDelivered(project, agent.id, waiting.map((m) => m.id));
      this.#contact(project.id, agent.id, "command");
      this.#state.awaiting[`${project.id}:${agent.id}`] = now.toISOString();
      // It is working now: whatever else is listed for it this pass must wait for its turn to end.
      session.status = "running";
      this.#log(`delivered ${waiting.length} inbox message(s) to ${project.id}/${agent.id} via paseo: its session is active again`);
      await this.#activity(project, this.#m.delivery.delivered(displayName(project, agent.id), project.config.name, true), { type: "delivered", agent: agent.id });
    }
    if (live) await saveState(this.#state);
  }

  #queueDelivery(project: Project, agentId: string, item: Omit<QueuedDelivery, "id" | "projectId" | "agentId" | "paseoAgent" | "queuedAt">, at: string): void {
    const paseoAgent = project.config.agents.find((a) => a.id === agentId)?.paseoAgent;
    if (!paseoAgent) return;
    this.#state.deliveryQueue.push({ id: Math.random().toString(36).slice(2, 10), projectId: project.id, agentId, paseoAgent, queuedAt: at, ...item });
    this.#log(`queued ${item.kind} for ${project.id}/${agentId}: it is working, and will not be interrupted`);
  }

  /** Has a hook said, since something was queued for an agent, that the agent's turn ended? */
  async #queuedTurnEnded(): Promise<boolean> {
    for (const item of this.#state.deliveryQueue) {
      const ended = await turnEndedAt(item.projectId, item.agentId).catch(() => undefined);
      if (ended && Date.parse(ended) >= Date.parse(item.queuedAt)) return true;
    }
    return false;
  }

  /**
   * Deliver what waited for an agent to finish its turn (D-042): to an idle agent it starts a new turn, never
   * interrupting one. A status question its own report has since answered is dropped; an agent whose session
   * closed gets instructions in its inbox. Runs every 15 seconds and at each tick; cheap when nothing waits.
   */
  async flushDeliveries(now = new Date(), options: { whenTurnEnded?: boolean } = {}): Promise<void> {
    if (this.#flushing || this.#state.deliveryQueue.length === 0) return;
    // The hook's word only decides *when* to ask; whether to send is still Paseo's fresh «idle». Every pass asks anyway,
    // for every agent, since a hook can be missing or fail.
    if (options.whenTurnEnded && !(await this.#queuedTurnEnded())) return;
    this.#flushing = true;
    try {
      const agents = await listPaseoAgents(this.#exec, { fresh: true });
      if (agents.length === 0) return; // Paseo did not answer: nothing can be known to be idle, so nothing goes
      const projects = await this.#chatProjects();
      const done = new Set<string>();
      for (const item of [...this.#state.deliveryQueue]) {
        const project = projects.find((p) => p.id === item.projectId);
        const label = `${item.projectId}/${item.agentId}`;
        if (!project) {
          done.add(item.id);
          this.#log(`queued ${item.kind} for ${label} dropped: the project is gone or private`);
          continue;
        }
        const live = findPaseoAgent(agents, item.paseoAgent);
        if (live?.status === "running") continue;
        if (item.kind === "status") {
          const last = await latestReport(project, item.agentId).catch(() => undefined);
          if (!live || live.status === "closed" || (last && Date.parse(last.at) > Date.parse(item.queuedAt))) {
            done.add(item.id);
            this.#log(`queued status question for ${label} dropped: ${live && live.status !== "closed" ? "its turn ended with a report" : "its session is gone"}`);
            continue;
          }
        }
        const key = `${item.projectId}:${item.agentId}`;
        const at = now.toISOString();
        let via: "paseo" | "inbox" = "paseo";
        if (!live || live.status === "closed" || !(await sendViaPaseo(item.paseoAgent, item.text, this.#exec))) {
          item.tries = (item.tries ?? 0) + (live && live.status !== "closed" ? 1 : 5);
          if (item.tries < 5) continue; // Paseo refused it: try again next pass
          // An instruction the owner approved is never lost: its inbox gives it at the agent's next session.
          await enqueue(project, item.agentId, item.text, "user");
          via = "inbox";
        }
        done.add(item.id);
        this.#contact(item.projectId, item.agentId, item.kind);
        this.#state.awaiting[key] = at;
        if (item.handoffFrom) this.#state.handoffReplies[key] = item.handoffFrom;
        this.#log(`delivered queued ${item.kind} to ${label} via ${via}, ${Math.round((now.getTime() - Date.parse(item.queuedAt)) / 1000)} s after it was sent`);
        await this.#activity(project, this.#m.delivery.delivered(displayName(project, item.agentId), project.config.name, via === "paseo"), { type: "delivered", agent: item.agentId });
      }
      if (done.size) {
        // Filtered, not replaced: something queued while this pass awaited Paseo stays queued.
        this.#state.deliveryQueue = this.#state.deliveryQueue.filter((i) => !done.has(i.id));
        await saveState(this.#state);
      }
    } finally {
      this.#flushing = false;
    }
  }

  // ---------- the macro plan (D-051) ----------

  #findProject(projects: readonly Project[], name: string): Project | undefined {
    const wanted = name.trim().toLowerCase();
    return (
      projects.find((p) => p.id === wanted || p.config.name.toLowerCase() === wanted) ??
      projects.find((p) => p.id.includes(wanted) || p.config.name.toLowerCase().includes(wanted))
    );
  }

  /**
   * Every instruction belongs to a task, so nothing starts without showing on the board: the one it names
   * moves to In Progress when it reaches the agent; without one, a task is opened for it, marked as started
   * automatically. Its answer — the agent's next report — moves it on.
   */
  async #trackTask(project: Project, agentId: string, delivery: Delivery, item: { task?: string | undefined; title: string; labels: string[] }): Promise<void> {
    const started = delivery.via === "paseo" && !delivery.queued;
    try {
      let id = item.task;
      if (id) {
        if (started) await updateTask(project, id, { status: "In Progress" });
      } else {
        const title = item.title.replace(/\s+/g, " ").trim().slice(0, 120) || agentId;
        const made = await createTask(project, {
          title,
          description: "",
          acceptanceCriteria: [],
          labels: [AUTO, ...item.labels],
          priority: "medium",
          assignee: [agentId],
          status: started ? "In Progress" : "To Do",
        });
        id = made.id;
      }
      this.#state.taskOf[`${project.id}:${agentId}`] = id;
    } catch (error) {
      this.#log(`could not track a task for ${project.id}/${agentId}: ${(error as Error).message}`);
    }
  }

  #shownPlan(threadKey: string, now = Date.now()): Plan | undefined {
    return Object.values(this.#state.plans).find((p) => p.status === "shown" && p.threadKey === threadKey && p.expiresAt !== undefined && Date.parse(p.expiresAt) > now);
  }

  async #requestPlans(projects: readonly Project[], input: { project: string; goal: string; agents: string[] }): Promise<{ content: string; isError?: boolean }> {
    const project = this.#findProject(projects, input.project);
    if (!project) return { content: `No project "${input.project}". Known: ${projects.map((p) => p.id).join(", ")}`, isError: true };
    const current = this.#state.plans[project.id];
    if (current && (current.status === "collecting" || current.status === "shown")) {
      return { content: `A plan is already being prepared for ${project.id} («${current.goal}», ${current.status}). Consolidate and submit it, or drop it on the owner's word, before asking for another.`, isError: true };
    }
    const goal = redact(input.goal.replace(/\s+/g, " ").trim()).slice(0, 500);
    if (!goal) return { content: "The goal is empty.", isError: true };
    const agents = [...new Set(input.agents.map((a) => findAgentByName(project, a)?.id).filter((a): a is string => Boolean(a)))];
    const unknown = input.agents.filter((a) => !findAgentByName(project, a));
    if (agents.length === 0) return { content: `None of these agents is in ${project.id}${unknown.length ? ` (${unknown.join(", ")})` : ""}. Team: ${project.config.agents.filter((a) => !a.retired).map((a) => a.id).join(", ")}`, isError: true };

    const plan: Plan = { id: newPlanId(), projectId: project.id, goal, askedAt: new Date().toISOString(), agents, status: "collecting" };
    this.#state.plans[project.id] = plan;
    const lines: string[] = [];
    for (const agentId of agents) {
      const agent = project.config.agents.find((a) => a.id === agentId)!;
      const text = this.#m.plan.request({ goal, project: project.config.name, agent: agentId, role: agent.role ?? null, planId: plan.id });
      const delivery = await deliverToAgent(project, agentId, text, this.#exec).catch(() => undefined);
      const at = new Date().toISOString();
      this.#noteSent(project.id, at);
      if (delivery) {
        this.#afterDelivery(project, agentId, delivery, { text, kind: "command" }, at);
        await this.#activity(project, `${this.#m.activity.planAsked(displayName(project, agentId), goal)}\n${sentMessage(displayName(project, agentId), project.config.name, delivery, this.#lang)}`, { type: "instruction", agent: agentId });
      }
      lines.push(`${agentId}: ${!delivery ? "could not be asked" : delivery.via === "inbox" ? `waiting (${delivery.reason}); it goes out when its Paseo session is active again` : delivery.queued ? "working; asked when its current turn ends" : "asked"}`);
    }
    await saveState(this.#state);
    this.#log(`plan ${plan.id} for ${project.id}: asked ${agents.join(", ")}`);
    return {
      content:
        `Plan ${plan.id} for ${project.id}: «${goal}». ${lines.join("; ")}.${unknown.length ? ` Not in the team: ${unknown.join(", ")}.` : ""} ` +
        "Tell the owner whom you asked, that nothing starts before they approve the plan, and that they will be told when the plans are in.",
    };
  }

  async #readPlan(projects: readonly Project[], name: string): Promise<{ content: string; isError?: boolean }> {
    const project = this.#findProject(projects, name);
    if (!project) return { content: `No project "${name}".`, isError: true };
    const plan = this.#state.plans[project.id];
    if (!plan || plan.status === "dropped") return { content: `${project.id} has no plan. Use request_plans to start one.` };
    const tasks = await planTasks(project, plan.id);
    return {
      content: JSON.stringify({
        plan: { id: plan.id, goal: plan.goal, status: plan.status, askedAt: plan.askedAt, asked: plan.agents, notAnsweredYet: missing(plan, tasks) },
        team: project.config.agents.filter((a) => !a.retired).map((a) => ({ id: a.id, role: a.role ?? null })),
        phases: phasesOf(tasks).map((ph) => ({
          phase: ph.name,
          tasks: ph.tasks.map((t) => ({ id: t.id, title: t.title, owner: t.assignee, status: t.status, waitsOn: t.dependencies, proposed: t.labels.includes(PROPOSED) })),
        })),
      }),
    };
  }

  async #revisePlanTask(
    projects: readonly Project[],
    input: { project: string; task: string; phase: string; changeDepends: boolean; depends: string[]; assignee: string; drop: boolean },
  ): Promise<{ content: string; isError?: boolean }> {
    const project = this.#findProject(projects, input.project);
    const plan = project ? this.#state.plans[project.id] : undefined;
    if (!project || !plan || plan.status !== "collecting") return { content: "There is no plan being prepared there; only a plan not yet approved can be revised.", isError: true };
    const label = planLabel(plan.id);
    const task = (await planTasks(project, plan.id)).find((t) => t.id.toUpperCase() === input.task.trim().toUpperCase());
    if (!task || !task.labels.includes(PROPOSED)) return { content: `${input.task} is not a proposed task of this plan.`, isError: true };
    if (input.drop) {
      return (await dropProposedTask(project, task.id, label)) ? { content: `${task.id} dropped from the plan.` } : { content: `${task.id} could not be dropped.`, isError: true };
    }
    const assignee = input.assignee.trim() ? findAgentByName(project, input.assignee)?.id : undefined;
    if (input.assignee.trim() && !assignee) return { content: `No agent "${input.assignee}" in ${project.id}.`, isError: true };
    const phase = input.phase.replace(/\s+/g, " ").trim().slice(0, 60);
    const updated = await updateTask(project, task.id, {
      ...(phase ? { milestone: phase } : {}),
      ...(input.changeDepends ? { dependencies: input.depends.map((d) => d.trim()).filter((d) => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(d)) } : {}),
      ...(assignee ? { assignee: [assignee] } : {}),
    });
    return { content: `${task.id}: ${updated?.milestone ?? "—"}, ${updated?.assignee.join(", ") || "—"}, waits on ${updated?.dependencies.join(", ") || "nothing"}.` };
  }

  async #submitPlan(projects: readonly Project[], input: { project: string; summary: string }, threadBusy: boolean): Promise<{ outcome: { content: string; isError?: boolean }; submitted?: string }> {
    const project = this.#findProject(projects, input.project);
    const plan = project ? this.#state.plans[project.id] : undefined;
    if (!project || !plan || (plan.status !== "collecting" && plan.status !== "shown")) return { outcome: { content: "There is no plan to submit there.", isError: true } };
    if ((await planTasks(project, plan.id)).length === 0) return { outcome: { content: "The plan has no tasks yet: the agents have not sent their parts.", isError: true } };
    if (threadBusy) return { outcome: { content: "Something else waits for the owner's yes in this thread: they must decide it first.", isError: true } };
    plan.summary = redact(input.summary.replace(/\s+/g, " ").trim()).slice(0, 800);
    return {
      submitted: project.id,
      outcome: { content: "The plan is displayed to the owner automatically right after your reply, phase by phase, with Yes and No. Reply in one or two sentences; do not repeat the plan." },
    };
  }

  async #planBlock(project: Project): Promise<string> {
    const plan = this.#state.plans[project.id];
    if (!plan) return "";
    const tasks = await planTasks(project, plan.id);
    if (tasks.length === 0) return "";
    return planMessage(
      { goal: plan.goal, projectName: project.config.name, summary: plan.summary ?? "", ttlMinutes: this.#config.commands.proposalTtlMinutes },
      phasesOf(tasks),
      (id) => displayName(project, id),
      this.#lang,
    );
  }

  /** The owner's one yes: the proposals become the project's tasks, recorded, and each agent gets its own, in order. */
  async #approvePlan(plan: Plan, projects: readonly Project[], message: IncomingMessage, fromVoice: boolean): Promise<void> {
    const project = projects.find((p) => p.id === plan.projectId);
    if (!project) {
      await this.#answer(message, this.#m.hub.projectGone, fromVoice);
      return;
    }
    const tasks = await planTasks(project, plan.id);
    for (const t of tasks) if (t.labels.includes(PROPOSED)) await updateTask(project, t.id, { removeLabels: [PROPOSED] });
    const phases = phasesOf(tasks);
    plan.status = "approved";
    plan.approvedAt = new Date().toISOString();
    delete plan.threadKey;
    delete plan.expiresAt;
    await recordDecision(project, { at: plan.approvedAt, by: "user", text: this.#m.plan.decision(plan.goal, tasks.length, phases.length), why: plan.summary ?? plan.goal }).catch((e: Error) =>
      this.#log(`could not record the plan: ${e.message}`),
    );
    // Each agent's own tasks, in phase order, with what each waits on.
    const owners = [...new Set(tasks.flatMap((t) => t.assignee))];
    for (const agentId of owners) {
      if (!project.config.agents.some((a) => a.id === agentId && !a.retired)) continue;
      const mine = phases.flatMap((ph) => ph.tasks.filter((t) => t.assignee.includes(agentId)).map((t) => `- ${t.id} [${ph.name}] ${t.title}${t.dependencies.length ? ` (${this.#m.plan.after(t.dependencies.join(", "))})` : ""}`));
      const text = this.#m.plan.start({ goal: plan.goal, agent: agentId, tasks: mine.join("\n") });
      const delivery = await deliverToAgent(project, agentId, text, this.#exec).catch(() => undefined);
      const at = new Date().toISOString();
      this.#noteSent(project.id, at);
      if (delivery) this.#afterDelivery(project, agentId, delivery, { text, kind: "command" }, at);
    }
    await saveState(this.#state);
    this.#log(`plan ${plan.id} for ${project.id} approved: ${tasks.length} tasks, ${owners.length} agents told`);
    await this.#answer(message, this.#m.plan.approved(plan.goal, project.config.name, tasks.length), fromVoice);
  }

  async #dropPlan(projects: readonly Project[], name: string): Promise<{ content: string; isError?: boolean }> {
    const project = this.#findProject(projects, name);
    const plan = project ? this.#state.plans[project.id] : undefined;
    if (!project || !plan || plan.status === "approved" || plan.status === "dropped") return { content: "There is no plan in preparation there.", isError: true };
    let removed = 0;
    for (const t of await planTasks(project, plan.id)) if (await dropProposedTask(project, t.id, planLabel(plan.id))) removed++;
    plan.status = "dropped";
    await saveState(this.#state);
    return { content: `Plan «${plan.goal}» dropped; ${removed} proposed tasks removed.` };
  }

  /** The owner hears when the plans are in, or, after two hours, what is still missing — once, by template (D-016). */
  async #checkPlans(now: Date, quiet: boolean, projects: readonly Project[]): Promise<void> {
    for (const plan of Object.values(this.#state.plans)) {
      if (plan.status !== "collecting" || plan.noticedAt) continue;
      const project = projects.find((p) => p.id === plan.projectId);
      if (!project) continue;
      const tasks = await planTasks(project, plan.id);
      const waiting = missing(plan, tasks);
      const late = now.getTime() - Date.parse(plan.askedAt) > 2 * 3_600_000;
      if (waiting.length > 0 && !late) continue;
      const names = waiting.map((a) => displayName(project, a)).join(", ");
      const text =
        waiting.length === 0 ? this.#m.plan.ready(plan.goal, project.config.name, tasks.length)
        : tasks.length ? this.#m.plan.partial(plan.goal, project.config.name, tasks.length, names)
        : this.#m.plan.none(plan.goal, project.config.name, names);
      plan.noticedAt = now.toISOString();
      if (isMuted(this.#state, project.id, now)) await this.#hold(project.id, text);
      else if (quiet) this.#state.queued.push({ projectId: project.id, text, at: now.toISOString() });
      else await this.#send(project.id, text);
    }
  }

  /** Make a shown draft approvable, replacing whatever was pending in the thread. */
  async #commitDraft(threadKey: string, proposal: Proposal, threadProject: string | null): Promise<void> {
    const now = Date.now();
    // Only the last thing shown in a thread is approvable. A handoff shown here either is what the
    // owner just had revised (same teammate: the draft replaces it) or waits to be shown again later.
    const handoffFrom = this.#adoptShownHandoff(threadProject, proposal.agentId);
    const shown = this.#shownHandoff(threadProject, now);
    if (shown) {
      delete shown.shownAt;
      delete shown.expiresAt;
    }
    this.#state.proposals[threadKey] = {
      ...proposal,
      threadProject,
      ...(handoffFrom ? { handoffFrom } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#config.commands.proposalTtlMinutes * 60_000).toISOString(),
    };
    await saveState(this.#state);
  }

  async #draftBlock(proposal: Proposal, projects: readonly Project[]): Promise<string> {
    const project = projects.find((p) => p.id === proposal.projectId);
    if (!project) return "";
    const reach = await reachability(project, proposal.agentId, this.#exec, { fresh: false });
    return draftMessage(
      { agentName: displayName(project, proposal.agentId), projectName: project.config.name, prompt: proposal.prompt, ttlMinutes: this.#config.commands.proposalTtlMinutes },
      reach,
      this.#lang,
    );
  }

  /** The owner said yes: send exactly the stored text, record it, and wait for the answer. */
  async #approve(draft: Proposal, projects: readonly Project[], message: IncomingMessage, fromVoice: boolean): Promise<void> {
    const m = this.#m.hub;
    delete this.#state.proposals[message.threadKey];
    const project = projects.find((p) => p.id === draft.projectId);
    if (!project) {
      await saveState(this.#state);
      await this.#answer(message, m.projectGone, fromVoice);
      return;
    }
    const cap = this.#config.commands.maxPerDay;
    if (this.#sentToday(project.id) >= cap) {
      await saveState(this.#state);
      await this.#answer(message, m.capReached(cap, project.config.name), fromVoice);
      return;
    }
    try {
      await this.#answer(message, (await this.#sendInstruction(project, draft, "user")).text, fromVoice);
    } catch (error) {
      this.#log(`sending failed: ${(error as Error).message}`);
      await message.reply(m.sendFailed);
    }
  }

  /**
   * An agent asked a teammate for something (D-036). Each ask becomes a draft for that teammate,
   * shown in the project's thread and sent only on the owner's «sì», like any other instruction.
   */
  async #queueHandoffs(project: Project, report: Report, now: Date, quiet: boolean): Promise<void> {
    if (!this.#config.commands.enabled) return;
    const m = this.#m.handoff;
    const from = displayName(project, report.agent);
    const role = project.config.agents.find((a) => a.id === report.agent)?.role ?? null;
    for (const [index, handoff] of report.handoffs.entries()) {
      const id = `${project.id}:${report.file}#${index}`;
      if (this.#state.handoffs.some((h) => h.id === id)) continue;
      const target = findTeammate(project, handoff.to, report.agent);
      if (!target) {
        const team = project.config.agents
          .filter((a) => !a.retired && a.id !== report.agent)
          .map((a) => `${displayName(project, a.id)}${a.role ? ` (${a.role})` : ""}`)
          .join(", ");
        const text = m.unknownTarget(from, handoff.to, handoff.ask, team || "—");
        if (isMuted(this.#state, project.id, now)) await this.#hold(project.id, text);
        else if (quiet) this.#state.queued.push({ projectId: project.id, text, at: now.toISOString() });
        else await this.#send(project.id, text);
        continue;
      }
      this.#state.handoffs.push({
        id,
        projectId: project.id,
        from: report.agent,
        to: target.id,
        ask: redact(handoff.ask),
        prompt: redact(m.instruction({ from, fromId: report.agent, role, ask: handoff.ask, report: report.file, branch: report.branch ?? null, commits: report.commits })),
        report: report.file,
        createdAt: now.toISOString(),
      });
    }
  }

  /** The handoff shown in this project's thread that the owner can still approve. */
  #shownHandoff(projectId: string | null, now = Date.now()): PendingHandoff | undefined {
    if (!projectId) return undefined;
    return this.#state.handoffs.find((h) => h.projectId === projectId && h.expiresAt !== undefined && Date.parse(h.expiresAt) > now);
  }

  /** The PM's own draft waits in this project's thread: showing a handoff now would make «sì» ambiguous. */
  #threadBusy(projectId: string, now: number): boolean {
    return (
      Object.values(this.#state.proposals).some((p) => p.threadProject === projectId && Date.parse(p.expiresAt) > now) ||
      Object.values(this.#state.projectDrafts ?? {}).some((d) => d.threadProject === projectId && Date.parse(d.expiresAt) > now) ||
      Object.values(this.#state.agentDrafts ?? {}).some((d) => d.threadProject === projectId && Date.parse(d.expiresAt) > now)
    );
  }

  /** Does anything in this thread already wait for the owner's «sì»? Then nothing else may be shown for one. */
  #approvableIn(message: IncomingMessage): boolean {
    return Boolean(
      this.#pendingDraft(message.threadKey) ||
        this.#shownHandoff(message.projectId) ||
        this.#pendingModeRequest(message.threadKey) ||
        this.#shownPlan(message.threadKey) ||
        this.#pendingProjectDraft(message.threadKey) ||
        this.#pendingAgentDraft(message.threadKey),
    );
  }

  #pendingProjectDraft(threadKey: string, now = Date.now()): { name: string; purpose?: string; threadProject: string | null; expiresAt: string } | undefined {
    this.#state.projectDrafts ??= {};
    const draft = this.#state.projectDrafts[threadKey];
    if (draft && Date.parse(draft.expiresAt) <= now) {
      delete this.#state.projectDrafts[threadKey];
      return undefined;
    }
    return draft;
  }

  /** What a new project would be, in the owner's words — a fixed template, never the model's (D-016) — or why it cannot. */
  async #projectDraft(rawName: string, purpose: string): Promise<{ text: string; ready: boolean }> {
    const L = this.#m.newProject;
    if (!this.#projects) return { text: L.usage, ready: false };
    try {
      const plan = await this.#projects.check(rawName);
      const name = rawName.replace(/\s+/g, " ").trim();
      const paseo = (await this.#projects.options()).paseo;
      return { text: [L.draft(name, plan.folder), purpose.trim() ? `«${purpose.trim().slice(0, 200)}»` : "", paseo === "unavailable" ? L.paseoDown : ""].filter(Boolean).join("\n"), ready: true };
    } catch (error) {
      return { text: this.#projectRefusal(error), ready: false };
    }
  }

  #projectRefusal(error: unknown): string {
    const L = this.#m.newProject;
    if (error instanceof NewProjectError) {
      if (error.type === "invalid_name") {
        const reasons: Record<string, string> = { empty: L.invalid.empty, too_long: L.invalid.tooLong(NAME_MAX), bad_chars: L.invalid.badChars, reserved: L.invalid.reserved, no_id: L.invalid.noId };
        return reasons[error.reason ?? ""] ?? L.invalid.badChars;
      }
      if (error.type === "exists") return L.exists(error.existing?.kind ?? "project");
    }
    return (error as Error).message;
  }

  /** Only now, after the owner has been shown exactly what will be made, does a «sì» make it. */
  async #holdProjectDraft(message: IncomingMessage, name: string, purpose: string): Promise<void> {
    this.#state.projectDrafts ??= {};
    this.#state.projectDrafts[message.threadKey] = {
      name: name.trim(),
      ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      threadProject: message.projectId,
      expiresAt: new Date(Date.now() + this.#config.commands.proposalTtlMinutes * 60_000).toISOString(),
    };
    await saveState(this.#state);
  }

  /** The owner said yes: the same job as the panel's, and its end told in this thread. */
  async #createProject(draft: { name: string; purpose?: string }, message: IncomingMessage): Promise<void> {
    delete this.#state.projectDrafts[message.threadKey];
    await saveState(this.#state);
    if (!this.#projects) return;
    let job;
    try {
      job = await this.#projects.start({ name: draft.name, purpose: draft.purpose ?? "" }, "chat");
    } catch (error) {
      await message.reply(this.#projectRefusal(error));
      return;
    }
    await message.reply(this.#m.newProject.creating(job.name));
    void this.#followProject(job.id, message);
  }

  async #retryProject(jobId: string, message: IncomingMessage): Promise<void> {
    if (!this.#projects) return;
    try {
      const job = await this.#projects.retry(jobId);
      await message.reply(this.#m.newProject.creating(job.name));
      void this.#followProject(job.id, message);
    } catch (error) {
      await message.reply(this.#projectRefusal(error));
    }
  }

  /** Chat is not a log: one message at the end, done or stopped (with Retry); the steps are in the panel. */
  async #followProject(jobId: string, message: IncomingMessage): Promise<void> {
    const L = this.#m.newProject;
    const job = await this.#projects?.settled(jobId);
    if (!job || job.status === "running") return;
    if (job.status === "done") {
      const add = `/newagent ${job.projectId}`;
      const choices = this.#agents && Buffer.byteLength(add) <= CHOICE_BYTES ? { choices: [{ label: L.buttons.addAgent, reply: add }] } : undefined;
      await message.reply(L.done(job.name), choices).catch((e: Error) => this.#log(`new project: ${e.message}`));
      return;
    }
    const failed = job.steps.find((x) => x.status === "failed");
    const step = failed ? L.steps[failed.id] : L.steps[STEPS[0]];
    const reason = failed?.error ? this.#projectRefusal(new NewProjectError(failed.error.type as NewProjectError["type"], failed.error.message, failed.error.detail ? { detail: failed.error.detail } : {})) : "";
    const why = failed?.error?.detail ? `${reason} (${failed.error.detail})` : reason;
    await message
      .reply(L.failed(job.name, step, why), failed?.retryable ? { choices: [{ label: L.buttons.retry, reply: `/newproject --retry ${job.id}` }] } : undefined)
      .catch((e: Error) => this.#log(`new project: ${e.message}`));
  }

  #pendingAgentDraft(threadKey: string, now = Date.now()): AgentDraft | undefined {
    const draft = this.#state.agentDrafts?.[threadKey];
    if (draft && Date.parse(draft.expiresAt) <= now) {
      delete this.#state.agentDrafts![threadKey];
      return undefined;
    }
    return draft;
  }

  /** Every answer gives the owner the full time again: three questions should not run out of it. */
  async #holdAgentDraft(threadKey: string, draft: Omit<AgentDraft, "expiresAt">): Promise<void> {
    this.#state.agentDrafts ??= {};
    this.#state.agentDrafts[threadKey] = { ...draft, expiresAt: new Date(Date.now() + this.#config.commands.proposalTtlMinutes * 60_000).toISOString() };
    await saveState(this.#state);
  }

  /** The buttons of a question: what fits in a button, then Cancel, which says the owner's «no». */
  #agentChoices(choices: Array<{ label: string; reply: string }>): SendOptions {
    const fits = choices.filter((c) => Buffer.byteLength(c.reply) <= CHOICE_BYTES);
    return { choices: [...fits, { label: this.#m.addAgent.buttons.cancel, reply: this.#m.delivery.noWord }] };
  }

  /**
   * The owner's answer to the question an agent draft is at. True when it was taken (answered, asked again, dropped
   * or made); false lets the message go on to the PM — only at the summary, where anything but yes or no is talk.
   */
  async #agentAnswer(draft: AgentDraft, text: string, projects: readonly Project[], message: IncomingMessage, fromVoice: boolean): Promise<boolean> {
    const L = this.#m.addAgent;
    const project = projects.find((p) => p.id === draft.projectId);
    if (isCancellation(text) || !project || !this.#agents) {
      delete this.#state.agentDrafts![message.threadKey];
      await saveState(this.#state);
      await this.#answer(message, L.dropped, fromVoice);
      return true;
    }
    const answer = text.replace(/\s+/g, " ").trim();
    const { projectId, threadProject } = draft;
    switch (draft.step) {
      case "role": {
        const preset = L.presets.find((p) => p.label.toLowerCase() === answer.toLowerCase());
        const role = (preset?.role ?? answer).slice(0, 200) || null;
        const proposal = preset?.name ?? /[\p{L}\p{N}][\p{L}\p{N}-]*/u.exec(answer)?.[0]?.slice(0, 30);
        const named = proposal ? proposal.charAt(0).toUpperCase() + proposal.slice(1) : undefined;
        await this.#holdAgentDraft(message.threadKey, { projectId, threadProject, step: "name", role, ...(named ? { proposal: named } : {}) });
        await message.reply(redact(L.name(named ?? null)), this.#agentChoices(named ? [{ label: L.buttons.use(named), reply: named }] : []));
        return true;
      }
      case "name": {
        if (!/[\p{L}\p{N}]/u.test(answer) || answer.length > 60) {
          await message.reply(L.badName, this.#agentChoices(draft.proposal ? [{ label: L.buttons.use(draft.proposal), reply: draft.proposal }] : []));
          return true;
        }
        const programs = await this.#agentPrograms();
        if (!programs.length) {
          delete this.#state.agentDrafts![message.threadKey];
          await saveState(this.#state);
          await message.reply(L.noPrograms);
          return true;
        }
        await this.#holdAgentDraft(message.threadKey, { projectId, threadProject, step: "provider", role: draft.role ?? null, name: answer });
        await message.reply(L.program, this.#agentChoices(programs.map((p) => ({ label: p.label, reply: p.id }))));
        return true;
      }
      case "provider": {
        const programs = await this.#agentPrograms();
        const program = programs.find((p) => p.id === answer || p.label.toLowerCase() === answer.toLowerCase());
        if (!program) {
          await message.reply(L.unknownProgram, this.#agentChoices(programs.map((p) => ({ label: p.label, reply: p.id }))));
          return true;
        }
        await this.#holdAgentDraft(message.threadKey, { projectId, threadProject, step: "confirm", role: draft.role ?? null, name: draft.name!, provider: program.id });
        const summary = L.summary(draft.name!, draft.role ?? null, project.config.name, program.label);
        await message.reply(redact(summary), { choices: [{ label: L.buttons.yes, reply: this.#m.delivery.yesWord }, { label: L.buttons.cancel, reply: this.#m.delivery.noWord }] });
        return true;
      }
      case "confirm": {
        if (!isApproval(text)) return false;
        delete this.#state.agentDrafts![message.threadKey];
        await saveState(this.#state);
        await message.reply(redact(L.adding(draft.name!)));
        try {
          const made = await this.#agents.createAgent(project, { name: draft.name, role: draft.role ?? null, provider: draft.provider });
          await message.reply(redact(L.done(made.agent.label, project.config.name)));
        } catch (error) {
          this.#log(`new agent from chat ${project.id}: ${(error as Error).message}`);
          await message.reply(redact(L.failed((error as Error).message)));
        }
        return true;
      }
    }
  }

  async #agentPrograms(): Promise<Array<{ id: string; label: string }>> {
    try {
      return (await this.#agents?.newAgentOptions())?.providers ?? [];
    } catch (error) {
      this.#log(`new agent from chat: ${(error as Error).message}`);
      return [];
    }
  }

  /** Each project's next handoff, one at a time, in the project's own thread; expired ones leave a note. */
  async #showHandoffs(now: Date, quiet: boolean, projects: readonly Project[]): Promise<void> {
    const ms = now.getTime();
    const byId = new Map(projects.map((p) => [p.id, p]));
    const expired = this.#state.handoffs.filter((h) => h.expiresAt !== undefined && Date.parse(h.expiresAt) <= ms);
    if (expired.length) {
      this.#state.handoffs = this.#state.handoffs.filter((h) => !expired.includes(h));
      for (const h of expired) {
        const project = byId.get(h.projectId);
        if (project) await this.#activity(project, this.#m.handoff.expired(displayName(project, h.from), displayName(project, h.to)), { type: "expired", agent: h.from, to: h.to });
      }
    }
    if (quiet) return;
    for (const project of projects) {
      if (isMuted(this.#state, project.id, now) || this.#shownHandoff(project.id, ms) || this.#threadBusy(project.id, ms)) continue;
      const next = this.#state.handoffs.find((h) => h.projectId === project.id && h.expiresAt === undefined);
      if (!next) continue;
      const ttl = this.#config.commands.proposalTtlMinutes;
      const reach = await reachability(project, next.to, this.#exec, { fresh: false });
      const autonomous = projectMode(this.#state, project.id) === "autonomous";
      const braked = autonomous && (this.#state.autoForwarded[project.id]?.length ?? 0) >= this.#config.commands.autoHandoffsPerHour;
      const why = autonomous && looksIrreversible(next.ask) ? `${this.#m.modes.risky}\n\n` : braked ? `${this.#m.modes.braked(this.#config.commands.autoHandoffsPerHour)}\n\n` : "";
      await this.#send(
        project.id,
        why + handoffMessage({ from: badgeName(project, next.from), to: badgeName(project, next.to), projectName: project.config.name, prompt: next.prompt, ttlMinutes: ttl }, reach, this.#lang),
        this.#choices(),
      );
      // Approvable only now that it has been shown.
      next.shownAt = now.toISOString();
      next.expiresAt = new Date(ms + ttl * 60_000).toISOString();
      await saveState(this.#state);
    }
  }

  /**
   * Autonomous projects (D-041): a teammate's ask goes to its teammate by itself, and the owner is told.
   * One that looks irreversible, or any once the daily cap is reached, is left to be shown for a yes.
   * Day or night: agents work at night too; only the notice waits for the morning.
   */
  async #forwardHandoffs(now: Date, quiet: boolean, projects: readonly Project[]): Promise<void> {
    for (const project of projects) {
      if (projectMode(this.#state, project.id) !== "autonomous") continue;
      for (const handoff of this.#state.handoffs.filter((h) => h.projectId === project.id && h.shownAt === undefined)) {
        if (looksIrreversible(handoff.ask)) continue;
        // Per project (D-057): one team in a loop cannot silence the others, and its own handoffs then wait for a yes.
        if (this.#sentToday(project.id) >= this.#config.commands.maxPerDay) break;
        if ((this.#state.autoForwarded[project.id]?.length ?? 0) >= this.#config.commands.autoHandoffsPerHour) break;
        let delivery;
        try {
          delivery = await deliverToAgent(project, handoff.to, handoff.prompt, this.#exec);
        } catch (error) {
          this.#log(`handoff ${handoff.id} not forwarded: ${(error as Error).message}`);
          continue; // left to be shown, and sent on a yes
        }
        this.#state.handoffs = this.#state.handoffs.filter((h) => h !== handoff);
        const at = now.toISOString();
        this.#noteSent(project.id, at);
        (this.#state.autoForwarded[project.id] ??= []).push(at);
        this.#afterDelivery(project, handoff.to, delivery, { text: handoff.prompt, kind: "handoff", handoffFrom: handoff.from }, at);
        await this.#trackTask(project, handoff.to, delivery, { title: handoff.ask, labels: ["handoff"] });
        await saveState(this.#state);
        const from = displayName(project, handoff.from);
        const to = displayName(project, handoff.to);
        await recordDecision(project, { at, by: "pm", text: this.#m.handoff.decision(from, to, handoff.ask), why: this.#m.modes.autoWhy }).catch((e: Error) =>
          this.#log(`could not record the handoff: ${e.message}`),
        );
        this.#log(`${delivery.queued ? "queued" : "forwarded"} handoff ${project.id}/${handoff.from} → ${handoff.to} via ${delivery.via} (autonomous)`);
        const text = `${this.#m.modes.handoffForwarded(badgeName(project, handoff.from), badgeName(project, handoff.to), project.config.name, handoff.ask)}\n${sentMessage(to, project.config.name, delivery, this.#lang)}`;
        await this.#activity(project, text, { type: "handoff", agent: handoff.from, to: handoff.to });
      }
    }
  }

  /** The owner said yes to a teammate's ask: send exactly the shown text, and route the answer back. */
  async #approveHandoff(handoff: PendingHandoff, projects: readonly Project[], message: IncomingMessage, fromVoice: boolean): Promise<void> {
    const m = this.#m.hub;
    this.#state.handoffs = this.#state.handoffs.filter((h) => h !== handoff);
    const project = projects.find((p) => p.id === handoff.projectId);
    if (!project) {
      await saveState(this.#state);
      await this.#answer(message, m.projectGone, fromVoice);
      return;
    }
    const cap = this.#config.commands.maxPerDay;
    if (this.#sentToday(project.id) >= cap) {
      await saveState(this.#state);
      await this.#answer(message, m.capReached(cap, project.config.name), fromVoice);
      return;
    }
    const from = displayName(project, handoff.from);
    const to = displayName(project, handoff.to);
    try {
      const delivery = await deliverToAgent(project, handoff.to, handoff.prompt, this.#exec);
      const at = new Date().toISOString();
      this.#noteSent(project.id, at);
      this.#afterDelivery(project, handoff.to, delivery, { text: handoff.prompt, kind: "handoff", handoffFrom: handoff.from }, at);
      await this.#trackTask(project, handoff.to, delivery, { title: handoff.ask, labels: ["handoff"] });
      await saveState(this.#state);
      await recordDecision(project, { at, by: "user", text: this.#m.handoff.decision(from, to, handoff.ask), why: m.instructionWhy(handoff.prompt) }).catch((e: Error) =>
        this.#log(`could not record the handoff: ${e.message}`),
      );
      this.#log(`${delivery.queued ? "queued" : "sent"} handoff ${project.id}/${handoff.from} → ${handoff.to} via ${delivery.via}`);
      const sent = sentMessage(to, project.config.name, delivery, this.#lang);
      await this.#activity(project, `${this.#m.handoff.decision(from, to, handoff.ask)}\n${sent}`, { type: "handoff", agent: handoff.from, to: handoff.to });
      await this.#answer(message, sent, fromVoice);
    } catch (error) {
      this.#log(`sending failed: ${(error as Error).message}`);
      await message.reply(m.sendFailed);
    }
  }

  /** The owner tells the PM who does what; every agent of the project hears it at its next session. */
  async #setRole(projects: readonly Project[], input: { project: string; agent: string; role: string }): Promise<{ content: string; isError?: boolean }> {
    const wanted = input.project.trim().toLowerCase();
    const project =
      projects.find((p) => p.id === wanted || p.config.name.toLowerCase() === wanted) ??
      projects.find((p) => p.id.includes(wanted) || p.config.name.toLowerCase().includes(wanted));
    if (!project) return { content: `No project "${input.project}". Known: ${projects.map((p) => p.id).join(", ")}`, isError: true };
    const agent = findAgentByName(project, input.agent);
    if (!agent) return { content: `No agent "${input.agent}" in ${project.id}. Known: ${project.config.agents.map((a) => a.id).join(", ") || "none yet"}`, isError: true };
    const role = input.role.trim().slice(0, 200);
    if (role) agent.role = role;
    else delete agent.role;
    await saveProject(project.root, project.config);
    return { content: role ? `${displayName(project, agent.id)} (${project.id}) now has the role «${role}». Its teammates learn it at their next session.` : `Role of ${agent.id} removed.` };
  }

  /** The project's office as a picture, with who is who under it; text alone where pictures cannot go. */
  async #office(project: Project | undefined, message: IncomingMessage): Promise<void> {
    const m = this.#m.office;
    if (!project) {
      await message.reply(m.whichProject);
      return;
    }
    const model = await projectOffice(project, this.#state, this.#exec);
    if (!model.agents.length) {
      await message.reply(m.noAgents(project.config.name));
      return;
    }
    const lines = [
      m.title(project.config.name),
      ...model.agents.map((a) => `${badgeName(project, a.id)} — ${m.states[a.state]}`),
      ...model.handoffs.map((h) => m.handoff(displayName(project, h.from), displayName(project, h.to), this.#state.handoffs.find((x) => x.from === h.from && x.to === h.to && x.projectId === project.id)?.ask ?? "")),
    ];
    const caption = redact(lines.join("\n"));
    if (message.replyImage) await message.replyImage({ bytes: officePng(model), caption });
    else await message.reply(caption);
  }

  #speakMode(): "mirror" | "always" | "never" {
    return this.#state.speak ?? this.#config.voice.speak.mode;
  }

  #quietHoursEnabled(): boolean {
    return this.#state.quietHoursEnabled ?? this.#config.notify.quietHours.enabled;
  }

  /** `mirror`: a voice note gets a voice note back. `always`: every reply does. */
  #shouldSpeak(askedByVoice: boolean): boolean {
    if (!this.#synthesizer) return false;
    const mode = this.#speakMode();
    return mode === "always" || (mode === "mirror" && askedByVoice);
  }

  /** Synthesize speech for an answer; null if it can't — the text already went out. */
  async #speak(text: string, projectId: string | null): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (!this.#synthesizer) return null;
    const speak = this.#config.voice.speak;
    const script = redact(spokenText(text, { maxChars: speak.maxChars, language: this.#lang }));
    if (!script) return null;
    try {
      const audio = await this.#synthesizer.synthesize(script);
      await recordSpend({
        at: new Date().toISOString(),
        provider: this.#synthesizer.id,
        model: audio.model,
        costUsd: audio.costUsd,
        inputTokens: audio.characters,
        outputTokens: 0,
        cacheReadTokens: 0,
        purpose: "voice",
        ...(projectId ? { project: projectId } : {}),
      });
      return { bytes: audio.bytes, mime: audio.mime };
    } catch (error) {
      this.#log(`speech synthesis failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Turn a voice note into the question it asks. The transcript is always shown
   * back first, and a doubtful one is not answered at all: a confident answer
   * to a misheard question is worse than asking again.
   */
  async #hear(message: IncomingMessage): Promise<string | null> {
    const m = this.#m.hub;
    const audio = message.audio!;
    const voice = this.#config.voice;
    if (!this.#transcriber) {
      await message.reply(m.noTranscriber);
      return null;
    }
    if (audio.durationSec > voice.maxSeconds) {
      await message.reply(m.voiceTooLong(audio.durationSec, voice.maxSeconds));
      return null;
    }
    await message.typing().catch(() => undefined);
    try {
      const projects = await this.#chatProjects();
      const keyterms = [...projects.flatMap((p) => [p.config.name, p.id]), "Leftoff", "Claude", "Codex", "Paseo"];
      const transcript = await this.#transcriber.transcribe(await audio.download(), { keyterms });
      await recordSpend({
        at: new Date().toISOString(),
        provider: this.#transcriber.id,
        model: transcript.model,
        costUsd: transcript.costUsd,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        purpose: "voice",
        ...(message.projectId ? { project: message.projectId } : {}),
      });
      if (!transcript.text) {
        await message.reply(m.heardNothing);
        return null;
      }
      if (transcript.confidence < voice.minConfidence) {
        await message.reply(m.notSure(transcript.text));
        return null;
      }
      await message.reply(redact(`🎙️ «${transcript.text}»`));
      return transcript.text;
    } catch (error) {
      this.#log(`transcription failed: ${(error as Error).message}`);
      await message.reply(m.transcribeFailed);
      return null;
    }
  }

  async #mute(projectId: string, hours: number): Promise<string> {
    const until = new Date(Date.now() + hours * 3_600_000);
    this.#state.mutes[projectId] = until.toISOString();
    await saveState(this.#state);
    return `${projectId} muted until ${this.#when(until)}`;
  }

  /** A moment in the owner's own convention, e.g. "sab 14:30". */
  #when(date: Date): string {
    return date.toLocaleString(LOCALES[this.#lang], { timeZone: this.#config.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" });
  }

  async #command(name: string, args: string, message: IncomingMessage): Promise<void> {
    const m = this.#m.hub;
    const projects = await this.#chatProjects();
    const target = args.trim().split(/\s+/)[0] || message.projectId || "";
    const project = projects.find((p) => p.id === target || p.config.name.toLowerCase() === target.toLowerCase());

    switch (canonicalCommand(name)) {
      case "mute": {
        if (!project) {
          await message.reply(m.whichProjectMute);
          return;
        }
        const hours = Number(args.trim().split(/\s+/)[1]) || 24;
        await this.#mute(project.id, hours);
        await message.reply(m.muted(project.config.name, this.#when(new Date(this.#state.mutes[project.id]!))));
        return;
      }
      case "unmute": {
        if (project) delete this.#state.mutes[project.id];
        await saveState(this.#state);
        await message.reply(m.unmuted(project?.config.name ?? null));
        return;
      }
      case "overview":
        await message.reply(redact(await this.standup(projects)));
        return;
      case "office":
        await this.#office(project, message);
        return;
      case "newproject": {
        const L = this.#m.newProject;
        const retry = /^--retry\s+(\S+)$/.exec(args.trim());
        if (retry) return this.#retryProject(retry[1]!, message);
        if (!args.trim() || !this.#projects) {
          await message.reply(L.usage);
          return;
        }
        if (this.#approvableIn(message)) {
          await message.reply(L.busy);
          return;
        }
        const made = await this.#projectDraft(args, "");
        await message.reply(redact(made.text), made.ready ? this.#choices() : undefined);
        if (made.ready) await this.#holdProjectDraft(message, args, "");
        return;
      }
      case "newagent": {
        const wanted = args.trim() || message.projectId || "";
        const where = projects.find((p) => p.id === wanted || p.config.name.toLowerCase() === wanted.toLowerCase());
        if (!where || !this.#agents) {
          await message.reply(this.#m.addAgent.usage);
          return;
        }
        if (this.#approvableIn(message)) {
          await message.reply(this.#m.newProject.busy);
          return;
        }
        await this.#holdAgentDraft(message.threadKey, { projectId: where.id, threadProject: message.projectId, step: "role" });
        await message.reply(redact(this.#m.addAgent.role(where.config.name)), this.#agentChoices(this.#m.addAgent.presets.map((p) => ({ label: p.label, reply: p.label }))));
        return;
      }
      case "quiet": {
        const choice = args.trim().toLowerCase();
        if (ON.has(choice)) this.#state.quietHoursEnabled = true;
        else if (OFF.has(choice)) this.#state.quietHoursEnabled = false;
        if (choice) await saveState(this.#state);
        const enabled = this.#quietHoursEnabled();
        const { start, end } = this.#config.notify.quietHours;
        await message.reply(enabled ? m.quietOn(start, end) : m.quietOff);
        return;
      }
      case "resume": {
        const words = args.trim().split(/\s+/).filter(Boolean);
        const namedProject = projects.find((p) => p.id === words[0] || p.config.name.toLowerCase() === words[0]?.toLowerCase());
        const resumeProject = namedProject ?? projects.find((p) => p.id === message.projectId);
        if (!resumeProject) {
          await message.reply(m.whichProjectResume);
          return;
        }
        const wantedAgent = words[namedProject ? 1 : 0];
        const agent = wantedAgent
          ? findAgentByName(resumeProject, wantedAgent)
          : resumeProject.config.agents.length === 1 ? resumeProject.config.agents[0] : undefined;
        if (!agent) {
          await message.reply(m.whichAgentResume(resumeProject.id, resumeProject.config.agents.map((a) => a.id).join("|")));
          return;
        }
        const delivery = await deliverToAgent(resumeProject, agent.id, m.manualResumeInstruction, this.#exec);
        const at = new Date().toISOString();
        this.#afterDelivery(resumeProject, agent.id, delivery, { text: m.manualResumeInstruction, kind: "command" }, at);
        await saveState(this.#state);
        await recordDecision(resumeProject, {
          at,
          by: "user",
          text: `${m.manualResumeDecision} ${displayName(resumeProject, agent.id)}`,
          why: delivery.via,
        }).catch((e: Error) => this.#log(`could not record manual restart: ${e.message}`));
        await message.reply(
          delivery.via === "paseo"
            ? m.resumeAsked(displayName(resumeProject, agent.id), resumeProject.config.name)
            : m.resumeQueued(displayName(resumeProject, agent.id), resumeProject.config.name),
        );
        return;
      }
      case "voice": {
        const choice = args.trim().toLowerCase();
        if (!this.#synthesizer) {
          await message.reply(m.voiceUnavailable);
          return;
        }
        if (VOICE_MODES[choice]) {
          this.#state.speak = VOICE_MODES[choice]!;
          await saveState(this.#state);
        }
        await message.reply(m.voiceStatus(m.voiceLabel(this.#speakMode())));
        return;
      }
      case "alerts": {
        const chosen = alertLevel(args.trim().split(/\s+/)[0] ?? "");
        if (args.trim() && !chosen) {
          await message.reply(m.alertsUnknown);
          return;
        }
        if (chosen) {
          this.#state.notifyLevel = chosen;
          await saveState(this.#state);
        }
        await message.reply(m.alertsStatus(this.#level()));
        return;
      }
      case "language": {
        const chosen = parseLanguage(args.trim().split(/\s+/)[0] ?? "");
        if (args.trim() && !chosen) {
          await message.reply(m.languageUnknown(languageOptions()));
          return;
        }
        if (chosen) {
          this.#state.language = chosen;
          await saveState(this.#state);
        }
        // Said in the language just chosen: that is the proof it worked.
        await message.reply(this.#m.hub.languageNow(this.#m.name, languageOptions()));
        return;
      }
      default:
        await message.reply(m.help);
    }
  }
}

/** Each project's times, keeping those after `since`; a project with none left is dropped. */
function recent(byProject: Record<string, string[]>, since: number): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, times] of Object.entries(byProject)) {
    const kept = times.filter((at) => Date.parse(at) > since);
    if (kept.length) out[id] = kept;
  }
  return out;
}

/**
 * An agent's question with options comes with one button per option: a tap says the option for the owner, naming the
 * agent, so the PM knows whose question it answers and the owner never retypes it. Its recommendation is starred.
 */
export function optionChoices(report: Report, agentName: string): SendOptions | undefined {
  const q = report.question;
  if (!q?.options.length) return undefined;
  return {
    choices: q.options.slice(0, 6).map((option) => ({
      label: `${option === q.recommend ? "★ " : ""}${option.length > 60 ? `${option.slice(0, 59)}…` : option}`,
      reply: `${agentName}: ${option}`,
    })),
  };
}
