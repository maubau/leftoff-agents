/**
 * A fictional Leftoff installation to look at: six invented projects (one with no agent yet), their agents, reports, backlog,
 * limits and a conversation with the project manager, served in the browser — no agents, no Telegram,
 * no API keys. Everything lives in a temporary directory that is removed on exit.
 *
 *   npm run demo                 # then open the printed link
 *   npm run demo -- --port 4781
 *   npm run demo -- --paseo-model   # pretend Paseo can switch an agent's model from its command line
 *   npm run demo -- --paseo-down    # the first new project stops at its Paseo step, to see Retry
 *
 * The data is made up. The code path is the real one: the same data layer, server and web page as a
 * real installation, fed by files written the way agents and the hub write them.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
const { createTask, updateTask } = await import("../src/core/backlog.ts");
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
const { Settings } = await import("../src/web/settings.ts");
const { ProjectJobs } = await import("../src/hub/project-jobs.ts");

const argPort = process.argv.indexOf("--port");
const port = argPort > 0 ? Number(process.argv[argPort + 1]) : 4780;
const paseoModelFlag = process.argv.includes("--paseo-model");
let paseoDown = process.argv.includes("--paseo-down");
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
  /** A macro plan (D-051): its tasks phase by phase, and what Leftoff opened by itself for instructions and handoffs. */
  plan?: {
    id: string;
    goal: string;
    status: "collecting" | "shown" | "approved";
    asked: string[];
    phases: Array<[string, Array<{ key: string; title: string; agent: string; status?: "To Do" | "In Progress" | "Done"; after?: string[]; proposed?: boolean }>]>;
    auto?: Array<{ title: string; agent: string; status: "To Do" | "In Progress" }>;
  };
}

