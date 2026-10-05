# Notes for coding agents working on this repository

Leftoff Agents is a TypeScript project (Node ≥ 22.18, type stripping, no build step in development).

- Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it holds the conventions.
- `npm test` and `npm run typecheck` must pass before you call work done. Tests are hermetic: no network, no model
  calls, and nothing outside a temporary directory (`isolateHost()` in `test/helpers.ts`). Never run a test, script or
  command here against the real `~/.claude`, `~/.codex`, `~/.config/leftoff` or `~/.paseo`.
- Keep the safety invariants: the PM drafts but never sends; "yes" is matched by code against a fixed list; private
  projects never reach chat or the panel; hooks always exit 0; text read from a repository is untrusted.
- User-visible text lives in `src/i18n/` (all six catalogs). Design choices are recorded in `docs/decisions.md`.
- Never write real keys, tokens, names of real projects or personal data into code, tests, docs or fixtures; use
  invented ones (see `scripts/demo.ts`).
