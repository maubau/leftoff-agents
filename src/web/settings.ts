import { archiveWorkspace, createWorkspace, paseoProviders, renameWorkspace, startAgent, type PaseoProvider } from "../agents/create.ts";
import type { ExecFn } from "../agents/delivery.ts";
import { agentRuntimes, canSetModel, findRuntime, providerModels, setAgentModel, setAgentThinking, type AgentModel } from "../agents/models.ts";
import { agentForWorkspace, ensureAgent, paseoWorkspaces } from "../core/agents.ts";
import { loadConfig, saveConfig, type Config } from "../core/config.ts";
import { loadProject, saveProject, type Project } from "../core/project.ts";
import { messages } from "../i18n/index.ts";
import { PM_EFFORTS, PM_MODELS, type PmEffort } from "../pm/models.ts";

/** Why a change was refused: `status` is what the panel's HTTP answer carries. */
export class SettingsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PmSettings {
  provider: Config["pm"]["provider"];
  model: string;
  effort: PmEffort;
  /** Empty for a non-Anthropic PM: its model is whatever its server calls it, set in config.yaml. */
  models: Array<{ id: string; label: string }>;
  efforts: readonly PmEffort[];
}

export interface AgentSettings {
  id: string;
  label: string;
  /** False when Paseo does not run it, or does not answer: then nothing below can be changed here. */
  reachable: boolean;
  reason?: string;
  provider?: string;
  model?: string | null;
  thinking?: string | null;
  models?: AgentModel[];
  canSetModel?: boolean;
  canSetThinking?: boolean;
}

/** What the panel offers when the owner adds an agent: the providers it can run on, each with its models. */
export interface NewAgentOptions {
  providers: Array<PaseoProvider & { models: AgentModel[] }>;
}

const NAME_MAX = 60;
const ROLE_MAX = 200;
const TASK_MAX = 4000;

/** A name the owner typed: one line, trimmed, with something in it a person would read. */
function cleanName(value: unknown): string {
  if (typeof value !== "string") throw new SettingsError(400, "the name is missing");
  const name = value.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(name) || name.length > NAME_MAX) throw new SettingsError(400, `the name must have letters or digits, up to ${NAME_MAX} characters`);
  return name;
}

function cleanRole(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new SettingsError(400, "the role must be text");
  const role = value.replace(/\s+/g, " ").trim();
  if (role.length > ROLE_MAX) throw new SettingsError(400, `the role is longer than ${ROLE_MAX} characters`);
  return role || null;
}

export interface SettingsOptions {
  /** The running configuration: the hub reads `pm` from it on every answer, so a change applies at once. */
  config: Config;
  exec?: ExecFn;
  log?: (line: string) => void;
}

/**
 * Model and effort, chosen by the owner in the panel: the PM's (written to config.yaml) and each
 * Paseo agent's (through Paseo's own command line). Every value is checked against the list it
 * was offered from; nothing here reaches a model or an agent's conversation.
 */
export class Settings {
  readonly #config: Config;
  readonly #exec: ExecFn | undefined;
  readonly #log: (line: string) => void;

  constructor(options: SettingsOptions) {
    this.#config = options.config;
    this.#exec = options.exec;
    this.#log = options.log ?? (() => undefined);
  }

  pm(): PmSettings {
    const pm = this.#config.pm;
    return {
      provider: pm.provider,
      model: pm.model,
      effort: pm.effort,
      models: pm.provider === "anthropic" ? PM_MODELS.map(({ id, label }) => ({ id, label })) : [],
      efforts: PM_EFFORTS,
    };
  }

  async setPm(input: { model?: unknown; effort?: unknown }): Promise<PmSettings> {
    const pm = this.#config.pm;
    const model = input.model === undefined ? pm.model : input.model;
    const effort = input.effort === undefined ? pm.effort : input.effort;
    if (typeof effort !== "string" || !(PM_EFFORTS as readonly string[]).includes(effort)) throw new SettingsError(400, `effort must be one of ${PM_EFFORTS.join(", ")}`);
    if (model !== pm.model) {
      if (pm.provider !== "anthropic") throw new SettingsError(409, "this PM runs on an OpenAI-compatible server: its model is set in config.yaml");
      if (typeof model !== "string" || !PM_MODELS.some((m) => m.id === model)) throw new SettingsError(400, "unknown model");
    }
    // From the file, not from memory: what is saved is the owner's file with two fields changed.
    const onDisk = await loadConfig();
    onDisk.pm.model = model as string;
    onDisk.pm.effort = effort as PmEffort;
    await saveConfig(onDisk);
    const before = `${pm.model} (${pm.effort})`;
    pm.model = model as string;
    pm.effort = effort as PmEffort;
    this.#log(`PM model: ${before} → ${pm.model} (${pm.effort}), from the panel`);
    return this.pm();
  }

