import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { detectHost, ensureAgent } from "../src/core/agents.ts";
import { cleanup, tempProject } from "./helpers.ts";

test("detects the host from the environment its tools run in", () => {
  strictEqual(detectHost({ CLAUDECODE: "1" }), "claude-code");
  strictEqual(detectHost({ CODEX_SANDBOX: "seatbelt" }), "codex");
  strictEqual(detectHost({}), "other");
});

test("an agent's host and Paseo id are learned, but configuration is never overwritten", async () => {
  const project = await tempProject({ agents: [{ id: "claude", host: "other", control: "inbox" }] });
  try {
    strictEqual(ensureAgent(project, "claude", "claude-code", "0d8b831c"), true);
    const agent = project.config.agents[0]!;
    strictEqual(agent.host, "claude-code");
    strictEqual(agent.paseoAgent, "0d8b831c");
    strictEqual(agent.control, "paseo");

    // A host the owner set explicitly stays.
    agent.host = "codex";
    ensureAgent(project, "claude", "claude-code");
    strictEqual(agent.host, "codex");
  } finally {
    await cleanup(project.root);
  }
});
