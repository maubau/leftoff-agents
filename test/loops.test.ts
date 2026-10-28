import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import type { Project } from "../src/core/project.ts";
import type { Report } from "../src/core/report.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { ciStorm, githubSlug, pullRequestsIn, repeatedQuestions, reviewRounds, sameWords, waitingAnswers } from "../src/hub/loops.ts";
import { isolateHost, tempProject } from "./helpers.ts";

/** The loop guard (D-069). Invented projects and agents; `gh` and `git` are faked. */
beforeEach(async () => {
  await isolateHost("leftoff-loops-");
});

const H = 3_600_000;
const now = Date.parse("2026-10-27T12:00:00Z");
const at = (hoursAgo: number) => new Date(now - hoursAgo * H).toISOString();
const asked = (agent: string, text: string, hoursAgo: number) => ({ agent, at: at(hoursAgo), question: { text, options: [] } }) as unknown as Report;

test("the same question three times in two days, whatever the case and punctuation, is a loop; twice is not", () => {
  strictEqual(sameWords("Week or MONTH view, first?"), "week or month view first");
  const reports = [asked("ux", "Week or month view first?", 1), asked("ux", "week or month view first", 5), asked("ux", "Week, or month view first?!", 30), asked("qa", "Week or month view first?", 2)];
  const [signal, ...rest] = repeatedQuestions("harbor", reports, now);
  deepStrictEqual(rest, []);
  deepStrictEqual([signal!.agent, signal!.count, signal!.since], ["ux", 3, at(30)]);
  deepStrictEqual(repeatedQuestions("harbor", reports.slice(0, 2), now), []);
  deepStrictEqual(repeatedQuestions("harbor", [asked("ux", "Q?", 1), asked("ux", "Q?", 2), asked("ux", "Q?", 60)], now), [], "the third is older than two days");
});

test("three round trips on the same pull request in a day are review rounds without end; updates one way are not", () => {
  deepStrictEqual(pullRequestsIn("review PR #120, then fix #121 and pull request 7"), ["120", "121", "7"]);
  const rounds = Array.from({ length: 6 }, (_, i) => ({ projectId: "harbor", from: i % 2 ? "qa" : "ux", to: i % 2 ? "ux" : "qa", ask: `round ${i} on PR #120`, at: at(i) }));
  const [signal] = reviewRounds("harbor", rounds, now);
  deepStrictEqual([signal!.subject, signal!.count, signal!.other], ["#120", 3, "ux, qa"]);
  deepStrictEqual(reviewRounds("harbor", rounds.slice(0, 5), now), [], "two round trips and a half");
  const oneWay = Array.from({ length: 8 }, (_, i) => ({ projectId: "harbor", from: "qa", to: "ux", ask: `PR #42: review ${i}, justified`, at: at(i) }));
  deepStrictEqual(reviewRounds("harbor", oneWay, now), [], "eight justified reviews, all one way, are not a loop");
  deepStrictEqual(reviewRounds("lighthouse", rounds, now), [], "another project's handoffs");
});

test("an answer awaited for more than three hours, with no report since, is a wait; CI runs too often are a storm", () => {
  deepStrictEqual(waitingAnswers("harbor", [{ asker: "ux", target: "qa", deliveredAt: at(4) }], now).map((s) => [s.agent, s.subject, s.count, s.closed]), [["ux", "qa", 4, undefined]]);
  strictEqual(waitingAnswers("harbor", [{ asker: "ux", target: "qa", deliveredAt: at(4), closed: true }], now)[0]!.closed, true, "the evidence says the awaited session is closed");
  deepStrictEqual(waitingAnswers("harbor", [{ asker: "ux", target: "qa", deliveredAt: at(4), targetReportedAt: at(1) }], now), [], "it answered");
  deepStrictEqual(waitingAnswers("harbor", [{ asker: "ux", target: "qa", deliveredAt: at(2) }], now), []);
  const runs = (n: number, branch: string) => Array.from({ length: n }, (_, i) => ({ createdAt: new Date(now - i * 10 * 60_000).toISOString(), headBranch: branch }));
  deepStrictEqual(ciStorm("harbor", runs(6, "feat/tour"), now).map((s) => [s.subject, s.count]), [["feat/tour", 6]]);
  deepStrictEqual(ciStorm("harbor", [...runs(5, "a"), ...runs(5, "b")], now).map((s) => [s.subject, s.count]), [["", 10]]);
  deepStrictEqual(ciStorm("harbor", runs(5, "a"), now), []);
  strictEqual(githubSlug("git@github.com:example-owner/harbor.git\n"), "example-owner/harbor");
  strictEqual(githubSlug("https://github.com/example-owner/harbor"), "example-owner/harbor");
  strictEqual(githubSlug("https://gitlab.example/x/y.git"), undefined);
});

