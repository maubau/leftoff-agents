import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { isolateHost } from "./helpers.ts";

/**
 * The demo is how the panel is looked at, and where its screenshots come from: a new project made in it goes through the
 * real jobs, with real git in the demo's own temporary directory and a pretend Paseo, and ends as a room on the Home.
 */
test("the demo makes a new project from the panel's API, step by step, and it becomes a room", { timeout: 60_000 }, async () => {
  const dir = await isolateHost("leftoff-demo-test-");
  const child = spawn(process.execPath, ["scripts/demo.ts", "--port", "0"], { env: { ...process.env, HOME: dir, TMPDIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let out = "";
    child.stdout.setEncoding("utf8");
    const link = await new Promise<URL>((resolve, reject) => {
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/.exec(out);
        if (found) resolve(new URL(found[0]));
      });
      child.once("exit", (code) => reject(new Error(`the demo stopped (${code}): ${out}`)));
    });
    const token = link.searchParams.get("token")!;
    const api = async (path: string, body?: unknown) => {
      const res = await fetch(new URL(path, link), {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as any };
    };

    strictEqual((await api("/api/projects/options")).json.paseo, "available");
    strictEqual((await api("/api/projects/check", { name: "Clipforge" })).status, 409, "a demo project's name is taken");
    const started = await api("/api/projects", { name: "Orchard Club", purpose: "A community orchard" });
    strictEqual(started.status, 202);
    let job = started.json.job;
    for (let i = 0; i < 100 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      job = (await api(`/api/projects/jobs/${job.id}`)).json.job;
    }
    deepStrictEqual(job.steps.map((s: { status: string }) => s.status), ["done", "done", "done", "done", "done"]);
    const room = (await api("/api/overview")).json.projects.find((p: { id: string }) => p.id === "orchard-club");
    ok(room, "the new project is on the Home");
    ok(Number.isInteger(room.theme), "with its own theme");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});
