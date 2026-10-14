import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { LEFT_KEEP, canRetry, cardsToShow, failedStep, leave, listOutcome, readLeft, retryPath, writeLeft, type Job } from "../src/web/public/jobs.js";

const steps = (done: number, failedAt?: string, retryable = true) =>
  ["folder", "repository", "leftoff", "registry", "paseo"].map((id, i) => ({
    id,
    status: (failedAt === id ? "failed" : i < done ? "done" : i === done && !failedAt ? "running" : "pending") as "failed" | "done" | "running" | "pending",
    ...(failedAt === id ? { retryable, error: { type: "paseo_unavailable" } } : {}),
  }));

test("what the browser stored as left is read safely: anything unexpected is nothing, never an error", () => {
  for (const raw of [null, undefined, "", "{", "not json", "42", '"a string"', "{}", "null", "[1, 2, {}]", JSON.stringify([""]), JSON.stringify(["x".repeat(201)])]) {
    deepStrictEqual([...readLeft(raw)], [], String(raw));
  }
  deepStrictEqual([...readLeft(JSON.stringify(["a", 3, "b", null, "a"]))], ["a", "b"], "the strings in it, once each");
  const many = Array.from({ length: 80 }, (_, i) => `job-${i}`);
  const kept = readLeft(JSON.stringify(many));
  strictEqual(kept.size, LEFT_KEEP, "no more than it keeps");
  ok(kept.has("job-79") && !kept.has("job-0"), "the newest");
  deepStrictEqual([...readLeft(writeLeft(new Set(["x", "y"])))], ["x", "y"], "what it writes, it reads back");
});

test("Leave it as it is only remembers: it changes no job and asks nothing of the hub", () => {
  const before = new Set(["old"]);
  const after = leave(before, { id: "new" });
  deepStrictEqual([...before], ["old"], "the set it was given is untouched");
  deepStrictEqual([...after].sort(), ["new", "old"]);
});

test("the Home shows the creations running or stopped, from anywhere, but not finished, not the form's own, not left", () => {
  const jobs: Job[] = [
    { id: "b", status: "failed", steps: steps(4, "paseo"), startedAt: "2026-10-13T10:02:00Z" },
    { id: "a", status: "running", steps: steps(2), startedAt: "2026-10-13T10:01:00Z" },
    { id: "done", status: "done", steps: steps(5), startedAt: "2026-10-13T10:00:00Z" },
    { id: "mine", status: "running", steps: steps(1), startedAt: "2026-10-13T10:03:00Z" },
    { id: "left", status: "failed", steps: steps(4, "paseo"), startedAt: "2026-10-13T10:04:00Z" },
  ];
  deepStrictEqual(cardsToShow(jobs, { mine: "mine", left: new Set(["left"]) }).map((j) => j.id), ["a", "b"], "oldest first, so cards do not jump");
  deepStrictEqual(cardsToShow([]).length, 0);
});

test("a stopped creation can be retried only from a failed step the hub says can be, and Retry asks only for that", () => {
  const stopped: Job = { id: "job 1/x", status: "failed", steps: steps(4, "paseo") };
  ok(canRetry(stopped));
  strictEqual(failedStep(stopped)?.id, "paseo");
  ok(!canRetry({ id: "j", status: "failed", steps: steps(4, "paseo", false) }), "not when the hub says it cannot");
  ok(!canRetry({ id: "j", status: "running", steps: steps(2) }), "not while it runs");
  ok(!canRetry({ id: "j", status: "done", steps: steps(5) }));
  strictEqual(failedStep({ id: "j", status: "running", steps: steps(2) }), null);
  strictEqual(retryPath(stopped), "/api/projects/jobs/job%201%2Fx/retry", "the id is encoded, and it is a retry, nothing else");
});

test("the list of creations is asked again after a failure, but not from a hub that has none", () => {
  strictEqual(listOutcome(null), "loaded");
  strictEqual(listOutcome({ status: 404 }), "unsupported");
  strictEqual(listOutcome({ status: 500 }), "retry");
  strictEqual(listOutcome({ status: 503 }), "retry");
  strictEqual(listOutcome({}), "retry", "a network error has no status: ask again");
});

test("the page wires the cycle to these rules: no deletion, no request on leave, the list retried", async () => {
  const js = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(!/method:\s*"DELETE"/.test(js), "the panel deletes something");
  const leaveFn = /function leaveJob\(job\) \{([\s\S]*?)\n\}/.exec(js)?.[1] ?? "";
  ok(leaveFn && !/api\(|jsonPost\(|fetch\(/.test(leaveFn), "Leave it as it is asks the hub for something");
  ok(/readLeft\(/.test(js) && !/JSON\.parse\([^)]*leftoff_left_jobs/.test(js), "what was left is read unsafely");
  ok(/listOutcome\(error\) !== "retry"/.test(js), "a failed list is not asked again");
});

test("«+ New project» sits next to the Home's title and opens the same form there; Escape closes it", async () => {
  const app = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(/h\("h2", \{ text: t\(\)\.projects \}\),\s*S\.projectOptions && !S\.newProject \? h\("button", \{ id: "np-open"/.test(app), "the button is in the title's row, only on a hub that makes projects");
  ok(app.includes('onclick: () => openNewProject("top")') && app.includes('S.newProject?.at === "top" ? newProjectSlot() : null'), "it opens the same form, under the title");
  ok(app.includes('onclick: () => openNewProject("plot")'), "the plot at the end still opens it in its place");
  ok(/ev\.key === "Escape" && !N\.busy\) closeNewProject\(\)/.test(app), "Escape closes the form");
});
