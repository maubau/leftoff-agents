import type { Channel, IncomingMessage, SendOptions } from "../channels/channel.ts";
import type { Config, NotifyLevel } from "../core/config.ts";
import { loadProject, saveProject, tryResolveProject, type Project } from "../core/project.ts";
import { latestReport, readReports, type Report } from "../core/report.ts";
import { buildSnapshot } from "../core/snapshot.ts";
import { recordSpend, spentSince } from "../pm/ledger.ts";
import { askPm } from "../pm/pm.ts";
import { createTasksAction, removeTasksAction } from "../pm/tasks.ts";
import type { ModelProvider } from "../pm/provider.ts";
import { askLive, deliverToAgent, deliverToSession, findPaseoAgent, listPaseoAgents, reachability, sendViaPaseo, type Delivery, type ExecFn } from "../agents/delivery.ts";
import { enqueue } from "../core/inbox.ts";
import { recordDecision } from "../core/decisions.ts";
import { isApproval, isCancellation } from "./approval.ts";
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
import { draftMessage, handoffMessage, reportMessage, sentMessage, standupMessage, unreportedMessage } from "./messages.ts";
import { redact } from "./redact.ts";
import { looksIrreversible } from "./autonomy.ts";
import { emptyState, isMuted, loadState, projectMode, saveState, type HubState, type PendingHandoff, type ProjectMode, type Proposal, type QueuedDelivery, type ResumeTarget } from "./state.ts";
import { acknowledge, scan, watchedProjects, type HubEvent } from "./watcher.ts";
import { projectOffice } from "../office/model.ts";
import { officePng } from "../office/render.ts";

