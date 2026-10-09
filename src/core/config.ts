import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { UserError } from "./errors.ts";
import { LANGUAGES } from "../i18n/index.ts";
import { globalPaths } from "./paths.ts";

const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "use HH:MM");

export const PmConfigSchema = z.object({
  /** `anthropic` (official SDK) or any server speaking OpenAI Chat Completions. */
  provider: z.enum(["anthropic", "openai-compatible"]).default("anthropic"),
  model: z.string().default("claude-sonnet-5-5"),
  /** `xhigh` and `max` think longer, and cost more, on every model that takes effort. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  /** For `openai-compatible`: OpenRouter, Ollama, LM Studio, vLLM… */
  baseUrl: z.string().optional(),
  /** Name of the environment variable holding the key (never the key itself). */
  apiKeyEnv: z.string().optional(),
  /** Prices for models Leftoff has no table for, in USD per million tokens. */
  price: z.object({ input: z.number(), output: z.number() }).optional(),
  /** Tool-call rounds per answer before the PM must reply with what it has. */
  maxSteps: z.number().int().min(1).max(20).default(8),
  budget: z
    .object({
      /** Hard cap on PM spend per calendar month. 0 disables the PM's model. */
      monthlyUsd: z.number().nonnegative().default(5),
      /** Warn once when spend crosses this share of the cap. */
      warnAt: z.number().min(0).max(1).default(0.8),
    })
    .default({ monthlyUsd: 5, warnAt: 0.8 }),
});

export const TelegramConfigSchema = z.object({
  /** The forum supergroup the bot lives in. */
  chatId: z.number().optional(),
  /** Telegram user ids allowed to talk to the PM. Everyone else is ignored. */
  allowedUserIds: z.array(z.number()).default([]),
  /** project id → forum topic (message_thread_id). The General topic has none. */
  topics: z.record(z.string(), z.number()).default({}),
});

export const SpeakConfigSchema = z.object({
  /** `mirror` answers a voice note with a voice note; `always` speaks every reply and the stand-up. */
  mode: z.enum(["mirror", "always", "never"]).default("mirror"),
  /**
   * Deepgram Aura-2 voice. Unset: the default voice of the interface language (see `defaultVoice`).
   * Italian: aura-2-livia-it, -melia-, -maia-, -cinzia-, -demetra- (f); -dionisio-, -elio-, -flavio-, -cesare- (m).
   * See Deepgram's list of Aura-2 voices for the other languages.
   */
  model: z.string().optional(),
  /** Longest spoken answer (synthesis takes ~4 s per 100 characters); the rest stays in the text that always comes with it. */
  maxChars: z.number().int().min(100).max(1800).default(360),
  /** Opus bit rate in bit/s; Deepgram's default (12000) is thin for speech. */
  bitRate: z.number().int().min(4000).max(650000).default(32000),
  /** Overrides the built-in price (Aura-2 pay-as-you-go: 0.03 per 1,000 characters). */
  pricePer1kCharsUsd: z.number().nonnegative().optional(),
});

export const VoiceConfigSchema = z.object({
  speak: SpeakConfigSchema.default(SpeakConfigSchema.parse({})),
  provider: z.enum(["deepgram", "none"]).default("deepgram"),
  model: z.string().default("nova-3"),
  /** `multi` handles speech that mixes languages, such as your own language with English technical terms. */
  language: z.string().default("multi"),
  apiKeyEnv: z.string().default("DEEPGRAM_API_KEY"),
  /** Voice notes longer than this are refused before anything is uploaded. */
  maxSeconds: z.number().int().positive().default(180),
  /** Below this the PM shows what it heard instead of answering a possible mishearing. */
  minConfidence: z.number().min(0).max(1).default(0.6),
  /** Overrides the built-in price (Nova-3 pay-as-you-go: 0.0043 mono, 0.0052 multi). */
  pricePerMinuteUsd: z.number().nonnegative().optional(),
});

export const LimitsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Warn once per window cycle when this much has been used. */
  warnAtPercent: z.number().min(1).max(99).default(80),
  /** Codex: read the usage windows it logs in its session files. */
  codex: z.boolean().default(true),
  /** Claude Code: react to the limit-reached hook; there is no percentage for headless agents. */
  claude: z.boolean().default(true),
});

export const CommandsConfigSchema = z.object({
  /** Let the PM draft instructions for agents (always sent only after the owner says yes). */
  enabled: z.boolean().default(true),
  /** A draft nobody answered stops being approvable after this long; a stray "ok" later means nothing. */
  proposalTtlMinutes: z.number().int().min(5).max(1440).default(120),
  /** A ceiling on instructions sent in 24 hours, against a loop or a stuck key. */
  maxPerDay: z.number().int().min(1).max(500).default(30),
});

