# Contributing to Leftoff Agents

Thanks for looking. Leftoff is a small project maintained by one person, so the best contributions are focused and
come with a reason. For anything bigger than a bug fix, please open an issue first so we agree on the shape before you
write it.

## Set up

```bash
git clone https://github.com/maubau/leftoff-agents.git
cd leftoff-agents
npm ci
npm test            # the whole suite
npm run typecheck
npm run demo        # the interface, with invented data
```

Needs Node.js 22.18+. There is no build step in development: `npm run dev -- <command>` runs the TypeScript
directly (`npm run dev -- brief`). `npm run build` produces `dist/`.

## The tests are hermetic — keep them so

`npm test` makes **no network calls, no model calls, and never touches your real `~/.claude`, `~/.codex`,
`~/.config/leftoff` or `~/.paseo`**. Tests that need a host call `isolateHost()` from `test/helpers.ts`, which points
all of those at a temporary directory; time-dependent code takes an injectable clock. A new test that reaches outside
the sandbox will be asked to change. New behaviour needs a test; a bug fix needs one that fails without the fix.

## Code conventions

- **TypeScript, run natively by Node** (type stripping): no `enum`, no constructor parameter properties, and imports
  carry the `.ts` extension. `npm run typecheck` is the authority.
- **Few dependencies.** There are five runtime dependencies; adding one needs a good reason in the pull request.
- **Write comments about why**, not what, and match the density of the code around yours.
- **User-visible text goes through `src/i18n/`.** Every language catalog must have every entry (the compiler checks).
  If you can't translate a sentence well, write the English and say so; a maintainer or another contributor can finish it.
- **Safety invariants are not negotiable** without a discussion: the PM drafts but never sends; "yes" is matched by
  code against a fixed list; private projects never reach chat or the panel; hooks always exit 0; text read from a
  repository is untrusted. They are explained in [docs/security.md](docs/security.md) and [docs/decisions.md](docs/decisions.md).

## Decisions

Design choices are recorded in [docs/decisions.md](docs/decisions.md) as `D-nnn` entries: the problem, the choice and
the reason. If your change makes or reverses a design choice, add or amend an entry in the same pull request.

## Pull requests

- One logical change per pull request, with a description of the problem it solves.
- `npm test` and `npm run typecheck` pass (CI runs them on Node 22 and 24).
- Don't reformat unrelated code.
- Don't commit anything from your own `.leftoff/`, keys, tokens, real project names or screenshots of real projects.
  Screenshots in the docs are generated from the demo (`npm run demo`) — keep it that way.

## Adding support for another coding agent or chat app

Hosts live in `src/hosts/` (one file per agent, behind a common interface: install, uninstall, doctor, which
hook events map to which duty), channels in `src/channels/`. Look at `claude-code.ts` and `telegram.ts`. Open an issue
first; it helps to know which hook or notification mechanism the tool offers.

## Reporting bugs

Please include the output of `leftoff hosts doctor` and `leftoff pm doctor`, your Node version and OS, and what you
expected. Never paste keys or tokens; check logs and reports for them before sharing. For security problems, see
[SECURITY.md](SECURITY.md).

## Conduct

Be kind and assume good faith; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
