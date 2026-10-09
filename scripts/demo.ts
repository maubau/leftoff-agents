/**
 * A fictional Leftoff installation to look at: five invented projects, their agents, reports, backlog,
 * limits and a conversation with the project manager, served in the browser — no agents, no Telegram,
 * no API keys. Everything lives in a temporary directory that is removed on exit.
 *
 *   npm run demo                 # then open the printed link
 *   npm run demo -- --port 4781
 *
 * The data is made up. The code path is the real one: the same data layer, server and web page as a
 * real installation, fed by files written the way agents and the hub write them.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "leftoff-demo-"));
const home = join(root, "home");
// Point everything at the temporary directory *before* the modules that read these are loaded.
process.env.HOME = home;
process.env.LEFTOFF_CONFIG_DIR = join(root, "config");
process.env.CODEX_HOME = join(home, ".codex");
for (const key of ["PASEO_AGENT_ID", "CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_SANDBOX", "CODEX_THREAD_ID", "LEFTOFF_AGENT", "LEFTOFF_WEB_TOKEN"]) {
  delete process.env[key];
}

const { ConsoleChannel } = await import("../src/channels/console.ts");
const { MirrorChannel } = await import("../src/channels/mirror.ts");
const { ConfigSchema } = await import("../src/core/config.ts");
const { createTask } = await import("../src/core/backlog.ts");
const { recordDecision } = await import("../src/core/decisions.ts");
const { loadProject, ProjectSchema, saveProject } = await import("../src/core/project.ts");
const { registerProject } = await import("../src/core/registry.ts");
const { ReportSchema, writeReport } = await import("../src/core/report.ts");
const { ensureWebToken, webLink } = await import("../src/core/web-token.ts");
const { Hub } = await import("../src/hub/hub.ts");
const { messages } = await import("../src/i18n/index.ts");
const { recordClaudeLimit, recordClaudeOk } = await import("../src/limits/claude.ts");
const { recordSpend } = await import("../src/pm/ledger.ts");
const { Data } = await import("../src/web/data.ts");
const { Feed } = await import("../src/web/feed.ts");
const { WebServer } = await import("../src/web/server.ts");

const argPort = process.argv.indexOf("--port");
const port = argPort > 0 ? Number(process.argv[argPort + 1]) : 4780;
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

// ───────────────────────────── the fictional world ─────────────────────────────

type Live = "running" | "idle" | "closed";
interface AgentSpec {
  id: string;
  label: string;
  host: "claude-code" | "codex";
  live: Live;
  /** Hours since its last report; its report says what it is doing. */
  reportedAgo: number;
  status: "progress" | "done" | "blocked" | "needs_input" | "idle";
  done?: string[];
  doing?: string[];
  blocked?: string[];
  next?: string[];
  question?: { text: string; options: string[]; recommend?: string };
  branch?: string;
  /** Commits made after the last report: work nobody reported. */
  unreported?: number;
  /** Its job in the team (D-036). */
  role?: string;
}
interface ProjectSpec {
  id: string;
  name: string;
  purpose: string;
  agents: AgentSpec[];
  todo?: string[];
  decisions?: Array<{ hoursAgo: number; text: string; why?: string }>;
}