async function hub(exec: (file: string, args: string[]) => Promise<{ stdout: string }>) {
  const harbor: Project = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX" }] });
  await registerProject("harbor", harbor.root);
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  return { harbor, channel, hub: new Hub({ config, channel, toolExec: exec, log: () => undefined }) };
}

test("the hub warns the owner once per loop, with its evidence; it sends nothing to the agent", async () => {
  const calls: string[] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push(file);
    if (file === "git") return { stdout: "git@github.com:example-owner/harbor.git\n" };
    if (file === "gh") return { stdout: JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ createdAt: new Date(Date.now() - i * 5 * 60_000).toISOString(), headBranch: "feat/tour" }))) };
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  };
  const { harbor, channel, hub: h } = await hub(exec);
  for (let i = 0; i < 3; i++) await report(harbor, { done: [], doing: [], blocked: [], next: [], option: ["Week", "Month"], agent: "ux", status: "needs_input", question: "Week or month view first?" } as never);
  let t = Date.now();
  await h.tick(new Date(t));
  const said = () => channel.sent.map((m) => m.text).filter((x) => /^[🔁⏳💸]/u.test(x));
  match(said().join("\n"), /🔁 Harbor UX \(Harbor\) has asked you the same question 3 times/);
  match(said().join("\n"), /💸 Harbor: 11 CI runs since .*, most of them on feat\/tour/);
  strictEqual(said().length, 2);
  await h.tick(new Date((t += 6 * 60_000)));
  strictEqual(said().length, 2, "once per episode");
  ok(calls.filter((c) => c === "gh").length <= 1, "gh is asked at most every ten minutes");
  ok(!calls.includes("paseo"), "nothing is sent to an agent");
  await h.tick(new Date((t += 3 * H)));
  deepStrictEqual(Object.values(h.state.loops!.episodes).map((e) => e.kind), ["question"], "the question is still seen; the CI storm, quiet for two hours, ended by itself");
});

test("the ladder: warned, then a draft that waits for the owner's «sì» even when autonomous, then a pause the owner lifts", async () => {
  const quiet = async (file: string) => (file === "git" ? { stdout: "" } : { stdout: "[]" });
  const { harbor, channel, hub: h } = await hub(quiet);
  await h.setProjectMode("harbor", "autonomous", "panel");
  const ask = () => report(harbor, { done: [], doing: [], blocked: [], next: [], option: ["Week", "Month"], agent: "ux", status: "needs_input", question: "Week or month view first?" } as never);
  for (let i = 0; i < 3; i++) await ask();
  let t = Date.now();
  await h.tick(new Date(t));
  strictEqual(h.state.loops!.episodes[Object.keys(h.state.loops!.episodes)[0]!]!.level, "warned");

  await ask();
  await h.tick(new Date((t += 30 * 60_000)));
  strictEqual(Object.values(h.state.loops!.episodes)[0]!.level, "warned", "not before an hour");
  await h.tick(new Date((t += 31 * 60_000)));
  strictEqual(Object.values(h.state.loops!.episodes)[0]!.level, "braked");
  match(channel.sent.map((m) => m.text).join("\n"), /🛑 Brake \(Harbor\)[\s\S]*draft for Harbor UX: it goes only on your «yes»/);
  const brake = h.state.handoffs.find((x) => x.needsYes);
  ok(brake, "the brake is a draft");
  strictEqual(brake!.to, "ux");
  await h.tick(new Date((t += 60_000)));
  ok(h.state.handoffs.some((x) => x.needsYes), "autonomous, yet it was not passed on by itself");

  await ask();
  await h.tick(new Date((t += 61 * 60_000)));
  ok(h.state.loops!.paused["harbor:ux"], "paused");
  const pause = channel.sent.find((m) => m.text.startsWith("⏸️ Pause (Harbor)"));
  ok(pause, "the owner is told");

  const replies: string[] = [];
  await h.handle({ text: "/unpause harbor ux", projectId: "harbor", threadKey: "t", reply: async (r) => void replies.push(r), typing: async () => undefined });
  match(replies.at(-1)!, /▶️ Harbor UX \(Harbor\) automatic again/);
  strictEqual(h.state.loops!.paused["harbor:ux"], undefined);
});

