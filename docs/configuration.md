# Configuration

Settings live in `~/.config/leftoff/config.yaml` (or `$XDG_CONFIG_HOME/leftoff/`, or `$LEFTOFF_CONFIG_DIR`). Every key
is optional; a missing file means all defaults. An invalid file stops the command with the list of problems.
Restart the hub after editing (`systemctl --user restart leftoff-hub`).

Keys and tokens never go in this file: they live in `secrets.env` (one `NAME=value` per line), or in the environment,
which wins. The file's directory is created with mode 700.

## Secrets

| Variable | For |
|---|---|
| `ANTHROPIC_API_KEY` | The PM's model (default provider). Name configurable with `pm.apiKeyEnv`. |
| `TELEGRAM_BOT_TOKEN` | The Telegram bot. |
| `DEEPGRAM_API_KEY` | Voice. Name configurable with `voice.apiKeyEnv`. |
| `LEFTOFF_WEB_TOKEN` | The control panel's password; generated for you on first start. |

## Reference

```yaml
language: en              # en | it | de | fr | es | pt — the PM's own messages
timezone: Europe/Rome     # default: the system's
channel: telegram         # telegram | none

pm:
  provider: anthropic     # anthropic | openai-compatible
  model: claude-sonnet-5-5
  effort: low             # low | medium | high
  baseUrl: …              # openai-compatible only: OpenRouter, Ollama, LM Studio, vLLM…
  apiKeyEnv: …
  price: { input: 3, output: 15 }   # USD per million tokens, for models Leftoff has no price for
  maxSteps: 8             # tool-call rounds per answer
  budget:
    monthlyUsd: 5         # hard cap; 0 turns the PM's model off
    warnAt: 0.8

notify:
  level: critical         # critical | normal | all — see /alerts
  standupAt: "09:00"
  quietHours: { enabled: false, start: "22:00", end: "08:00" }
  unreportedAfterMinutes: 30
  pollSeconds: 60

commands:                 # instructions to agents
  enabled: true
  proposalTtlMinutes: 120 # a draft nobody answered stops being approvable
  maxPerDay: 30

statusChecks:             # the PM asking a quiet working agent for an update (needs Paseo)
  enabled: true
  staleAfterMinutes: 120
  minIntervalMinutes: 180
  maxPerDay: 8
  hours: { start: "09:00", end: "21:00" }

limits:                   # subscription limits
  enabled: true
  warnAtPercent: 80
  codex: true
  claude: true

web:
  enabled: true
  host: 127.0.0.1         # anything else requires LEFTOFF_WEB_TOKEN
  port: 4777
  allowedHosts: []        # names reachable through tailscale serve / a reverse proxy

voice:
  provider: deepgram      # deepgram | none
  model: nova-3
  language: multi         # speech that mixes languages
  maxSeconds: 180
  minConfidence: 0.6
  speak:
    mode: mirror          # mirror (voice for voice) | always | never
    model: …              # default: the Aura-2 voice of your language
    maxChars: 360

telegram:                 # written by `leftoff connect telegram`
  chatId: …
  allowedUserIds: […]
  topics: {…}
```

### PM

**Another Anthropic model:** change `pm.model`. **A local or third-party model:**

```yaml
pm:
  provider: openai-compatible
  baseUrl: http://localhost:11434/v1     # e.g. Ollama
  model: qwen3:32b
  apiKeyEnv: OLLAMA_API_KEY              # any non-empty value if the server ignores it
```

The PM relies on tool calling, so the model must support it. Spend is tracked per call; for models without a built-in
price, set `pm.price`, or the budget cannot protect you.

### Per-project settings

`<repo>/.leftoff/project.yaml` holds the project's `name`, `purpose`, `visibility` (`public` | `private`) and its agents.
A `private` project does not exist as far as the chat and the panel are concerned: it is never mentioned, pushed or
readable there. (`leftoff ask` in your own terminal can still see it, so its text goes to your model provider.)

### Chat commands

`/overview` (cross-project view) · `/mute <project> [hours]` / `/unmute <project>` · `/quiet on|off` ·
`/alerts critical|normal|all` · `/voice on|off|auto` · `/language <code>` · `/resume <project> [agent]`.
Each has aliases in the other languages. `/language`, `/alerts`, `/quiet` and `/voice` are kept in the hub's state and
override `config.yaml` until changed again.