const PROJECTS: ProjectSpec[] = [
  {
    id: "atlas",
    name: "Open Atlas",
    purpose: "Interactive map of robotics companies (Europe, USA, China), with submissions and moderation",
    todo: ["Add a CSV export of the company list", "Dark map style for the public page"],
    decisions: [
      { hoursAgo: 30, text: "Keep a company's moderation history in the repository, not only in the database", why: "Auditable, and it survives a database restore" },
      { hoursAgo: 60, text: "Use vector tiles for the map", why: "The raster tiles were too slow on mobile" },
    ],
    agents: [
      {
        id: "main-dev", label: "Atlas Main Dev - Claude", host: "claude-code", live: "idle", reportedAgo: 12, status: "needs_input", branch: "main", role: "architect and backend; merges to main",
        done: ["Moderation queue shows pending submissions", "Duplicate companies are detected on submit"],
        question: { text: "The analyst session lost its worktree. Recreate it?", options: ["Yes: recreate it clean from the updated main", "No: Paseo handles it, or it works elsewhere"], recommend: "Yes: recreate it clean from the updated main" },
        blocked: ["The search console needs the owner's account"],
        next: ["Wire the CSV export to the new filters", "Review the open pull request"],
        unreported: 8,
      },
      {
        id: "analyst", label: "Atlas Search Analyst", host: "claude-code", live: "closed", reportedAgo: 8, status: "progress", branch: "analysis", role: "research and data",
        doing: ["Extend the silicon research: industrial and cobot companies first, then AMR and drones"],
        done: ["Mapped 41 of 259 candidate companies"], next: ["Verify funding data for the first 40"],
      },
    ],
  },
  {
    id: "clipforge",
    name: "Clipforge",
    purpose: "Guided video editing: turns long recordings into short clips, driven by an edit decision list",
    todo: ["Subtitle burn-in preset for vertical video"],
    decisions: [{ hoursAgo: 20, text: "The EDL is the contract: every render derives from a validated document", why: "One source of truth between the planner and the renderer" }],
    agents: [
      {
        id: "main-dev", label: "Clipforge Main Dev - Codex", host: "codex", live: "running", reportedAgo: 5, status: "progress", branch: "feat/render-9x16", role: "architect and backend; merges to main",
        done: ["PR #25 is green; local dubbing test delivered", "Render job is idempotent on retry"], doing: ["Vertical 9:16 layout with safe margins"],
        next: ["Caption styles from the preset list", "Benchmark the planner on three long recordings"], blocked: ["The user picks option A or B on a voice service, not local"],
      },
      { id: "ux", label: "Clipforge UX - Claude", host: "claude-code", live: "idle", reportedAgo: 7, status: "done", role: "frontend, UX and usability", done: ["Clip editor: trim handles, keyboard nudge", "Empty states for the clip list"], next: ["Usability pass on the export dialog"] },
      { id: "review", label: "Clipforge Test and Review - Codex", host: "codex", live: "idle", reportedAgo: 9, status: "idle", role: "tests and code review", done: ["Review of the render pipeline: two findings, both fixed"] },
    ],
  },
  {
    id: "harbor",
    name: "Harbor Guesthouse",
    purpose: "Direct-booking website for a small seaside guesthouse, to avoid marketplace fees",
    todo: ["Translate the policy pages (EN, IT, DE)", "Add a «how to get here» page"],
    agents: [{ id: "main-dev", label: "Harbor Main Dev - Claude", host: "claude-code", live: "idle", reportedAgo: 50, status: "progress", done: ["Booking form with date validation"], doing: ["Calendar sync from the marketplace feed, about half"], next: ["Finish the sync, then tests"], branch: "main" }],
  },
  {
    id: "storefront",
    name: "Storefront Shop",
    purpose: "Online shop for water, wine and merchandise, with bookable guided experiences",
    todo: ["Order confirmation emails", "Stock levels on the product page"],
    agents: [
      { id: "content", label: "Storefront Content Audit - Codex", host: "codex", live: "idle", reportedAgo: 49, status: "done", role: "content and copy", done: ["Content audit: 14 product pages need photos"], next: ["Write alt text for the hero images"] },
      { id: "main-dev", label: "Storefront Main Dev - Claude", host: "claude-code", live: "idle", reportedAgo: 52, status: "progress", doing: ["Checkout: shipping rules by country"], done: ["Cart persists across sessions"] },
    ],
  },
  {
    id: "ledger",
    name: "Ledger",
    purpose: "Bookkeeping app for freelancers: invoices, expenses and VAT reports",
    agents: [{ id: "main-dev", label: "Ledger Main Dev - Claude", host: "claude-code", live: "idle", reportedAgo: 30, status: "done", done: ["VAT report matches the tax office's example", "Invoice PDF numbering is gap-free"], next: ["Quarterly summary view"], branch: "main" }],
  },
];

// ───────────────────────────────── seed the world ─────────────────────────────────

/** Run git with a fixed identity, and optionally at a given time — so "unreported work" is exactly what the scene says. */
const sh = (cwd: string, args: string[], at?: string) =>
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.com", ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) },
  });
const paseoIds = new Map<string, string>();

mkdirSync(join(home, ".paseo"), { recursive: true });
writeFileSync(
  join(home, ".paseo", "config.json"),
  JSON.stringify({ agents: { providers: { "claude-work": { extends: "claude", label: "Claude (Work)", env: { CLAUDE_CONFIG_DIR: join(home, ".claude-work") } } } } }),
);

const config = ConfigSchema.parse({ language: "en", timezone: "Europe/London", channel: "telegram" });

