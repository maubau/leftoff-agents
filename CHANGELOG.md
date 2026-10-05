# Changelog

## 0.1.0 — first public release

- Hooks for Claude Code and Codex that make agents report after each turn into `<repo>/.leftoff/`.
- `leftoff init`, `brief`, `report`, `inbox`, `state`, `hosts`, `projects`, `ask`, `pm`, `connect`, `hub`, `web`.
- The hub: a polling loop over every repository and worktree, with templated alerts and a daily stand-up.
- The project manager: Anthropic (default) or any OpenAI-compatible model, a monthly spending cap, tools that read
  reports, decisions, backlog and git history, and a drafting tool for instructions that only the owner's "yes" can send.
- Telegram (a forum group with a topic per project), a browser control panel with a sprint board, and Deepgram voice.
- Subscription-limit warnings and automatic restarts after a reset; status asks for quiet agents.
- Optional Paseo integration for live delivery, workspace agents and worktrees.
- Six languages: English, Italian, German, French, Spanish, Portuguese.