  async agents(project: Project): Promise<AgentSettings[]> {
    const listed = project.config.agents.filter((a) => !a.retired);
    const runtimes = listed.some((a) => a.paseoAgent) ? await agentRuntimes(this.#exec) : new Map();
    const settable = runtimes.size ? await canSetModel(this.#exec) : false;
    const out: AgentSettings[] = [];
    for (const agent of listed) {
      const base = { id: agent.id, label: agent.label ?? agent.id };
      if (agent.control !== "paseo" || !agent.paseoAgent) {
        out.push({ ...base, reachable: false, reason: "not run by Paseo" });
        continue;
      }
      const found = findRuntime(runtimes, agent.paseoAgent);
      if (!found) {
        out.push({ ...base, reachable: false, reason: "Paseo does not list it, or is unreachable" });
        continue;
      }
      if (found.runtime.status === "closed") {
        out.push({ ...base, reachable: false, reason: "its Paseo session is closed" });
        continue;
      }
      const { provider, model, thinking } = found.runtime;
      const models = await providerModels(provider, this.#exec);
      const current = models.find((m) => m.id === model);
      out.push({
        ...base,
        reachable: true,
        provider,
        model,
        thinking: thinking ?? current?.defaultThinking ?? null,
        models,
        canSetModel: settable && models.length > 0,
        canSetThinking: (current?.thinking.length ?? 0) > 0,
      });
    }
    return out;
  }

  async setAgent(project: Project, agentId: string, input: { model?: unknown; thinking?: unknown }): Promise<{ agent: AgentSettings; notices: string[] }> {
    const agent = (await this.agents(project)).find((a) => a.id === agentId);
    if (!agent) throw new SettingsError(404, "no such agent");
    if (!agent.reachable) throw new SettingsError(409, `${agent.label} cannot be changed from here: ${agent.reason}`);
    const paseoId = project.config.agents.find((a) => a.id === agentId)!.paseoAgent!;
    const models = agent.models ?? [];
    const notices: string[] = [];

    let model = agent.model ?? null;
    if (input.model !== undefined && input.model !== model) {
      if (typeof input.model !== "string" || !models.some((m) => m.id === input.model)) throw new SettingsError(400, "unknown model for this agent");
      if (!agent.canSetModel) throw new SettingsError(409, "this Paseo cannot switch a running agent's model from the command line yet: change it in Paseo's app");
      model = input.model;
    }
    let thinking: string | null = null;
    if (input.thinking !== undefined) {
      const offered = models.find((m) => m.id === model)?.thinking ?? [];
      if (typeof input.thinking !== "string" || !offered.includes(input.thinking)) throw new SettingsError(400, "unknown thinking level for this model");
      thinking = input.thinking;
    }

    // The model first: the thinking levels on offer are the new model's.
    if (model !== (agent.model ?? null) && model) {
      const done = await setAgentModel(paseoId, model, this.#exec);
      if (!done.ok) throw new SettingsError(502, done.reason);
      if (done.notice) notices.push(done.notice);
      this.#log(`${project.id}/${agentId} model: ${agent.model} → ${model}, from the panel`);
    }
    if (thinking && thinking !== agent.thinking) {
      const done = await setAgentThinking(paseoId, thinking, this.#exec);
      if (!done.ok) throw new SettingsError(502, done.reason);
      if (done.notice) notices.push(done.notice);
      this.#log(`${project.id}/${agentId} thinking: ${agent.thinking} → ${thinking}, from the panel`);
    }
    const now = (await this.agents(project)).find((a) => a.id === agentId)!;
    return { agent: now, notices };
  }

  async newAgentOptions(): Promise<NewAgentOptions> {
    const providers = await paseoProviders(this.#exec);
    return { providers: await Promise.all(providers.map(async (p) => ({ ...p, models: await providerModels(p.id, this.#exec) }))) };
  }

  /**
   * A new agent for the project, made the way the owner makes one in Paseo: a worktree workspace named
   * after the agent, and an agent started in it with its first message. Then it is registered here with
   * its name and role, before its first report, so the team knows it at once.
   */
  async createAgent(project: Project, input: { name?: unknown; role?: unknown; provider?: unknown; model?: unknown; thinking?: unknown; task?: unknown }): Promise<{ agent: AgentSettings }> {
    const name = cleanName(input.name);
    const role = cleanRole(input.role);
    let task: string | null = null;
    if (input.task !== undefined && input.task !== null) {
      if (typeof input.task !== "string" || input.task.length > TASK_MAX) throw new SettingsError(400, `the task must be text, up to ${TASK_MAX} characters`);
      task = input.task.trim() || null;
    }
    const providers = await paseoProviders(this.#exec);
    if (providers.length === 0) throw new SettingsError(502, "Paseo does not answer, or has no Claude Code or Codex provider enabled");
    const provider = providers.find((p) => p.id === input.provider);
    if (!provider) throw new SettingsError(400, "unknown provider");
    const models = await providerModels(provider.id, this.#exec);
    let model: string | undefined;
    if (input.model !== undefined && input.model !== null && input.model !== "") {
      if (typeof input.model !== "string" || !models.some((m) => m.id === input.model)) throw new SettingsError(400, "unknown model for this provider");
      model = input.model;
    }
    let thinking: string | undefined;
    if (input.thinking !== undefined && input.thinking !== null && input.thinking !== "") {
      const offered = model ? (models.find((m) => m.id === model)?.thinking ?? []) : [];
      if (typeof input.thinking !== "string" || !offered.includes(input.thinking)) throw new SettingsError(400, "unknown thinking level for this model");
      thinking = input.thinking;
    }

    const workspace = await createWorkspace(project.root, name, this.#exec);
    if (!workspace.ok) throw new SettingsError(502, workspace.reason);
    const prompt = messages(this.#config.language).newAgent.firstPrompt({ name, project: project.config.name, role, task });
    const started = await startAgent(workspace.workspaceId, { title: name, provider: provider.id, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), prompt }, this.#exec);
    if (!started.ok) {
      // A workspace with no agent in it would only confuse: it was made a moment ago, for this.
      const undone = await archiveWorkspace(workspace.workspaceId, this.#exec);
      this.#log(`new agent ${project.id}/${name}: ${started.reason}; the workspace was ${undone ? "archived" : "left in Paseo"}`);
      throw new SettingsError(502, started.reason);
    }

    // From disk, not from the copy the request started with: hooks and the hub write project.yaml too.
    const fresh = await loadProject(project.root);
    const { id } = agentForWorkspace(fresh, provider.host, { cwd: workspace.cwd, title: name, workspaceId: workspace.workspaceId });
    ensureAgent(fresh, id, provider.host, started.agentId, { workspace: workspace.cwd, label: name });
    const agent = fresh.config.agents.find((a) => a.id === id)!;
    if (role) agent.role = role;
    await saveProject(fresh.root, fresh.config);
    this.#log(`new agent ${fresh.id}/${id} (${provider.id}${model ? `/${model}` : ""}) in ${workspace.cwd}, from the panel`);
    const listed = (await this.agents(fresh)).find((a) => a.id === id)!;
    return { agent: listed };
  }

  /**
   * The name and role the owner gives an agent. A workspace agent takes its name from its Paseo
   * workspace, so the workspace is renamed too: the name is the same in both places, and stays.
   */
  async setProfile(project: Project, agentId: string, input: { name?: unknown; role?: unknown }): Promise<{ id: string; label: string; role: string | null }> {
    const fresh = await loadProject(project.root);
    const agent = fresh.config.agents.find((a) => a.id === agentId && !a.retired);
    if (!agent) throw new SettingsError(404, "no such agent");
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      if (name !== agent.label) {
        if (agent.workspace) {
          const workspace = (await paseoWorkspaces()).find((w) => w.cwd === agent.workspace);
          if (workspace?.workspaceId) {
            const renamed = await renameWorkspace(workspace.workspaceId, name, this.#exec);
            if (!renamed.ok) throw new SettingsError(502, renamed.reason);
          }
        }
        agent.label = name;
      }
    }
    if (input.role !== undefined) {
      const role = cleanRole(input.role);
      if (role) agent.role = role;
      else delete agent.role;
    }
    await saveProject(fresh.root, fresh.config);
    this.#log(`${fresh.id}/${agentId} is now «${agent.label ?? agentId}» (${agent.role ?? "no role"}), from the panel`);
    return { id: agent.id, label: agent.label ?? agent.id, role: agent.role ?? null };
  }
}