test("a private project is never watched, a muted one is not until unmuted: no episode, no message, no gh", async () => {
  const calls: string[] = [];
  const toolExec = async (file: string) => {
    calls.push(file);
    return file === "git" ? { stdout: "git@github.com:example-owner/x.git\n" } : { stdout: "[]" };
  };
  const vault = await tempProject({ id: "vault", name: "Vault", visibility: "private", agents: [{ id: "dev", control: "inbox", host: "claude-code" }] });
  await registerProject("vault", vault.root);
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX" }] });
  await registerProject("harbor", harbor.root);
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const h = new Hub({ config, channel, toolExec, log: () => undefined });
  for (const [p, agent] of [[vault, "dev"], [harbor, "ux"]] as const) for (let i = 0; i < 3; i++) await report(p, { done: [], doing: [], blocked: [], next: [], option: [], agent, status: "needs_input", question: "Same question?" } as never);
  const replies: string[] = [];
  const say = (text: string) => h.handle({ text, projectId: "harbor", threadKey: "t", reply: async (r) => void replies.push(r), typing: async () => undefined });
  await say("/mute harbor 2");
  let t = Date.now();
  await h.tick(new Date(t));
  deepStrictEqual(Object.keys(h.state.loops!.episodes), [], "neither the private nor the muted project");
  ok(!channel.sent.some((m) => m.text.startsWith("🔁")));
  strictEqual(calls.length, 0, "not even gh is asked");
  await say("/unmute harbor");
  await h.tick(new Date((t += 6 * 60_000)));
  deepStrictEqual(Object.values(h.state.loops!.episodes).map((e) => e.projectId), ["harbor"]);
  ok(!channel.sent.some((m) => /Vault/.test(m.text)));
});

