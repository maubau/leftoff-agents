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

test("six handoffs about the same pull request in a day are review rounds without end", () => {
  deepStrictEqual(pullRequestsIn("review PR #120, then fix #121 and pull request 7"), ["120", "121", "7"]);
  const rounds = Array.from({ length: 6 }, (_, i) => ({ projectId: "harbor", from: i % 2 ? "qa" : "ux", to: i % 2 ? "ux" : "qa", ask: `round ${i} on PR #120`, at: at(i) }));
  const [signal] = reviewRounds("harbor", rounds, now);
  deepStrictEqual([signal!.subject, signal!.count, signal!.other], ["#120", 6, "ux, qa"]);
  deepStrictEqual(reviewRounds("harbor", rounds.slice(0, 5), now), []);
  deepStrictEqual(reviewRounds("lighthouse", rounds, now), [], "another project's handoffs");
});

test("an answer awaited for more than three hours, with no report since, is a wait; CI runs too often are a storm", () => {
  deepStrictEqual(waitingAnswers("harbor", [{ asker: "ux", target: "qa", deliveredAt: at(4) }], now).map((s) => [s.agent, s.subject, s.count]), [["ux", "qa", 4]]);
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