for (const spec of PROJECTS) {
  const dir = join(root, "projects", spec.id);
  mkdirSync(dir, { recursive: true });
  sh(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), `# ${spec.name}\n`);
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "-m", "Initial commit"], ago(24 * 30));

  const agents = spec.agents.map((a, i) => {
    const paseoAgent = `${spec.id}-${a.id}-${1000 + i}`;
    paseoIds.set(paseoAgent, a.live);
    return { id: a.id, control: "paseo" as const, host: a.host, paseoAgent, label: a.label, workspace: join(dir, ".worktrees", a.id), ...(a.role ? { role: a.role } : {}) };
  });
  await saveProject(dir, ProjectSchema.parse({ id: spec.id, name: spec.name, purpose: spec.purpose, agents, initializedAt: ago(24 * 30) }));
  const project = await loadProject(dir);
  await registerProject(spec.id, dir);

  for (const [i, a] of spec.agents.entries()) {
    await writeReport(
      project,
      ReportSchema.parse({
        agent: a.id, host: a.host, at: ago(a.reportedAgo), status: a.status,
        done: a.done ?? [], doing: a.doing ?? [], blocked: a.blocked ?? [], next: a.next ?? [],
        question: a.question ? { text: a.question.text, options: a.question.options, ...(a.question.recommend ? { recommend: a.question.recommend } : {}) } : null,
        commits: [], paseoAgent: agents[i]!.paseoAgent, ...(a.branch ? { branch: a.branch } : {}),
      }),
    );
  }
  for (const title of spec.todo ?? []) {
    await createTask(project, { title, description: "Planned work, written in the project's backlog.", acceptanceCriteria: ["It works end to end", "It has a test"], labels: [], priority: "medium" });
  }
  for (const d of spec.decisions ?? []) await recordDecision(project, { at: ago(d.hoursAgo), by: "user", text: d.text, ...(d.why ? { why: d.why } : {}) });

  // The project's own notes and backlog are committed, long ago: nothing here is "unreported work"...
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "-m", "Project notes and backlog"], ago(24 * 20));
  // ...except what the scene says nobody reported: commits made after the agent's last report.
  for (const a of spec.agents) {
    for (let n = 0; n < (a.unreported ?? 0); n++) sh(dir, ["commit", "-q", "--allow-empty", "-m", `Work in progress ${n + 1}`], ago(10 - n * 0.1));
  }
}

// What the PM itself has cost this month, and what each subscription has left.
for (const [i, cost] of [0.07, 0.05, 0.04, 0.03, 0.02].entries()) {
  await recordSpend({ at: ago(i * 20 + 2), provider: "anthropic", model: "claude-sonnet-5-5", costUsd: cost, inputTokens: 9000, outputTokens: 700, cacheReadTokens: 6000, purpose: "ask" });
}
mkdirSync(process.env.CODEX_HOME!, { recursive: true });
const sessions = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "04");
mkdirSync(sessions, { recursive: true });
writeFileSync(
  join(sessions, "rollout-demo.jsonl"),
  JSON.stringify({ timestamp: new Date(now - 600_000).toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 41, window_minutes: 300, resets_at: Math.floor((now + 2.2 * 3_600_000) / 1000) }, secondary: { used_percent: 66, window_minutes: 10080, resets_at: Math.floor((now + 3.1 * 86_400_000) / 1000) } } } }) + "\n",
);
await recordClaudeLimit({ error: "rate_limit", error_details: "5-hour limit reached ∙ resets 3pm" }, now - 46 * 3_600_000, "Europe/London");
await recordClaudeOk(now - 45 * 3_600_000);
await recordClaudeLimit({ error: "rate_limit", error_details: "5-hour limit reached ∙ resets 3pm" }, now - 49 * 3_600_000, "Europe/London", undefined, { slug: "work", label: "Work" });
await recordClaudeOk(now - 48 * 3_600_000, { slug: "work", label: "Work" });

// ───────────────────────── the conversation with the PM ─────────────────────────

const feed = new Feed(join(root, "feed.jsonl"));
await feed.load();
const say = (hoursAgo: number, projectId: string | null, role: "pm" | "owner", source: "telegram" | "web", kind: "push" | "reply" | "ask", text: string) =>
  feed.append({ at: ago(hoursAgo), projectId, role, source, kind, text });

