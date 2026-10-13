import { randomUUID } from "node:crypto";
import { NAME_MAX, NewProjectError, STEPS, paseoAnswers, planProject, projectsRoot, runStep, type NewProjectPlan, type RunFn } from "../commands/new-project.ts";
import type { Config } from "../core/config.ts";
import { THEME_COUNT, settleThemes } from "../web/themes.ts";
import type { HubState, ProjectJob } from "./state.ts";
import { watchedProjects } from "./watcher.ts";

const KEEP = 20;
const KEEP_MS = 7 * 86_400_000;
const PURPOSE_MAX = 200;

export interface ProjectJobsOptions {
  config: Pick<Config, "projects">;
  /** The hub's state, where jobs and themes live; `save` writes it. */
  state: () => HubState;
  save: () => Promise<void>;
  /** Told at every change of a job, for the panel's live event. */
  onChange?: (job: ProjectJob) => void;
  run?: RunFn;
  log?: (line: string) => void;
}

/**
 * New projects being made (D-056): one job per creation, its five steps run in order and saved after each, so the
 * panel, another browser and chat all see the same progress. A failed step stops the job; a retry resumes there.
 */
export class ProjectJobs {
  readonly #o: ProjectJobsOptions;
  readonly #running = new Map<string, Promise<void>>();

  constructor(options: ProjectJobsOptions) {
    this.#o = options;
    // A job the hub was running when it stopped did not finish: its step failed, and can be retried.
    for (const job of this.#jobs()) {
      if (job.status !== "running") continue;
      job.status = "failed";
      for (const step of job.steps) {
        if (step.status === "running") Object.assign(step, { status: "failed", retryable: true, error: { type: "failed", message: "the hub stopped while this step ran" } });
      }
    }
  }