const PROJECTS: ProjectSpec[] = [
  {
    id: "atlas",
    name: "Open Atlas",
    purpose: "Interactive map of robotics companies (Europe, USA, China), with submissions and moderation",
    todo: ["Add a CSV export of the company list", "Dark map style for the public page"],
    plan: {
      id: "20261012-atls", goal: "A moderation workflow for the companies people submit", status: "shown", asked: ["analyst", "main-dev"],
      phases: [
        ["1 · Data", [
          { key: "a1", title: "Define the moderation rules and the fields each submission needs", agent: "analyst", proposed: true },
          { key: "a2", title: "Model the moderation states in the database", agent: "main-dev", after: ["a1"], proposed: true },
        ]],
        ["2 · Review screen", [
          { key: "a3", title: "Moderation queue with approve and reject", agent: "main-dev", after: ["a2"], proposed: true },
          { key: "a4", title: "Write the list of rejection reasons", agent: "analyst", proposed: true },
        ]],
        ["3 · Launch", [{ key: "a5", title: "Check the first 40 companies by hand", agent: "analyst", after: ["a3"], proposed: true }]],
      ],
    },
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
    plan: {
      id: "20261010-clip", goal: "Subtitle burn-in for vertical video, from the editor to the export", status: "approved", asked: ["main-dev", "ux", "review"],
      phases: [
        ["1 · Design", [
          { key: "c1", title: "Caption style presets: sizes, colours, safe margins", agent: "ux", status: "Done" },
          { key: "c2", title: "Caption fields in the edit decision list", agent: "main-dev", status: "Done" },
        ]],
        ["2 · Build", [
          { key: "c3", title: "Burn captions into the 9:16 render", agent: "main-dev", status: "In Progress", after: ["c1", "c2"] },
          { key: "c4", title: "Export dialog with the caption options", agent: "ux", after: ["c3"] },
          { key: "c5", title: "Test plan for caption timing and wrapping", agent: "review", status: "In Progress" },
        ]],
        ["3 · Ship", [
          { key: "c6", title: "End-to-end review on three long recordings", agent: "review", after: ["c3", "c4", "c5"] },
          { key: "c7", title: "Release notes and the preset gallery", agent: "ux", after: ["c6"] },
        ]],
      ],
      auto: [
        { title: "Tune the caption timing (an instruction from the owner)", agent: "main-dev", status: "In Progress" },
        { title: "Expose the render progress for the export dialog (a handoff from the UX agent)", agent: "main-dev", status: "To Do" },
      ],
    },
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
    // Collecting: the content agent has written its part, the main developer has not yet.
    plan: {
      id: "20261012-shop", goal: "Open the shop for guided-experience bookings before the summer", status: "collecting", asked: ["content", "main-dev"],
      phases: [
        ["1 · Content", [
          { key: "s1", title: "Photos and alt text for the 14 product pages", agent: "content", proposed: true },
          { key: "s2", title: "Describe each guided experience, with dates and rules", agent: "content", proposed: true },
        ]],
        ["2 · Booking", [{ key: "s3", title: "Booking page copy and confirmation texts", agent: "content", after: ["s2"], proposed: true }]],
      ],
    },
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
  {
    // Registered, with a backlog, and nobody on it yet: its room in the building has the lights off.
    id: "orchard",
    name: "Orchard Club",
    purpose: "Newsletter and sign-up page for a community orchard",
    todo: ["Pick a newsletter tool", "Sketch the sign-up page"],
    agents: [],
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
/** The records of the demo's plans: the hub's state keeps them, the tasks are in the projects' backlogs. */
const demoPlans: Array<{ id: string; projectId: string; goal: string; askedAt: string; agents: string[]; status: "collecting" | "shown" | "approved" }> = [];
/** What each pretend Paseo agent runs on: `provider/model` and thinking level, as `paseo ls` says it. */
const runtimes = new Map<string, { provider: string; thinking: string }>();

mkdirSync(join(home, ".paseo"), { recursive: true });
writeFileSync(
  join(home, ".paseo", "config.json"),
  JSON.stringify({ agents: { providers: { "claude-work": { extends: "claude", label: "Claude (Work)", env: { CLAUDE_CONFIG_DIR: join(home, ".claude-work") } } } } }),
);

const config = ConfigSchema.parse({ language: "en", timezone: "Europe/London", channel: "telegram", projects: { root: join(root, "projects") } });

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
    runtimes.set(paseoAgent, a.host === "codex" ? { provider: "codex/gpt-5.4", thinking: "medium" } : { provider: "claude-work/claude-opus-5-5", thinking: "high" });
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
  if (spec.plan) {
    const ids = new Map<string, string>();
    for (const [phase, tasks] of spec.plan.phases) {
      for (const task of tasks) {
        const created = await createTask(project, {
          title: task.title, description: "A step of the plan, written by the agent it belongs to.", acceptanceCriteria: ["It is done and reported", "It has a test or a check"],
          labels: [`plan:${spec.plan.id}`, ...(task.proposed ? ["proposed"] : [])], priority: "medium", assignee: [task.agent], milestone: phase,
          dependencies: (task.after ?? []).map((key) => ids.get(key)!), ...(task.status === "In Progress" ? { status: "In Progress" as const } : {}),
        });
        ids.set(task.key, created.id);
        if (task.status === "Done") await updateTask(project, created.id, { status: "Done" });
      }
    }
    // What Leftoff opened by itself for an instruction or a handoff that had no task.
    for (const task of spec.plan.auto ?? []) {
      await createTask(project, { title: task.title, description: "Opened by Leftoff for an instruction.", acceptanceCriteria: [], labels: ["auto"], priority: "medium", assignee: [task.agent], status: task.status });
    }
    demoPlans.push({ id: spec.plan.id, projectId: spec.id, goal: spec.plan.goal, askedAt: ago(30), agents: spec.plan.asked, status: spec.plan.status });
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
// The steps between the PM and the agents have a register of their own (D-052), apart from the conversation.
const activity = new Feed(join(root, "activity-log.jsonl"));
await feed.load();
const say = (hoursAgo: number, projectId: string | null, role: "pm" | "owner", source: "telegram" | "web", kind: "push" | "reply" | "ask", text: string) =>
  feed.append({ at: ago(hoursAgo), projectId, role, source, kind, text });

type Step = [hoursAgo: number, projectId: string, type: "instruction" | "handoff" | "delivered" | "status" | "reply" | "report" | "task" | "expired" | "commits", agent: string | undefined, to: string | undefined, text: string];
const STEPS: Step[] = [
  [30, "clipforge", "instruction", "main-dev", undefined, "📤 Instruction to Clipforge Main Dev - Codex: «Burn the captions into the 9:16 render»\n✅ Sent to Clipforge Main Dev - Codex (Clipforge). It was working: it reads it when its turn ends."],
  [29, "clipforge", "delivered", "main-dev", undefined, "📨 Delivered to Clipforge Main Dev - Codex (Clipforge): it had finished its turn."],
  [27, "clipforge", "reply", "main-dev", undefined, "Captions render in the 9:16 layout; the safe margins still need checking on the vertical preview.\nNext: the margins, then the caption timing."],
  [26, "clipforge", "task", "main-dev", undefined, "📋 TASK-4 in progress: Burn captions into the 9:16 render"],
  [24, "clipforge", "handoff", "ux", "main-dev", "🤝 Handoff approved — Clipforge UX - Claude → Clipforge Main Dev - Codex: «The export dialog needs progress: GET /api/renders/:id with percent done and an ETA»\n✅ Sent to Clipforge Main Dev - Codex (Clipforge)."],
  [22, "clipforge", "status", "review", undefined, "❔ Asked Clipforge Test and Review - Codex for its status: it reads it when its turn ends."],
  [21, "clipforge", "report", "review", undefined, "Test plan for caption timing: 14 cases written, 3 waiting for the render. No blockers."],
  [9, "clipforge", "task", "ux", undefined, "📋 TASK-2 done: Caption style presets: sizes, colours, safe margins"],
  [8, "clipforge", "commits", undefined, undefined, "⚠️ 3 commits on feat/render-9x16 nobody reported."],
  [5, "clipforge", "expired", "ux", "review", "⌛ The handoff from Clipforge UX - Claude to Clipforge Test and Review - Codex expired: nobody approved it."],
  [18, "atlas", "instruction", "analyst", undefined, "🗺️ Asked Atlas Search Analyst for its part of the plan: «A moderation workflow for the companies people submit»"],
  [17, "atlas", "reply", "analyst", undefined, "Rules and fields drafted: 11 fields, 4 states. The rejection reasons list is next."],
  [12, "atlas", "status", "main-dev", undefined, "❔ Asked Atlas Main Dev - Claude for its status."],
];
for (const [hoursAgo, projectId, type, agent, to, text] of STEPS) {
  await activity.append({ at: ago(hoursAgo), projectId, role: "pm", source: "hub", kind: "log", text, activity: { type, ...(agent ? { agent } : {}), ...(to ? { to } : {}) } });
}
// What the chat shows when the hub grouped what it held back (D-052): a summary, and the details in the register.
await say(0.4, "clipforge", "pm", "telegram", "push", "🗂️ 7 notices on Clipforge, grouped so as not to write to you too often:\n• 📤 Instruction to Clipforge Main Dev - Codex\n• 📨 Delivered to Clipforge Main Dev - Codex\n• 📋 TASK-4 in progress\n… and 4 more.\nThe details are in the control panel.");

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

const channel = new MirrorChannel(new ConsoleChannel(), feed, activity);
const DEMO_MODELS: Record<string, Array<{ model: string; id: string; thinkingOptionIds: string[]; defaultThinkingOptionId: string }>> = {
  claude: [
    { model: "Opus 5.5", id: "claude-opus-5-5", thinkingOptionIds: ["low", "medium", "high", "xhigh", "max"], defaultThinkingOptionId: "medium" },
    { model: "Sonnet 5.5", id: "claude-sonnet-5-5", thinkingOptionIds: ["low", "medium", "high", "xhigh", "max"], defaultThinkingOptionId: "high" },
    { model: "Haiku 5.5", id: "claude-haiku-5-5", thinkingOptionIds: ["low", "medium", "high"], defaultThinkingOptionId: "medium" },
  ],
  codex: [{ model: "GPT-5.4", id: "gpt-5.4", thinkingOptionIds: ["low", "medium", "high"], defaultThinkingOptionId: "medium" }],
};
const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
  const [a, b, c] = args;
  if (a === "ls") return { stdout: JSON.stringify([...paseoIds].map(([id, status]) => ({ id, shortId: id.slice(0, 7), status, ...runtimes.get(id) }))) };
  if (a === "provider" && b === "models" && c && DEMO_MODELS[c]) return { stdout: JSON.stringify(DEMO_MODELS[c]) };
  if (a === "agent" && b === "update" && c === "--help") return { stdout: `  --name <name>\n  --thinking <id>\n${paseoModelFlag ? "  --model <id>\n" : ""}` };
  if (a === "provider" && b === "ls") {
    return { stdout: JSON.stringify([
      { provider: "claude-work", label: "Claude (Work)", status: "available", enabled: "Enabled" },
      { provider: "codex", label: "Codex", status: "available", enabled: "Enabled" },
    ]) };
  }
  // New agents (D-040): a pretend worktree and session, in the temporary directory.
  if (a === "workspace" && b === "create") {
    const title = args[args.indexOf("--title") + 1] ?? "agent";
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const cwd = join(root, "worktrees", slug);
    mkdirSync(cwd, { recursive: true });
    return { stdout: JSON.stringify({ workspaceId: `ws-${slug}`, project: "demo", name: slug, isolation: "worktree", cwd }) };
  }
  if (a === "workspace" && (b === "rename" || b === "archive")) return { stdout: "{}" };
  if (a === "run") {
    const id = `demo-new-${paseoIds.size + 1}`;
    const provider = args[args.indexOf("--provider") + 1]!;
    const model = args.includes("--model") ? args[args.indexOf("--model") + 1]! : (provider.startsWith("codex") ? "gpt-5.4" : "claude-opus-5-5");
    paseoIds.set(id, "running");
    runtimes.set(id, { provider: `${provider}/${model}`, thinking: args.includes("--thinking") ? args[args.indexOf("--thinking") + 1]! : "medium" });
    return { stdout: JSON.stringify({ agentId: id, status: "running", provider, cwd: "", title: "" }) };
  }
  if (a === "agent" && b === "update" && c && runtimes.has(c)) {
    // Model and thinking changes are pretend: they only change what `ls` says next.
    const now = runtimes.get(c)!;
    if (args[3] === "--model") now.provider = `${now.provider.split("/")[0]}/${args[4]}`;
    if (args[3] === "--thinking") now.thinking = args[4]!;
    return { stdout: JSON.stringify({ agentId: c, notice: null }) };
  }
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
for (const plan of demoPlans) hub.state.plans[plan.projectId] = plan;
hub.state.handoffs.push({
  id: "clipforge:demo#0", projectId: "clipforge", from: "ux", to: "main-dev", ask,
  prompt: messages("en").handoff.instruction({ from: "Clipforge UX - Claude", fromId: "ux", role: "frontend, UX and usability", ask, report: ".leftoff/reports/demo-ux.md", branch: null, commits: [] }),
  report: ".leftoff/reports/demo-ux.md", createdAt: new Date(now - 20 * 60_000).toISOString(),
  shownAt: new Date(now - 20 * 60_000).toISOString(), expiresAt: new Date(now + 100 * 60_000).toISOString(),
});
await say(0.3, "clipforge", "pm", "telegram", "push", `🤝 Handoff — 🎨 Clipforge UX - Claude → 🛠️ Clipforge Main Dev - Codex (Clipforge)\n${messages("en").delivery.draftBusy}\n────────\n${hub.state.handoffs[0]!.prompt}\n────────\nReply "yes" to send it, "no" to drop it, or tell me what to change. (Valid for 2 h.)`);

// New projects (D-056): real folders and git in the temporary directory, with the demo's identity, and a pretend
// Paseo that remembers its workspaces. Each step takes a moment, so the progress card can be watched.
const workspaces: Array<{ workspaceId: string; cwd: string; name: string }> = [];
const gitRun = promisify(execFile);
const pause = () => new Promise((r) => setTimeout(r, 700));
const projects = new ProjectJobs({
  config,
  state: () => hub.state,
  save: async () => undefined,
  onChange: (job) => void web?.projectJob(job),
  log: () => undefined,
  run: async (file, args, cwd) => {
    if (file === "git") {
      await pause();
      return gitRun("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.com" } });
    }
    if (args[0] === "workspace" && args[1] === "ls") return { stdout: JSON.stringify(workspaces) };
    if (args[0] === "workspace" && args[1] === "create") {
      await pause();
      if (paseoDown) {
        paseoDown = false;
        throw Object.assign(new Error("spawn paseo ENOENT"), { code: "ENOENT" });
      }
      const value = (flag: string) => args.find((x) => x.startsWith(`${flag}=`))!.slice(flag.length + 1);
      const made = { workspaceId: `ws-demo-${workspaces.length + 1}`, cwd: value("--path"), name: value("--title") };
      workspaces.push(made);
      return { stdout: JSON.stringify({ ...made, project: "demo", isolation: "local" }) };
    }
    throw new Error("this is a demo: Paseo is pretend");
  },
});
const settings = new Settings({ config, exec, modes: hub });
hub.attachProjects(projects);
hub.attachAgents(settings);

const { token } = await ensureWebToken();
web = new WebServer({ config: { enabled: true, host: "127.0.0.1", port, allowedHosts: [] }, data: new Data({ config, state: () => hub.state, exec }), feed, activity, mirror: channel, settings, projects, token, log: () => undefined });
await web.start();

process.stdout.write(`\nLeftoff demo — fictional projects, nothing real.\nOpen once: ${webLink({ ...config.web, port: web.port }, token)}\nCtrl-C to stop.\n`);
const stop = async () => {
  await web?.stop();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
