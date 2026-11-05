/**
 * Last line of defence before anything leaves the machine. Reports are written
 * by agents, and agents sometimes paste what they should not.
 */
/**
 * A secret's value after its name: an optional quote, then at least six characters with no space or quote, not a
 * reference (`$X`, `<x>`, `{{x}}`, `%x%`), with a digit or a symbol in it, or sixteen characters long; then the same
 * quote. Groups: 3 the quote, 4 the value.
 */
const VALUE = String.raw`(['"]?)(?![$<{%])((?=[^\s'"\`]*[\d_\-+/=.!@#%^&*])[^\s'"\`]{6,}|[^\s'"\`]{16,})\3`;

/**
 * Between quotes, spaces and all, at least six characters, not already redacted, and not starting with a space: in
 * `grep '^TOKEN=' file && echo 'ok'` the quote after «=» closes the pattern, it does not open a value. Groups: 3, 4.
 */
const QUOTED = String.raw`(['"])(?!\[redacted\])(?!\s)([^'"\n]{6,})\3`;
const ENV_NAME = "(?:[A-Z0-9]+_)*(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY)(?:_[A-Z0-9]+)*";

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-…[redacted]"],
  [/sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g, "sk-…[redacted]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh…[redacted]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_…[redacted]"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA…[redacted]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "xox…[redacted]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[telegram token redacted]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key redacted]"],
  // A named value: only the value goes, never the name, the «=» or a quote — `grep '^TOKEN=' file`, an empty
  // `TOKEN=` or a reference such as `$TOKEN`, `<token>` or `{{token}}` stay as they are, so a command still works.
  // `password: x` in any case. After «:» prose is common («token: we decided»), so a value there must look like one:
  // a digit or a symbol in it, or long.
  // A quoted value may hold spaces: everything between the quotes goes, the quotes stay.
  [new RegExp(`\\b(password|passwd|secret|token|api[_-]?key)(\\s*[:=]\\s*)${QUOTED}`, "gi"), "$1$2$3[redacted]$3"],
  [new RegExp(`\\b(password|passwd|secret|token|api[_-]?key)(\\s*[:=]\\s*)${VALUE}`, "gi"), "$1$2$3[redacted]$3"],
  // The .env forms, upper case: SMTP_PASSWORD=x, DB_PASS=x, SECRET_KEY=x, AWS_SECRET_ACCESS_KEY=x, STRIPE_API_KEY=x.
  // Code such as `id_token: string` is left alone.
  [new RegExp(`\\b(${ENV_NAME})(\\s*=\\s*)${QUOTED}`, "g"), "$1$2$3[redacted]$3"],
  [new RegExp(`\\b(${ENV_NAME})(\\s*=\\s*)${VALUE}`, "g"), "$1$2$3[redacted]$3"],
];

export function redact(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