test("paused means paused: a queued message, an inbox catching up and a teammate's answer all wait for the owner's «sì»", async () => {
  const { pending } = await import("../src/core/inbox.ts");
  const { enqueue } = await import("../src/core/inbox.ts");
  const UX = "44444444-4444-4444-8444-444444444444";
  const QA = "55555555-5555-4555-8555-555555555555";
  const sent: string[] = [];
  const exec = async (_file: string, args: string[]) => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: UX, status: "idle" }, { id: QA, status: "idle" }]) };
    if (args[0] === "send") {
      sent.push(args[1]!);
      return { stdout: '{"status":"sent"}' };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX, label: "Harbor UX" }, { id: "qa", control: "paseo", host: "claude-code", paseoAgent: QA, label: "Harbor QA" }] });
  await registerProject("harbor", harbor.root);
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const h = new Hub({ config, channel, exec, toolExec: async () => ({ stdout: "" }), log: () => undefined });
  let t = Date.now();
  await h.tick(new Date(t));
  h.state.loops = { seen: [], episodes: {}, paused: { "harbor:ux": { since: new Date(t).toISOString(), reason: "question" } }, ci: {} };

  // 1. Queued for the end of its turn, before the pause.
  h.state.deliveryQueue.push({ id: "q1", projectId: "harbor", agentId: "ux", paseoAgent: UX, text: "Add the tour step.", kind: "handoff", queuedAt: new Date(t).toISOString() });
  // 2. An owner's instruction waiting in its inbox for the session to come back.
  await enqueue(harbor, "ux", "Rename the header.", "user");
  // 3. QA answers a handoff ux had sent.
  h.state.handoffReplies["harbor:qa"] = "ux";
  h.state.awaiting["harbor:qa"] = new Date(t).toISOString();
  await report(harbor, { done: ["Reviewed the tour"], doing: [], blocked: [], next: [], option: [], agent: "qa", status: "done", at: new Date(t + 30_000).toISOString() } as never);
  await h.tick(new Date((t += 60_000)));

  ok(!sent.includes(UX), "nothing reached the paused agent");
  strictEqual(h.state.deliveryQueue.length, 0);
  deepStrictEqual((await pending(harbor, "ux")).length, 0, "out of the inbox, so it goes only once");
  const held = h.state.handoffs.filter((x) => x.to === "ux" && x.needsYes);
  strictEqual(held.length, 3, "all three wait, shown for a yes");
  ok(held.some((x) => /Add the tour step/.test(x.prompt)) && held.some((x) => /Rename the header/.test(x.prompt)) && held.some((x) => /Reviewed the tour/.test(x.prompt)));
});

test("only rounds on one pull request between two agents count: a summary naming several, or the coordinator's routing, does not", () => {
  const round = (i: number, ask: string, from = i % 2 ? "qa" : "ux", to = i % 2 ? "ux" : "qa") => ({ projectId: "harbor", from, to, ask, at: at(i) });
  const summaries = Array.from({ length: 8 }, (_, i) => round(i, "Status: yes to #222; #229 and #230 clean; #228 has one finding"));
  deepStrictEqual(reviewRounds("harbor", summaries, now), [], "a handoff naming several pull requests is a status note");
  const routed = Array.from({ length: 8 }, (_, i) => round(i, "review #222", i % 2 ? "ops" : "ux", i % 2 ? "ux" : "ops"));
  deepStrictEqual(reviewRounds("harbor", routed, now, new Set(["ops"])), [], "the coordinator routes work, it is not a review round");
  const real = Array.from({ length: 6 }, (_, i) => round(i, "PR #222: fix the finding"));
  deepStrictEqual(reviewRounds("harbor", real, now, new Set(["ops"])).map((s) => [s.subject, s.count, s.other]), [["#222", 3, "ux, qa"]]);
});

test("a merged pull request is never a review loop, and a wait is braked but never paused", async () => {
  const toolExec = async (file: string, args: string[]) => {
    if (file === "git") return { stdout: "git@github.com:example-owner/harbor.git\n" };
    if (args[0] === "pr") return { stdout: JSON.stringify({ state: args[2] === "222" ? "MERGED" : "OPEN" }) };
    return { stdout: "[]" };
  };
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "inbox", host: "claude-code" }, { id: "qa", control: "inbox", host: "claude-code" }] });
  await registerProject("harbor", harbor.root);
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const h = new Hub({ config, channel, toolExec, log: () => undefined });
  let t = Date.now();
  await h.tick(new Date(t));
  const seen = (pr: string) => Array.from({ length: 6 }, (_, i) => ({ projectId: "harbor", from: i % 2 ? "qa" : "ux", to: i % 2 ? "ux" : "qa", ask: `PR #${pr}: round ${i}`, at: new Date(t - i * 60_000).toISOString() }));
  h.state.loops = { seen: [...seen("222"), ...seen("230")], episodes: {}, paused: {}, ci: {} };
  h.state.handoffReplies["harbor:qa"] = "ux";
  h.state.awaiting["harbor:qa"] = new Date(t - 4 * H).toISOString();
  await h.tick(new Date((t += 6 * 60_000)));
  deepStrictEqual(Object.keys(h.state.loops.episodes).filter((k) => k.startsWith("review")), ["review:harbor:230:qa+ux"], "#222 is merged");
  const wait = () => Object.values(h.state.loops!.episodes).find((e) => e.kind === "waiting")!;
  await h.tick(new Date((t += 61 * 60_000)));
  strictEqual(wait().level, "braked");
  ok(h.state.handoffs.some((x) => x.needsYes && x.to === "qa"), "the brake asks the awaited teammate");
  for (let i = 0; i < 3; i++) await h.tick(new Date((t += 61 * 60_000)));
  strictEqual(wait().level, "braked", "it stops at the brake");
  ok(!h.state.loops.paused["harbor:ux"] && !h.state.loops.paused["harbor:qa"], "nobody is paused for a wait");
});

