# Security policy

## Reporting a vulnerability

Please report security problems **privately**, using GitHub's *Report a vulnerability* button under the
repository's **Security** tab. Please don't open a public issue or pull request for a vulnerability.

Useful in a report: what you did, what happened, what you expected, the Leftoff version (`leftoff --version`), your
OS and Node version. This is a one-person project, so expect an acknowledgement within about a week and a fix or an
explanation as soon as it can be done; credit is given unless you prefer otherwise.

## Scope

In scope: anything that lets someone other than the owner read project data, drive the project manager, send an
instruction to an agent without the owner's approval, bypass the control panel's password, read or write files outside
a project, or run commands through Leftoff's hooks.

Out of scope: a compromised machine or account, a leaked key that the owner published, and the behaviour of Telegram,
Deepgram, a model provider, Claude Code, Codex or Paseo themselves. [docs/security.md](docs/security.md) lists what
Leftoff does and does not protect against.

## Supported versions

Only the latest release (and `main`).