  get root(): string {
    return projectsRoot(this.#o.config);
  }

  async options(): Promise<{ nameMax: number; root: string; paseo: "available" | "unavailable"; themes: number }> {
    return { nameMax: NAME_MAX, root: this.root, paseo: (await paseoAnswers(this.#o.run)) ? "available" : "unavailable", themes: THEME_COUNT };
  }

  /** What the name would make, or a NewProjectError saying why not. Nothing is created. */
  async check(name: unknown): Promise<{ ok: true; id: string; folder: string }> {
    const plan = await this.#plan(name);
    return { ok: true, id: plan.id, folder: plan.folder };
  }

  async #plan(name: unknown): Promise<NewProjectPlan> {
    const plan = await planProject(name, this.root);
    if (this.#jobs().some((j) => j.projectId === plan.id && j.status !== "done")) {
      throw new NewProjectError("exists", "a project with that name is being made", { existing: { kind: "project", id: plan.id } });
    }
    return plan;
  }

  /** Start making a project; the answer comes at once, the steps follow (watch `onChange`, or `settled`). */
  async start(input: { name: unknown; purpose?: unknown }, origin: ProjectJob["origin"]): Promise<ProjectJob> {
    const plan = await this.#plan(input.name);
    const purpose = typeof input.purpose === "string" ? input.purpose.replace(/\s+/g, " ").trim().slice(0, PURPOSE_MAX) : "";
    const job: ProjectJob = {
      id: randomUUID(),
      name: plan.name,
      projectId: plan.id,
      folder: plan.folder,
      ...(purpose ? { purpose } : {}),
      origin,
      status: "running",
      steps: STEPS.map((id) => ({ id, status: "pending", retryable: false })),
      startedAt: new Date().toISOString(),
    };
    const state = this.#o.state();
    state.projectJobs = [job, ...this.#jobs()].slice(0, KEEP);
    await this.#changed(job);
    this.#launch(job);
    return job;
  }

  /** Resume a stopped job from the step that failed; what worked is not redone. */
  async retry(id: string): Promise<ProjectJob> {
    const job = this.get(id);
    if (!job) throw new NewProjectError("failed", "no such creation");
    if (job.status === "running" || this.#running.has(id)) return job;
    if (job.status === "done") return job;
    const failed = job.steps.find((s) => s.status === "failed");
    if (!failed?.retryable) throw new NewProjectError("failed", "this creation cannot be retried");
    job.status = "running";
    for (const step of job.steps) {
      if (step.status === "failed") {
        step.status = "pending";
        delete step.error;
        step.retryable = false;
      }
    }
    delete job.endedAt;
    await this.#changed(job);
    this.#launch(job);
    return job;
  }

  /** The last creations, newest first: at most 20, none older than a week. */
  list(): ProjectJob[] {
    const since = Date.now() - KEEP_MS;
    return this.#jobs().filter((j) => j.status === "running" || Date.parse(j.startedAt) > since);
  }

  get(id: string): ProjectJob | undefined {
    return this.#jobs().find((j) => j.id === id);
  }

  creationOf(projectId: string): Creation | undefined {
    return creationOf(this.#jobs(), projectId);
  }

  /** Resolves when the job's current run ends (for tests and for chat, which tells the end). */
  async settled(id: string): Promise<ProjectJob | undefined> {
    await this.#running.get(id);
    return this.get(id);
  }

  #jobs(): ProjectJob[] {
    const state = this.#o.state();
    state.projectJobs ??= [];
    return state.projectJobs;
  }

  #launch(job: ProjectJob): void {
    const run = this.#run(job).finally(() => this.#running.delete(job.id));
    this.#running.set(job.id, run);
  }

  async #run(job: ProjectJob): Promise<void> {
    const ctx = { id: job.projectId, name: job.name, folder: job.folder, root: this.root, purpose: job.purpose, ...(this.#o.run ? { run: this.#o.run } : {}) };
    for (const step of job.steps) {
      if (step.status === "done") continue;
      step.status = "running";
      await this.#changed(job);
      try {
        // Before the project joins the registry, every room keeps the theme it has today; then this one gets its own.
        if (step.id === "registry") await this.#settleTheme(job);
        await runStep(step.id, ctx);
        step.status = "done";
      } catch (error) {
        const e = error instanceof NewProjectError ? error : new NewProjectError("failed", (error as Error).message);
        step.status = "failed";
        step.error = { type: e.type, message: e.message, ...(e.detail ? { detail: e.detail } : {}) };
        // An existing folder or project will still be there: retrying cannot help. Anything else may.
        step.retryable = e.type !== "exists";
        job.status = "failed";
        job.endedAt = new Date().toISOString();
        this.#o.log?.(`new project ${job.projectId}: ${step.id} failed: ${e.message}`);
        await this.#changed(job);
        return;
      }
    }
    job.status = "done";
    job.endedAt = new Date().toISOString();
    await this.#changed(job);
  }

  async #settleTheme(job: ProjectJob): Promise<void> {
    const state = this.#o.state();
    state.themes ??= {};
    const visible = (await watchedProjects()).filter((p) => p.config.visibility !== "private").map((p) => p.id);
    settleThemes(state.themes, visible);
    settleThemes(state.themes, [job.projectId]);
    job.theme = state.themes[job.projectId]!;
  }

  async #changed(job: ProjectJob): Promise<void> {
    await this.#o.save().catch((e: Error) => this.#o.log?.(`could not save a creation: ${e.message}`));
    this.#o.onChange?.(job);
  }
}

export interface Creation {
  jobId: string;
  status: ProjectJob["status"];
  step: string;
}

/** For a project not completely made: which creation, and the step it stopped at or is running. */
export function creationOf(jobs: readonly ProjectJob[], projectId: string): Creation | undefined {
  const job = jobs.find((j) => j.projectId === projectId);
  if (!job || job.status === "done") return undefined;
  const at = job.steps.find((s) => s.status === "failed" || s.status === "running") ?? job.steps.find((s) => s.status === "pending");
  return { jobId: job.id, status: job.status, step: at?.id ?? "paseo" };
}