test("held by the pause, a message keeps who asked and the exact session it was for; Paseo not answering is not a closed session", async () => {
  const UX = "66666666-6666-4666-8666-666666666666";
  const OLD = "77777777-7777-4777-8777-777777777777";
  const QA = "88888888-8888-4888-8888-888888888888";
  const sent: string[] = [];
  let lsAnswers = true;
  const exec = async (_file: string, args: string[]) => {
    if (args[0] === "ls") {
      if (!lsAnswers) throw new Error("paseo: daemon not running");
      return { stdout: JSON.stringify([{ id: UX, status: "idle" }, { id: OLD, status: "idle" }, { id: QA, status: "idle" }]) };
    }
    if (args[0] === "send") {
      sent.push(args[1]!);
      return { stdout: '{"status":"sent"}' };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX, label: "Harbor UX" }, { id: "qa", control: "paseo", host: "claude-code", paseoAgent: QA, label: "Harbor QA" }] });
  await registerProject("harbor", harbor.root);
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const h = new Hub({ config, channel, exec, toolExec: async () => ({ stdout: "" }), log: () => undefined });
  let t = Date.now();
  await h.tick(new Date(t));
  h.state.loops = { seen: [], episodes: {}, paused: { "harbor:ux": { since: new Date(t).toISOString(), reason: "question" } }, ci: {} };
  h.state.deliveryQueue.push({ id: "q1", projectId: "harbor", agentId: "ux", paseoAgent: UX, text: "Fix the finding on the tour.", kind: "handoff", handoffFrom: "qa", queuedAt: new Date(t).toISOString() });
  await h.tick(new Date((t += 60_000)));
  strictEqual(h.state.handoffs.find((x) => x.to === "ux" && /tour/.test(x.prompt))!.from, "qa", "approved, its answer still goes back to QA");

  // A restart held for the session that stopped (OLD), while the project now points at a newer one (UX).
  h.state.handoffs = [{ id: "held-restart", projectId: "harbor", from: "pm", to: "ux", ask: "restart", prompt: "The limit has reset: go on.", report: "loop-guard", createdAt: new Date(t).toISOString(), needsYes: true, paseoAgent: OLD, shownAt: new Date(t).toISOString(), expiresAt: new Date(t + 3_600_000).toISOString() }];
  await h.handle({ text: "yes", projectId: "harbor", threadKey: "t", reply: async () => undefined, typing: async () => undefined });
  deepStrictEqual(sent, [OLD], "only the session that stopped");

  // Paseo not answering: the waiting warning does not call the awaited session closed.
  lsAnswers = false;
  h.state.loops!.paused = {};
  h.state.handoffReplies["harbor:qa"] = "ux";
  h.state.awaiting["harbor:qa"] = new Date(t - 4 * H).toISOString();
  h.state.loops!.checkedAt = undefined;
  await h.tick(new Date((t += 6 * 60_000)));
  const warned = channel.sent.find((m) => m.text.startsWith("⏳"));
  ok(warned, "the wait is warned");
  ok(!/session is closed/.test(warned!.text), "an unanswered paseo ls is not a closed session");
});

