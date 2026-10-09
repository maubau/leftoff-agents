import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { loadProject, saveProject } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { AnthropicProvider } from "../src/pm/anthropic.ts";
import { readSpend } from "../src/pm/ledger.ts";
import { OpenAICompatibleProvider } from "../src/pm/openai-compatible.ts";
import { askPm } from "../src/pm/pm.ts";
import type { ModelProvider, RunRequest, RunResult } from "../src/pm/provider.ts";
import { executeTool, TOOL_SPECS } from "../src/pm/tools.ts";
import { tempProject, isolateHost } from "./helpers.ts";

before(async () => {
  await isolateHost("leftoff-pm-");
});

const base = { done: [], doing: [], blocked: [], next: [], option: [] };

async function harbor() {
  const project = await tempProject({ id: "harbor", name: "Harbor", purpose: "Direct bookings" });
  await registerProject("harbor", project.root);
  await report(project, {
    ...base,
    agent: "claude",
    status: "blocked",
    done: ["Booking form with date validation"],
    blocked: ["Need the iCal URL of the listing"],
    decided: ["iCal feed instead of Airbnb API: the API needs a partner account"],
  });
  return loadProject(project.root);
}

test("every tool schema is strict-mode ready", () => {
  for (const tool of TOOL_SPECS) {
    const schema = tool.inputSchema as { additionalProperties: boolean; required: string[]; properties: object };
    strictEqual(schema.additionalProperties, false, tool.name);
    deepStrictEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), tool.name);
  }
});

test("project_status and search answer from the repo's own records", async () => {
  await harbor();
  const status = await executeTool({ surface: "chat" }, "project_status", { project: "harbor" });
  match(status.content, /Need the iCal URL/);
  match(status.content, /"status": "blocked"/);

  const found = await executeTool({ surface: "chat" }, "search", { query: "ical airbnb", project: null });
  match(found.content, /partner account/);

  const missing = await executeTool({ surface: "chat" }, "project_status", { project: "nope" });
  strictEqual(missing.isError, true);
  match(missing.content, /Known: .*harbor/);
});

test("private projects do not exist in chat, but do in the terminal", async () => {
  const secret = await tempProject({ id: "secret", name: "Secret", visibility: "private" });
  await registerProject("secret", secret.root);
  const chat = await executeTool({ surface: "chat" }, "list_projects", {});
  ok(!chat.content.includes('"secret"'));
  const terminal = await executeTool({ surface: "terminal" }, "list_projects", {});
  ok(terminal.content.includes('"secret"'));
  const direct = await executeTool({ surface: "chat" }, "project_status", { project: "secret" });
  strictEqual(direct.isError, true);
});

/** A provider that calls one tool, then answers from what it got. */
class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  seen: RunRequest[] = [];
  readonly cost: number;
  constructor(cost = 0.01) {
    this.cost = cost;
  }
  async run(request: RunRequest): Promise<RunResult> {
    this.seen.push(request);
    const status = await request.execute("project_status", { project: "harbor" });
    return {
      text: status.content.includes("iCal") ? "⛔ Bloccato: serve l'URL iCal." : "non lo so",
      model: this.model,
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: this.cost,
      steps: 2,
      toolCalls: [{ name: "project_status", input: {} }],
    };
  }
}

test("askPm answers through the provider, records spend, and keeps the system prompt stable", async () => {
  await harbor();
  const provider = new FakeProvider();
  const config = ConfigSchema.parse({});
  const first = await askPm({ question: "a che punto siamo?", config, surface: "chat", provider });
  match(first.text, /URL iCal/);
  await askPm({ question: "e ora?", config, surface: "chat", provider, now: new Date(Date.now() + 3_600_000) });

  // The cached prefix must not change between questions; the date lives in the prompt.
  strictEqual(provider.seen[0]!.system, provider.seen[1]!.system);
  ok(provider.seen[0]!.prompt !== provider.seen[1]!.prompt);
  ok((await readSpend()).length >= 2);
});

test("the monthly cap stops the PM before it spends, and warns once on the way", async () => {
  const config = ConfigSchema.parse({ pm: { budget: { monthlyUsd: 0.05, warnAt: 0.5 } } });
  const provider = new FakeProvider(0.02);
  let warnings = 0;
  let skipped = 0;
  for (let i = 0; i < 6; i++) {
    const r = await askPm({ question: "status?", config, surface: "chat", provider });
    warnings += r.notices.length;
    if (r.skipped) skipped++;
  }
  ok(skipped >= 1, "must stop once the cap is reached");
  ok(warnings <= 1, "warns at most once a month");
});

/** Just enough of the SDK client for the adapter: beta.messages.create. */
function fakeAnthropic(responses: Array<Partial<Anthropic.Beta.BetaMessage>>) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          calls.push(structuredClone(params));
          const next = responses.shift()!;
          return {
            model: "claude-sonnet-5-5",
            stop_details: null,
            ...next,
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, ...(next.usage ?? {}) },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

