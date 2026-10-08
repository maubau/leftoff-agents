import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../core/config.ts";
import { configRoot } from "../core/paths.ts";
import { messages } from "../i18n/index.ts";
import { createProvider } from "./factory.ts";
import { monthKey, recordSpend, spentThisMonth } from "./ledger.ts";
import { PM_SYSTEM, questionPrompt } from "./prompt.ts";
import type { ChatTurn, ModelProvider, RunResult } from "./provider.ts";
import { ACTION_SPECS, ASK_STATUS_SPEC, COMMAND_SPEC, CREATE_TASKS_SPEC, REMOVE_TASKS_SPEC, SET_ROLE_SPEC, executeTool, TOOL_SPECS, type PmActions, type ToolContext } from "./tools.ts";

export interface AskOptions {
  question: string;
  config: Config;
  surface: ToolContext["surface"];
  /** The project this conversation is about, if the channel knows it. */
  project?: { id: string; name: string };
  history?: ChatTurn[];
  purpose?: string;
  provider?: ModelProvider;
  actions?: PmActions;
  fromVoice?: boolean;
  /** Facts about the conversation the PM cannot see in the repo, e.g. a draft awaiting approval. */
  notes?: string;
  now?: Date;
}

export interface AskResult {
  text: string;
  costUsd: number;
  model: string;
  /** Messages for the owner about the PM itself (budget), separate from the answer. */
  notices: string[];
  /** True when no model was called (budget exhausted). */
  skipped?: boolean;
  run?: RunResult;
}

const budgetState = () => join(configRoot(), "budget-state.json");

async function shouldWarn(now: Date): Promise<boolean> {
  const raw = await readFile(budgetState(), "utf8").catch(() => "{}");
  const state = JSON.parse(raw) as { warnedMonth?: string };
  if (state.warnedMonth === monthKey(now)) return false;
  await mkdir(dirname(budgetState()), { recursive: true });
  await writeFile(budgetState(), JSON.stringify({ warnedMonth: monthKey(now) }), "utf8");
  return true;
}

/**
 * One question to the PM. The budget is checked before the call and the cost
 * recorded after, so a runaway loop can overshoot the cap by one answer at most.
 */
export async function askPm(options: AskOptions): Promise<AskResult> {
  const { config } = options;
  const t = messages(config.language).pm;
  const now = options.now ?? new Date();
  const cap = config.pm.budget.monthlyUsd;
  const before = await spentThisMonth(now);

  if (before >= cap) {
    return { text: t.capped(cap), costUsd: 0, model: config.pm.model, notices: [], skipped: true };
  }

  const provider = options.provider ?? createProvider(config.pm);
  const ctx: ToolContext = { surface: options.surface, ...(options.actions ? { actions: options.actions } : {}) };
  const run = await provider.run({
    system: PM_SYSTEM,
    history: options.history ?? [],
    prompt: questionPrompt({
      question: options.question,
      now,
      timezone: config.timezone,
      language: config.language,
      project: options.project,
      ...(options.fromVoice ? { fromVoice: true } : {}),
      ...(options.notes ? { notes: options.notes } : {}),
    }),
    // Action tools are appended after the read tools, so the cached prefix of a
    // read-only caller and of the hub differ only in that tail.
    tools: options.actions
      ? [
          ...TOOL_SPECS,
          ...ACTION_SPECS,
          ...(options.actions.proposeCommand ? [COMMAND_SPEC] : []),
          ...(options.actions.askStatus ? [ASK_STATUS_SPEC] : []),
          ...(options.actions.createTasks ? [CREATE_TASKS_SPEC] : []),
          ...(options.actions.removeTasks ? [REMOVE_TASKS_SPEC] : []),
          ...(options.actions.setRole ? [SET_ROLE_SPEC] : []),
        ]
      : TOOL_SPECS,
    execute: (name, input) => executeTool(ctx, name, input),
    maxSteps: config.pm.maxSteps,
  });

  await recordSpend({
    at: now.toISOString(),
    provider: provider.id,
    model: run.model,
    costUsd: run.costUsd,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    cacheReadTokens: run.usage.cacheReadTokens,
    purpose: options.purpose ?? "ask",
    ...(options.project ? { project: options.project.id } : {}),
  });

  const notices: string[] = [];
  const after = before + run.costUsd;
  if (after >= cap * config.pm.budget.warnAt && (await shouldWarn(now))) notices.push(t.budgetWarn(after, cap));

  const text = run.refusal ? t.refused : run.text || t.empty;
  return { text, costUsd: run.costUsd, model: run.model, notices, run };
}