test("a pull request gh cannot tell about is not a review loop, and is asked again; each pair on a PR is its own episode", async () => {
  const asked: string[] = [];
  let ghWorks = false;
  const toolExec = async (file: string, args: string[]) => {
    if (file === "git") return { stdout: "git@github.com:example-owner/harbor.git\n" };
    if (args[0] === "pr") {
      asked.push(args[2]!);
      if (!ghWorks) throw new Error("gh: not signed in");
      return { stdout: JSON.stringify({ state: "OPEN" }) };
    }
    return { stdout: "[]" };
  };
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: ["ux", "qa", "dev"].map((id) => ({ id, control: "inbox" as const, host: "claude-code" as const })) });
  await registerProject("harbor", harbor.root);
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const h = new Hub({ config, channel: new ConsoleChannel(), toolExec, log: () => undefined });
  let t = Date.now();
  await h.tick(new Date(t));
  const rounds = (a: string, b: string) => Array.from({ length: 6 }, (_, i) => ({ projectId: "harbor", from: i % 2 ? b : a, to: i % 2 ? a : b, ask: `PR #300: round ${i}`, at: new Date(t - i * 60_000).toISOString() }));
  h.state.loops = { seen: [...rounds("ux", "qa"), ...rounds("dev", "qa")], episodes: {}, paused: {}, ci: {} };
  await h.tick(new Date((t += 6 * 60_000)));
  deepStrictEqual(Object.keys(h.state.loops.episodes), [], "unknown is not open");
  ghWorks = true;
  await h.tick(new Date((t += 6 * 60_000)));
  ok(asked.length >= 2, "the failure was not kept: asked again");
  deepStrictEqual(Object.keys(h.state.loops.episodes).filter((k) => k.startsWith("review")).sort(), ["review:harbor:300:qa+ux"], "the busiest pair on the PR");
  for (const e of Object.values(h.state.loops.episodes)) e.level = "braked";
  h.state.loops.seen = [...h.state.loops.seen.filter((x) => x.from !== "ux" && x.to !== "ux"), ...rounds("dev", "qa"), ...rounds("dev", "qa")];
  await h.tick(new Date((t += 6 * 60_000)));
  const dev = Object.entries(h.state.loops.episodes).find(([k]) => k.endsWith(":dev+qa"))?.[1];
  strictEqual(dev?.level, "warned", "another pair starts from its own first level");
});

test("a restart held by the pause is served once, and a revised held restart stays pinned to the session that stopped", async () => {
  const UX = "99999999-9999-4999-8999-999999999999";
  const OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sent: string[] = [];
  const exec = async (_file: string, args: string[]) => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: UX, status: "idle" }, { id: OLD, status: "idle" }]) };
    if (args[0] === "send") {
      sent.push(args[1]!);
      return { stdout: '{"status":"sent"}' };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX, label: "Harbor UX" }] });
  await registerProject("harbor", harbor.root);
  const provider = {
    id: "fake",
    model: "fake",
    async run(request: { prompt: string; execute(name: string, input: unknown): Promise<{ content: string }> }) {
      if (request.prompt.includes("shorter")) await request.execute("propose_agent_command", { project: "harbor", agent: "ux", prompt: "Limit reset: go on, briefly.", summary: "restart" });
      return { text: "Revised.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", statusChecks: { enabled: false } });
  const channel = new ConsoleChannel();
  const h = new Hub({ config, channel, exec, provider: provider as never, toolExec: async () => ({ stdout: "" }), log: () => undefined });
  let t = Date.now();
  await h.tick(new Date(t));
  h.state.loops = { seen: [], episodes: {}, paused: { "harbor:ux": { since: new Date(t).toISOString(), reason: "question" } }, ci: {} };
  h.state.resumeTargets.push({ windowId: "w1", product: "Claude Code", serveKey: "ep1|root|ux|old", projectId: "harbor", projectRoot: harbor.root, agentId: "ux", paseoAgent: OLD, resumeAt: t - 60_000, armedAt: new Date(t - 3_600_000).toISOString() } as never);
  await h.tick(new Date((t += 60_000)));
  ok(!sent.length, "held, not sent");
  ok(h.state.resumeServed.includes("ep1|root|ux|old"), "served: the same episode arms no second restart");
  const held = h.state.handoffs.find((x) => x.paseoAgent === OLD)!;
  ok(held, "held for the session that stopped");

  // Shown, the owner asks for a change; the revised draft still goes only to OLD.
  held.shownAt = new Date(t).toISOString();
  held.expiresAt = new Date(t + 3_600_000).toISOString();
  const say = (text: string) => h.handle({ text, projectId: "harbor", threadKey: "web-harbor", reply: async () => undefined, typing: async () => undefined });
  await say("make it shorter");
  strictEqual(Object.values(h.state.proposals)[0]?.paseoAgent, OLD, "the revision keeps the pinned session");
  await say("yes");
  deepStrictEqual(sent, [OLD]);
  const { readTasks } = await import("../src/core/backlog.ts");
  deepStrictEqual(await readTasks(harbor), [], "a restart is not a backlog task");
  ok(channel.logged.some((l) => l.meta.type === "instruction" && /restart/i.test(l.text)), "logged as the restart it is");
  ok(!channel.logged.some((l) => l.meta.type === "handoff"), "never as a handoff");
});

