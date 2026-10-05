/**
 * Last line of defence before anything leaves the machine. Reports are written
 * by agents, and agents sometimes paste what they should not.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-…[redacted]"],
  [/sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g, "sk-…[redacted]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh…[redacted]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_…[redacted]"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA…[redacted]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "xox…[redacted]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[telegram token redacted]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key redacted]"],
  [/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]"],
];

export function redact(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
