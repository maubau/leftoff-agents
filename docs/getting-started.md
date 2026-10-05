# Getting started

About fifteen minutes the first time, most of it in Telegram's menus. You can stop after step 3 and still have
something useful: reports, `leftoff brief` and the control panel work without any key or chat app.

## 0. Requirements

- **Node.js 22.18 or newer** (Leftoff runs TypeScript directly and builds to plain JavaScript) and **git**.
- Linux or macOS. The always-on service installer targets systemd; elsewhere run `leftoff hub` in a terminal, tmux
  or your own service manager.
- Optional: an Anthropic API key (or any OpenAI-compatible endpoint), a Telegram account, a Deepgram key.

## 1. Install

```bash
git clone https://github.com/maubau/leftoff-agents.git
cd leftoff-agents
npm ci && npm run build && npm link
leftoff --version
```

To look around first, with invented projects and no keys: `npm run demo`, then open the address it prints.

## 2. Set up a project

From the root of a git repository:

```bash
leftoff init --name "Harbor Guesthouse" --purpose "Direct-booking website for a small seaside guesthouse"
```

This:

- creates `.leftoff/` (a `project.yaml`, an empty `reports/` and `decisions.md`) — commit it, it is your project's memory;
- registers the repository in `~/.config/leftoff/projects.json` so the hub watches it;
- installs hooks into **Claude Code** (`~/.claude*/settings.json`) and **Codex** (`~/.codex/hooks/hooks.json`,
  `config.toml`), keeping a backup of every file it edits;
- adds a short reporting protocol to the repository's `AGENTS.md` (and `CLAUDE.md`, if you already have one), which
  is how agents learn to run `leftoff report`.

Use `--private` for a project the PM must never mention in chat or in the panel, and `--no-hooks` to leave your agent
configuration alone. `leftoff hosts uninstall` removes everything Leftoff added to the agents.

Check it:

```bash
leftoff hosts doctor
```

Now use your agents as usual. When a turn changes something they run `leftoff report`; look with:

```bash
leftoff brief          # this project on one screen
leftoff projects list  # everything watched
```

## 3. Open the control panel

```bash
leftoff hub            # leave it running (step 6 makes it permanent)
leftoff web link       # prints http://127.0.0.1:4777/… — open it once; a cookie keeps you signed in
```

The first start generates a password and stores it in `~/.config/leftoff/secrets.env`. For other devices, see
[remote-access.md](remote-access.md).

## 4. Give the project manager a model

The PM is a language model that reads your reports and answers. Put a key in `~/.config/leftoff/secrets.env`
(the directory is created with mode 700, the file should be 600). Do not type a key into a shell history — use
`read -rs`:

```bash
mkdir -p ~/.config/leftoff && umask 077
read -rsp "Anthropic API key: " KEY && echo && printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" >> ~/.config/leftoff/secrets.env; unset KEY
leftoff pm doctor      # checks the key with a free call
leftoff ask "where are we?"
```

The default is `claude-sonnet-5-5` with low effort and a hard cap of **$5 a month**; `leftoff pm spend` shows
what it has cost. To use another model or provider (OpenRouter, Ollama, LM Studio, vLLM), see
[configuration.md](configuration.md#pm).

## 5. Connect Telegram

1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the token.
2. Store it: `read -rsp "Bot token: " T && echo && printf 'TELEGRAM_BOT_TOKEN=%s\n' "$T" >> ~/.config/leftoff/secrets.env; unset T`
3. Run `leftoff connect telegram`, then in Telegram create a group, turn on **Topics** in its settings, add your bot
   as an administrator with the **Manage topics** right, and send `/connect` in the group.

Leftoff records the group and **your** Telegram user id; nobody else can talk to the PM. It creates one topic per
project, plus *General* for cross-project questions and the daily stand-up.

## 6. Keep it running

```bash
leftoff hub install-service      # systemd user service, starts at login
journalctl --user -u leftoff-hub -f
```

If the machine should keep running while you are logged out: `sudo loginctl enable-linger $USER` (the installer tells you).

## 7. Optional

- **Voice.** Add `DEEPGRAM_API_KEY=…` to `secrets.env`. Voice notes are transcribed; replies come back as voice when
  you sent voice. `/voice always|off|auto` changes that.
- **Language.** `language: it` in `~/.config/leftoff/config.yaml`, or `/language it` in chat.
- **Quiet hours and how much it pushes.** `/quiet on`, `/alerts critical|normal|all`.
- **Paseo.** Nothing to do; see [paseo.md](paseo.md).
- **Backlog.md.** If a repository has a [Backlog.md](https://github.com/MrLesk/Backlog.md) `backlog/` folder, its
  tasks feed the board, and the PM can add tasks to it.

## When something is off

`leftoff hosts doctor` for hooks, `leftoff pm doctor` for the model, `leftoff hub standup` to see what the stand-up
would say, and the hub's log (`journalctl --user -u leftoff-hub`). Agents do not report until their session is
restarted after `leftoff init` — hooks are read at session start.