await say(30, null, "pm", "telegram", "push", "📋 Stand-up for Friday\n• Open Atlas: waiting for you · ❓ Atlas Main Dev: recreate the analyst worktree?\n• Clipforge: 3 reports in the last 24h · next: caption styles from the preset list\n• Harbor Guesthouse: quiet for 2 days\nSpend, last 7 days: development not reported, PM $0.21");
await say(26, null, "owner", "web", "ask", "Where are we with Harbor?");
await say(26, null, "pm", "web", "reply", "Harbor Guesthouse: the last report is from 2 days ago (Harbor Main Dev, Claude).\n✅ Done: booking form with date validation.\n🔄 In progress: calendar sync from the marketplace feed, about half.\nNext: finish the sync, then tests.\nNothing is blocked, but nobody has reported for 50 hours.");
await say(25, null, "owner", "web", "ask", "Tell Claude on Harbor to sync every 15 minutes, not hourly");
await say(25, null, "pm", "web", "reply", "I'll ask Harbor Main Dev to change the sync interval to 15 minutes and add a test for it. I assume the feed allows polling that often.\n\n📨 Draft for Harbor Main Dev — Harbor Guesthouse\n💤 Idle: this message will start it again.\n────────\nChange the calendar sync interval from hourly to every 15 minutes. Keep the retry/backoff as it is and add a test that covers the new interval.\nAssumption: the marketplace feed tolerates a request every 15 minutes; if it rate-limits us, say so in your report and propose the lowest safe interval.\n────────\nReply «yes» to send it, «no» to drop it, or tell me what to change.");
await say(25, null, "owner", "web", "ask", "yes");
await say(25, null, "pm", "web", "reply", "✅ Sent to Harbor Main Dev (Harbor Guesthouse). It was idle: it starts again now. I'll tell you when it answers.");
await say(23, "harbor", "pm", "telegram", "push", "↩️ Answer from Harbor Main Dev to your instruction:\n✅ Harbor Main Dev finished: calendar sync every 15 minutes, with a test.\nNext: translate the policy pages.");
await say(12, "atlas", "pm", "telegram", "push", "❓ Atlas Main Dev needs you.\nThe analyst session lost its worktree. Recreate it?\n1. Yes: recreate it clean from the updated main\n2. No: Paseo handles it, or it works elsewhere\nRecommends: Yes: recreate it clean from the updated main");
await say(5, "clipforge", "pm", "telegram", "push", "↩️ Update from Clipforge Main Dev (asked for by the PM):\n🔄 Clipforge Main Dev: PR #25 is green; local dubbing test delivered; vertical 9:16 layout in progress");
await say(1, null, "owner", "web", "ask", "What is blocked?");
await say(1, null, "pm", "web", "reply", "One thing waits for you: Open Atlas — the analyst session lost its worktree, and Atlas Main Dev recommends recreating it from the updated main.\nClipforge has one open question for the owner about the voice service (option A or B), not blocking the renders.\nEverything else is moving.");

// ─────────────────────────────────── serve it ───────────────────────────────────

const channel = new MirrorChannel(new ConsoleChannel(), feed);
const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
  if (args[0] === "ls") return { stdout: JSON.stringify([...paseoIds].map(([id, status]) => ({ id, shortId: id.slice(0, 7), status }))) };
  throw new Error("this is a demo: no agent is really running");
};
// The hub tells the panel when the PM writes to an agent, so the office walks the right visit (a handoff, a question, an order).
let web: InstanceType<typeof WebServer> | undefined;
const hub = new Hub({
  config,
  channel,
  exec,
  onContact: (contact) => void web?.contact(contact),
  provider: {
    id: "demo", model: "demo",
    async run() {
      return { text: "This is a demo installation, so I can only give canned answers. In a real one I answer from your agents' reports, decisions and backlog.", model: "demo", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, steps: 1, toolCalls: [] };
    },
  },
  log: () => undefined,
});
await channel.start((message) => hub.handle(message));

// A handoff waiting for the owner: the UX agent needs an endpoint only the main developer can add (D-036).
const ask = "The export dialog needs progress: GET /api/renders/:id with percent done and an ETA";
hub.state.handoffs.push({
  id: "clipforge:demo#0", projectId: "clipforge", from: "ux", to: "main-dev", ask,
  prompt: messages("en").handoff.instruction({ from: "Clipforge UX - Claude", fromId: "ux", role: "frontend, UX and usability", ask, report: ".leftoff/reports/demo-ux.md", branch: null, commits: [] }),
  report: ".leftoff/reports/demo-ux.md", createdAt: new Date(now - 20 * 60_000).toISOString(),
  shownAt: new Date(now - 20 * 60_000).toISOString(), expiresAt: new Date(now + 100 * 60_000).toISOString(),
});
await say(0.3, "clipforge", "pm", "telegram", "push", `🤝 Handoff — 🎨 Clipforge UX - Claude → 🛠️ Clipforge Main Dev - Codex (Clipforge)\n🟢 Working now: it will read this right away without stopping.\n────────\n${hub.state.handoffs[0]!.prompt}\n────────\nReply "yes" to send it, "no" to drop it, or tell me what to change. (Valid for 2 h.)`);

const { token } = await ensureWebToken();
web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port, allowedHosts: [] }, data: new Data({ config, state: () => hub.state, exec }), feed, mirror: channel, token, log: () => undefined });
await web.start();

process.stdout.write(`\nLeftoff demo — fictional projects, nothing real.\nOpen once: ${webLink({ ...config.web, port: web.port }, token)}\nCtrl-C to stop.\n`);
const stop = async () => {
  await web?.stop();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