test("a held restart whose session is gone: nothing sent, the owner told, the state saved — in control and in autonomous mode", async () => {
  const { loadState } = await import("../src/hub/state.ts");
  const UX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const OLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const sent: string[] = [];
  const exec = async (_file: string, args: string[]) => {
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: UX, status: "idle" }]) }; // OLD is gone
    if (args[0] === "send") {
      sent.push(args[1]!);
      return { stdout: '{"status":"sent"}' };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX, label: "Harbor UX" }] });
  await registerProject("harbor", harbor.root);
  const outcomes: string[] = [];
  const provider = {
    id: "fake",
    model: "fake",
    async run(request: { prompt: string; execute(name: string, input: unknown): Promise<{ content: string }> }) {
      if (request.prompt.includes("shorter")) outcomes.push((await request.execute("propose_agent_command", { project: "harbor", agent: "ux", prompt: "Limit reset: go on, briefly.", summary: "restart", owner_asked: true, irreversible: false })).content);
      return { text: "Ok.", model: "fake", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  };
  const channel = new ConsoleChannel();
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const h = new Hub({ config, channel, exec, provider: provider as never, toolExec: async () => ({ stdout: "" }), log: () => undefined });
  const t = Date.now();
  await h.tick(new Date(t));
  const held = () => ({ id: `held-${Math.random()}`, projectId: "harbor", from: "pm", to: "ux", ask: "restart", prompt: "The limit has reset: go on.", report: "loop-guard", createdAt: new Date(t).toISOString(), needsYes: true as const, paseoAgent: OLD, shownAt: new Date(t).toISOString(), expiresAt: new Date(t + 3_600_000).toISOString() });
  const replies: string[] = [];
  const say = (text: string) => h.handle({ text, projectId: "harbor", threadKey: "web-harbor", reply: async (r) => void replies.push(r), typing: async () => undefined });

  // Control: the owner approves it.
  h.state.handoffs = [held()];
  await say("yes");
  match(replies.at(-1)!, /Harbor UX/);
  deepStrictEqual(sent, []);
  strictEqual((await loadState())!.handoffs.length, 0, "the approved draft is gone, on disk too");

  // Autonomous: the owner asks for a change, which would go out at once.
  await h.setProjectMode("harbor", "autonomous", "panel");
  h.state.handoffs = [held()];
  await say("make it shorter");
  match(outcomes.at(-1)!, /Not sent: the session it was for is gone/);
  deepStrictEqual(sent, [], "never redirected to the newer session");
  strictEqual((await loadState())!.handoffs.length, 0);
  ok(!channel.logged.some((l) => l.meta.type === "handoff" && /restart/i.test(l.text)), "a restart is never logged as a handoff");
});