export const StatusChecksSchema = z.object({
  /** Let the PM ask a working agent for a status update when its last report has gone stale. */
  enabled: z.boolean().default(true),
  /** A working agent whose last report is older than this gets asked. */
  staleAfterMinutes: z.number().int().min(15).max(1440).default(120),
  /** Never ask the same agent more often than this. */
  minIntervalMinutes: z.number().int().min(15).max(1440).default(180),
  /** A ceiling across all agents in 24 hours; each ask spends the owner's subscription. */
  maxPerDay: z.number().int().min(1).max(100).default(8),
  /** Automatic asks happen only in this window (local time); the owner's night is not woken. */
  hours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"), end: z.string().regex(/^\d{2}:\d{2}$/).default("21:00") }).default({ start: "09:00", end: "21:00" }),
});

/** How much the PM may say on its own in chat: only what needs the owner; plus what finished; plus everything. */
export const NOTIFY_LEVELS = ["critical", "normal", "all"] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

export const WebConfigSchema = z.object({
  /** The control panel in the browser, served by the hub itself. */
  enabled: z.boolean().default(true),
  /** Loopback by default: only this machine can open it. Anything else needs LEFTOFF_WEB_TOKEN. */
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(4777),
  /**
   * Names the panel may be reached by when something forwards to it (`tailscale serve`, a reverse proxy).
   * Anything listed here is reachable by whoever can reach that name, so LEFTOFF_WEB_TOKEN is then required.
   */
  allowedHosts: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  schema: z.literal(1).default(1),
  /** Language of the PM's own messages; answers follow the user's language. */
  language: z.enum(LANGUAGES).default("en"),
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
  pm: PmConfigSchema.default(PmConfigSchema.parse({})),
  voice: VoiceConfigSchema.default(VoiceConfigSchema.parse({})),
  limits: LimitsConfigSchema.default(LimitsConfigSchema.parse({})),
  commands: CommandsConfigSchema.default(CommandsConfigSchema.parse({})),
  statusChecks: StatusChecksSchema.default(StatusChecksSchema.parse({})),
  web: WebConfigSchema.default(WebConfigSchema.parse({})),
  channel: z.enum(["telegram", "none"]).default("telegram"),
  telegram: TelegramConfigSchema.default(TelegramConfigSchema.parse({})),
  notify: z
    .object({
      quietHours: z
        .object({
          /** Disabled by default: the owner can enable them live with /quiet on. */
          enabled: z.boolean().default(false),
          start: HHMM.default("22:00"),
          end: HHMM.default("08:00"),
        })
        .default({ enabled: false, start: "22:00", end: "08:00" }),
      standupAt: HHMM.default("09:00"),
      /** How long commits may sit without a report before the PM mentions them. */
      unreportedAfterMinutes: z.number().int().positive().default(30),
      /** How often the hub looks at the repositories. */
      pollSeconds: z.number().int().min(10).default(60),
      /**
       * What the PM pushes to chat on its own. `critical` (default): an agent that is blocked or needs
       * you, a subscription limit reached, the answer to something you asked. `normal` adds finished
       * work and limit warnings; `all` adds unreported commits and automatic status answers. The
       * stand-up and answers to your own messages are never filtered. The control panel shows it all.
       */
      level: z.enum(NOTIFY_LEVELS).default("critical"),
    })
    .default({ quietHours: { enabled: false, start: "22:00", end: "08:00" }, standupAt: "09:00", unreportedAfterMinutes: 30, pollSeconds: 60, level: "critical" }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PmConfig = z.infer<typeof PmConfigSchema>;
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

export async function loadConfig(): Promise<Config> {
  const raw = await readFile(globalPaths.config(), "utf8").catch(() => null);
  const parsed = ConfigSchema.safeParse(raw ? (parseYaml(raw) ?? {}) : {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new UserError(`Invalid ${globalPaths.config()}:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

export async function saveConfig(config: Config): Promise<void> {
  const file = globalPaths.config();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, stringifyYaml(config, { lineWidth: 0 }), { encoding: "utf8", mode: 0o600 });
}

/**
 * Load `~/.config/leftoff/secrets.env` into the environment. Variables already
 * set win, so a key exported in the shell or by systemd overrides the file.
 * Values are never logged.
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const raw = await readFile(globalPaths.secrets(), "utf8").catch(() => "");
  const loaded: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const [, key = "", value = ""] = match;
    if (env[key] !== undefined) continue;
    env[key] = value.replace(/^(['"])(.*)\1$/, "$2");
    loaded.push(key);
  }
  return loaded;
}