test("the Anthropic adapter runs the tool loop, sums usage and prices it", async () => {
  const { client, calls } = fakeAnthropic([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "list_projects", input: {} } as Anthropic.Beta.BetaToolUseBlock] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Tutto fermo." } as Anthropic.Beta.BetaTextBlock] },
  ]);
  const provider = new AnthropicProvider({ model: "claude-sonnet-5-5", effort: "low", client });
  const executed: string[] = [];
  const result = await provider.run({
    system: "sys",
    history: [],
    prompt: "q",
    tools: TOOL_SPECS,
    maxSteps: 5,
    execute: async (name) => {
      executed.push(name);
      return { content: "[]" };
    },
  });
  strictEqual(result.text, "Tutto fermo.");
  deepStrictEqual(executed, ["list_projects"]);
  strictEqual(result.usage.inputTokens, 2000);
  // 2000 in × $2 + 400 out × $10 + 1000 cached × $0.20, per million.
  strictEqual(Number(result.costUsd.toFixed(6)), Number(((2000 * 2 + 400 * 10 + 1000 * 0.2) / 1e6).toFixed(6)));

  const first = calls[0] as Record<string, unknown>;
  strictEqual(first.fallbacks, "default");
  deepStrictEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  deepStrictEqual(first.output_config, { effort: "low" });
  // Tool results go back in one user message, after the assistant turn kept whole.
  const second = calls[1] as { messages: Array<{ role: string; content: unknown }> };
  strictEqual(second.messages.at(-1)!.role, "user");
  strictEqual(second.messages.at(-2)!.role, "assistant");
});

test("the Anthropic adapter reports a refusal instead of an empty answer", async () => {
  const { client } = fakeAnthropic([
    { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } as never, content: [] },
  ]);
  const provider = new AnthropicProvider({ model: "claude-sonnet-5-5", effort: "low", client });
  const result = await provider.run({ system: "s", history: [], prompt: "q", tools: [], maxSteps: 3, execute: async () => ({ content: "" }) });
  strictEqual(result.refusal?.category, "cyber");
});

test("the Anthropic adapter forces an answer when the step budget runs out", async () => {
  const toolTurn = { stop_reason: "tool_use" as const, content: [{ type: "tool_use", id: "t", name: "list_projects", input: {} } as Anthropic.Beta.BetaToolUseBlock] };
  const { client, calls } = fakeAnthropic([toolTurn, toolTurn, { stop_reason: "end_turn", content: [{ type: "text", text: "ok" } as Anthropic.Beta.BetaTextBlock] }]);
  const provider = new AnthropicProvider({ model: "claude-sonnet-5-5", effort: "low", client });
  const result = await provider.run({ system: "s", history: [], prompt: "q", tools: TOOL_SPECS, maxSteps: 2, execute: async () => ({ content: "[]" }) });
  strictEqual(result.text, "ok");
  const last = calls.at(-1) as Record<string, unknown>;
  deepStrictEqual(last.tool_choice, { type: "none" });
});

test("the OpenAI-compatible adapter drives tool calls over plain HTTP", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_projects", arguments: "{}" } }] } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
    { choices: [{ finish_reason: "stop", message: { content: "Nessun blocco." } }], usage: { prompt_tokens: 150, completion_tokens: 20, cost: 0.0003 } },
  ];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  }) as typeof fetch;
  const provider = new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434/v1/", model: "qwen", fetch: fakeFetch });
  const result = await provider.run({ system: "s", history: [], prompt: "q", tools: TOOL_SPECS, maxSteps: 4, execute: async () => ({ content: "[]" }) });
  strictEqual(result.text, "Nessun blocco.");
  strictEqual(result.costUsd, 0.0003, "uses the cost the backend reports");
  const second = bodies[1] as { messages: Array<{ role: string }> };
  strictEqual(second.messages.at(-1)!.role, "tool");
});

test("the request fits the model: no refusal fallback on Haiku, no effort on Haiku 4.5, both on the others", async () => {
  const shape = async (model: string) => {
    const { client, calls } = fakeAnthropic([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" } as Anthropic.Beta.BetaTextBlock] }]);
    await new AnthropicProvider({ model, effort: "high", client }).run({ system: "s", history: [], prompt: "q", tools: [], maxSteps: 1, execute: async () => ({ content: "" }) });
    const sent = calls[0] as Record<string, unknown>;
    return { fallback: "fallbacks" in sent || "betas" in sent, effort: (sent.output_config as { effort?: string } | undefined)?.effort ?? null };
  };
  deepStrictEqual(await shape("claude-opus-5-5"), { fallback: true, effort: "high" });
  deepStrictEqual(await shape("claude-fable-5-1"), { fallback: true, effort: "high" });
  deepStrictEqual(await shape("claude-haiku-5-5"), { fallback: false, effort: "high" });
  deepStrictEqual(await shape("claude-haiku-4-5-20251001"), { fallback: false, effort: null });
  deepStrictEqual(await shape("claude-some-future-model"), { fallback: true, effort: "high" }, "an unknown model keeps the full request");
});

test("every model the panel offers has a price, and Haiku 5.5's long prompts cost the long rate", async () => {
  const { PM_MODELS } = await import("../src/pm/models.ts");
  const { anthropicPrice, costOf } = await import("../src/pm/pricing.ts");
  for (const m of PM_MODELS) ok(anthropicPrice(m.id), `${m.id} has no price: the monthly cap would not count it`);
  const short = { inputTokens: 50_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  strictEqual(costOf(short, anthropicPrice("claude-haiku-5-5")), (50_000 * 0.1 + 1_000_000 * 0.5) / 1e6);
  const long = { ...short, cacheReadTokens: 60_000 };
  strictEqual(costOf(long, anthropicPrice("claude-haiku-5-5")), (50_000 * 0.5 + 1_000_000 * 2.5 + 60_000 * 0.05) / 1e6);
});