/** Statuses worth waking the owner for after quiet hours; the rest wait for the stand-up. */
const URGENT = new Set(["blocked", "needs_input"]);
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

  constructor(options: HubOptions) {
    this.#config = options.config;
    this.#channel = options.channel;
    this.#provider = options.provider;
    this.#transcriber = options.transcriber;
    this.#synthesizer = options.synthesizer;
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
    this.#deliveryTimer = setInterval(() => void this.flushDeliveries().catch((e: Error) => this.#log(`delivery queue error: ${e.message}`)), 15_000);
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

  async #send(projectId: string | null, text: string, options?: SendOptions): Promise<void> {
    await this.#channel.send(projectId, redact(text), options);
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
    if (isMuted(this.#state, event.project.id, now)) return;
    let text =
      event.kind === "report" ? reportMessage(event.report, lang, badgeName(event.project, event.report.agent)) : unreportedMessage(event.branch, event.commits, lang);
    const isReply = event.kind === "report" && event.reply === true;
    if (isReply && event.kind === "report") {
      const key = `${event.project.id}:${event.report.agent}`;
      const status = this.#state.statusAsked[key] !== undefined && this.#state.statusAsked[key] === this.#state.awaiting[key];
      const who = displayName(event.project, event.report.agent);
      const asker = this.#state.handoffReplies[key];
      delete this.#state.handoffReplies[key];
      const head = asker ? this.#m.handoff.reply(who, displayName(event.project, asker)) : status ? this.#m.hub.replyStatus(who) : this.#m.hub.replyInstruction(who);
      text = `↩️ ${head}:\n${text}`;
    }
    // What the event is worth, from the owner's point of view. Something that needs them, or the answer to
    // what they asked, is critical; finished work is news; commits nobody reported and the answers to
    // the PM's own automatic questions are detail — the control panel has all of it.
    const waiting = event.kind === "report" && URGENT.has(event.report.status);
    const askedByHub = event.kind === "report" && this.#state.statusAskedBy[`${event.project.id}:${event.report.agent}`] === "auto";
    const need: NotifyLevel = event.kind === "unreported" ? "all" : waiting ? "critical" : isReply ? (askedByHub ? "normal" : "critical") : "normal";
    if (!this.#wants(need)) {
      await this.#hold(event.project.id, text);
      return;
    }
    const urgent = isReply || event.kind === "unreported" || URGENT.has(event.report.status);
    if (quiet) {
      // Quiet hours: blockers wait for the morning, everything else for the stand-up.
      if (urgent) this.#state.queued.push({ projectId: event.project.id, text, at: now.toISOString() });
      return;
    }
    await this.#send(event.project.id, text);
    this.#log(`sent ${event.kind} for ${event.project.id}`);
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

    await message.typing().catch(() => undefined);
    // What went out in an autonomous project during this turn: told to the owner even if the model fails afterwards.
    const sent: string[] = [];
    try {
      const history = await recentTurns(message.threadKey);
      let proposed: Proposal | undefined;
      let modeAsked: string | undefined;
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
                      sent.push(await this.#sendInstruction(target, { ...made.proposal, ...(handoffFrom ? { handoffFrom } : {}) }, "pm"));
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
        },
      });
      const sentNote = sent.join("\n");
      const waits = proposed;
      const block = waits ? [waits.hold ? this.#m.modes[waits.hold] : "", await this.#draftBlock(waits, projects)].filter(Boolean).join("\n\n") : "";
      // A mode question and a draft in one reply would make «sì» ambiguous: the draft wins.
      const modeQuestion = modeAsked && !waits ? projects.find((p) => p.id === modeAsked) : undefined;
      const question = modeQuestion ? this.#m.modes.confirm(modeQuestion.config.name) : "";
      await message.reply(redact([result.text, sentNote, block, question, ...result.notices].filter(Boolean).join("\n\n")), waits || modeQuestion ? this.#choices() : undefined);
      // Only now is the draft approvable: the owner has been shown exactly this text. A model
      // failure above, or a reply that never went out, leaves nothing a stray «sì» could send.
      if (waits) await this.#commitDraft(message.threadKey, waits, message.projectId);
      if (modeQuestion) {
        this.#state.modeRequests[message.threadKey] = { projectId: modeQuestion.id, expiresAt: new Date(Date.now() + this.#config.commands.proposalTtlMinutes * 60_000).toISOString() };
        await saveState(this.#state);
      }
      // The text always goes first and always goes whole; the voice is the gist on top.
      if (!result.skipped && message.replyVoice && this.#shouldSpeak(fromVoice)) {
        const ask = waits || modeQuestion ? this.#m.hub.sayYesToSend : "";
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

  /** Daily ceiling bookkeeping and stale drafts; cheap, once per tick. */
  #housekeeping(now: Date): void {
    const dayAgo = now.getTime() - 86_400_000;
    this.#state.sent = this.#state.sent.filter((at) => Date.parse(at) > dayAgo);
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
    // Autonomous (D-041): what the owner asked for goes out at once, unless it looks irreversible —
    // to the PM or to the fixed check in code, either is enough — or the daily cap is reached.
    if (projectMode(this.#state, project.id) === "autonomous") {
      if (input.irreversible !== false || looksIrreversible(prompt)) proposal.hold = "risky";
      else if (input.ownerAsked !== true) proposal.hold = "initiative";
      else if (this.#state.sent.length < this.#config.commands.maxPerDay) {
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
  async #sendInstruction(project: Project, draft: Proposal, by: "user" | "pm"): Promise<string> {
    const m = this.#m.hub;
    const delivery = await deliverToAgent(project, draft.agentId, draft.prompt, this.#exec);
    const at = new Date().toISOString();
    this.#state.sent.push(at);
    this.#afterDelivery(project, draft.agentId, delivery, { text: draft.prompt, kind: draft.handoffFrom ? "handoff" : "command", ...(draft.handoffFrom ? { handoffFrom: draft.handoffFrom } : {}), notify: true }, at);
    await saveState(this.#state);
    await recordDecision(project, {
      at,
      by,
      text: m.instructionDecision(displayName(project, draft.agentId), draft.summary),
      why: by === "pm" ? `${this.#m.modes.autoWhy}. ${m.instructionWhy(draft.prompt)}` : m.instructionWhy(draft.prompt),
    }).catch((e: Error) => this.#log(`could not record the decision: ${e.message}`));
    this.#log(`${delivery.queued ? "queued" : "sent"} instruction to ${project.id}/${draft.agentId} via ${delivery.via}${by === "pm" ? " (autonomous)" : ""}`);
    return sentMessage(displayName(project, draft.agentId), project.config.name, delivery, this.#lang);
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

    const reach = await reachability(project, agent.id, this.#exec);
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
      this.#queueDelivery(project, agent.id, { text: question, kind: "status", notify: false }, iso);
    } else {
      this.#contact(project.id, agent.id, "status");
    }
    this.#state.statusAsked[key] = iso;
    this.#state.statusAskedBy[key] = source;
    this.#state.asks.push(iso);
    await saveState(this.#state);
    return {
      content: sent.queued
        ? `${label} is working, so the question waits until its current turn ends — it is not interrupted — and is dropped if that turn ends with a report anyway. Its next report reaches the owner automatically; tell them so.`
        : `Asked ${label} for a status report (it was idle: this starts a short turn). Its next report reaches the owner automatically; tell them you asked.`,
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
    this.#contact(project.id, agentId, item.kind);
    this.#state.awaiting[key] = at;
    if (item.handoffFrom) this.#state.handoffReplies[key] = item.handoffFrom;
  }

  #queueDelivery(project: Project, agentId: string, item: Omit<QueuedDelivery, "id" | "projectId" | "agentId" | "paseoAgent" | "queuedAt">, at: string): void {
    const paseoAgent = project.config.agents.find((a) => a.id === agentId)?.paseoAgent;
    if (!paseoAgent) return;
    this.#state.deliveryQueue.push({ id: Math.random().toString(36).slice(2, 10), projectId: project.id, agentId, paseoAgent, queuedAt: at, ...item });
    this.#log(`queued ${item.kind} for ${project.id}/${agentId}: it is working, and will not be interrupted`);
  }

  /**
   * Deliver what waited for an agent to finish its turn (D-042): to an idle agent it starts a new turn, never
   * interrupting one. A status question its own report has since answered is dropped; an agent whose session
   * closed gets instructions in its inbox. Runs every 15 seconds and at each tick; cheap when nothing waits.
   */
  async flushDeliveries(now = new Date()): Promise<void> {
    if (this.#flushing || this.#state.deliveryQueue.length === 0) return;
    this.#flushing = true;
    try {
      const agents = await listPaseoAgents(this.#exec);
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
        if (item.notify) {
          const text = this.#m.delivery.delivered(displayName(project, item.agentId), project.config.name, via === "paseo");
          const quiet = this.#quietHoursEnabled() && inQuietHours(now, this.#config.timezone, this.#config.notify.quietHours);
          if (isMuted(this.#state, project.id, now)) await this.#hold(project.id, text);
          else if (quiet) this.#state.queued.push({ projectId: project.id, text, at });
          else await this.#send(project.id, text);
        }
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
    const reach = await reachability(project, proposal.agentId, this.#exec);
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
    if (this.#state.sent.length >= cap) {
      await saveState(this.#state);
      await this.#answer(message, m.capReached(cap), fromVoice);
      return;
    }
    try {
      await this.#answer(message, await this.#sendInstruction(project, draft, "user"), fromVoice);
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
    return Object.values(this.#state.proposals).some((p) => p.threadProject === projectId && Date.parse(p.expiresAt) > now);
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
        if (project) await this.#hold(project.id, this.#m.handoff.expired(displayName(project, h.from), displayName(project, h.to)));
      }
    }
    if (quiet) return;
    for (const project of projects) {
      if (isMuted(this.#state, project.id, now) || this.#shownHandoff(project.id, ms) || this.#threadBusy(project.id, ms)) continue;
      const next = this.#state.handoffs.find((h) => h.projectId === project.id && h.expiresAt === undefined);
      if (!next) continue;
      const ttl = this.#config.commands.proposalTtlMinutes;
      const reach = await reachability(project, next.to, this.#exec);
      const why = projectMode(this.#state, project.id) === "autonomous" && looksIrreversible(next.ask) ? `${this.#m.modes.risky}\n\n` : "";
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
        if (this.#state.sent.length >= this.#config.commands.maxPerDay) return;
        let delivery;
        try {
          delivery = await deliverToAgent(project, handoff.to, handoff.prompt, this.#exec);
        } catch (error) {
          this.#log(`handoff ${handoff.id} not forwarded: ${(error as Error).message}`);
          continue; // left to be shown, and sent on a yes
        }
        this.#state.handoffs = this.#state.handoffs.filter((h) => h !== handoff);
        const at = now.toISOString();
        this.#state.sent.push(at);
        this.#afterDelivery(project, handoff.to, delivery, { text: handoff.prompt, kind: "handoff", handoffFrom: handoff.from, notify: true }, at);
        await saveState(this.#state);
        const from = displayName(project, handoff.from);
        const to = displayName(project, handoff.to);
        await recordDecision(project, { at, by: "pm", text: this.#m.handoff.decision(from, to, handoff.ask), why: this.#m.modes.autoWhy }).catch((e: Error) =>
          this.#log(`could not record the handoff: ${e.message}`),
        );
        this.#log(`${delivery.queued ? "queued" : "forwarded"} handoff ${project.id}/${handoff.from} → ${handoff.to} via ${delivery.via} (autonomous)`);
        const text = `${this.#m.modes.handoffForwarded(badgeName(project, handoff.from), badgeName(project, handoff.to), project.config.name, handoff.ask)}\n${sentMessage(to, project.config.name, delivery, this.#lang)}`;
        if (isMuted(this.#state, project.id, now)) await this.#hold(project.id, text);
        else if (quiet) this.#state.queued.push({ projectId: project.id, text, at });
        else await this.#send(project.id, text);
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
    if (this.#state.sent.length >= cap) {
      await saveState(this.#state);
      await this.#answer(message, m.capReached(cap), fromVoice);
      return;
    }
    const from = displayName(project, handoff.from);
    const to = displayName(project, handoff.to);
    try {
      const delivery = await deliverToAgent(project, handoff.to, handoff.prompt, this.#exec);
      const at = new Date().toISOString();
      this.#state.sent.push(at);
      this.#afterDelivery(project, handoff.to, delivery, { text: handoff.prompt, kind: "handoff", handoffFrom: handoff.from, notify: true }, at);
      await saveState(this.#state);
      await recordDecision(project, { at, by: "user", text: this.#m.handoff.decision(from, to, handoff.ask), why: m.instructionWhy(handoff.prompt) }).catch((e: Error) =>
        this.#log(`could not record the handoff: ${e.message}`),
      );
      this.#log(`${delivery.queued ? "queued" : "sent"} handoff ${project.id}/${handoff.from} → ${handoff.to} via ${delivery.via}`);
      await this.#answer(message, sentMessage(to, project.config.name, delivery, this.#lang), fromVoice);
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
        this.#afterDelivery(resumeProject, agent.id, delivery, { text: m.manualResumeInstruction, kind: "command", notify: false }, at);
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
