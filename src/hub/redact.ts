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
  // Credentials in a URL: postgres://user:pass@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, "$1[redacted]$3"],
  // A header: Authorization: Bearer …, Basic …, Token ….
  [/\b(authorization:\s*(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi, "$1[redacted]"],
  // A flag and its value after a space: --password hunter2.
  [/(--(?:password|passwd|secret|token|api[_-]?key)\s+)(?!-)(\S+)/gi, "$1[redacted]"],
];

/**
 * Names whose value is a secret: password, secret, token, api key, with any prefix or suffix joined by «_»
 * (db_password, SMTP_PASSWORD, secret_key); and the upper-case .env forms that are only secret as such (DB_PASS,
 * AWS_SECRET_ACCESS_KEY, X_PRIVATE_KEY). An optional quote after the name is JSON's (`"password": …`).
 */
const NAMES: RegExp[] = [
  /\b((?:[A-Za-z0-9]+_)*(?:password|passwd|secret|token|api[_-]?key)(?:_[A-Za-z0-9]+)*)(["']?)(\s*([:=])\s*)/gi,
  /\b((?:[A-Z0-9]+_)*(?:PASS|ACCESS_KEY|PRIVATE_KEY)(?:_[A-Z0-9]+)*)(["']?)(\s*([:=])\s*)/g,
];

/** A reference to a secret, not the secret: $X (upper case, as variables are named), ${x}, $(cmd), ${{ x }}, {{ x }}, <x>, %X%. */
const REFERENCE = /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[^}]*\}|\$\([^)]*\)|\$\{\{.*\}\}|\{\{.*\}\}|<[^>]*>|%\w+%)$/s;
/** After «:» prose is common («token: we decided»): an unquoted value there must look like one. */
const looksLikeValue = (v: string) => v.length >= 6 && (/[\d_\-+/=.!@#%^&*]/.test(v) || v.length >= 16);
const QUOTES = ["'", '"', "`"];

/** Where the unquoted reference that starts here ends, or -1: `$(…)`, `${…}`, `${{ … }}`, `{{ … }}`, `<…>`. */
function referenceEnd(text: string, at: number, lineEnd: number): number {
  const opens: Array<[string, string]> = [["${{", "}}"], ["{{", "}}"], ["$(", ")"], ["${", "}"], ["<", ">"]];
  for (const [open, close] of opens) {
    if (!text.startsWith(open, at)) continue;
    const end = text.slice(at + open.length, lineEnd).indexOf(close);
    return end >= 0 ? at + open.length + end + close.length : -1;
  }
  return -1;
}

/**
 * The value after each secret's name goes, never the name, the separator or a quote, so a command keeps working:
 * `grep '^X_TOKEN=' file`, an empty `X_TOKEN=`, `X_TOKEN=$(cat f)` stay as they are. After «=» any value goes; after
 * «:» an unquoted one only if it looks like a value. A quote after the separator closes an argument opened to its left
 * on the same line (the grep) rather than opening a value.
 */
function namedValues(text: string, names: RegExp): string {
  let out = "";
  let from = 0;
  names.lastIndex = 0;
  // The line being read, and how many of each quote it has up to `counted`: kept as the matches move on, so a long
  // line is read once, not once per name on it.
  let lineStart = -1;
  let lineEnd = 0;
  let counted = 0;
  const counts: Record<string, number> = { "'": 0, '"': 0, "`": 0 };
  for (let m = names.exec(text); m; m = names.exec(text)) {
    const start = m.index;
    const pos = start + m[0].length;
    if (start < from) continue;
    const nameQuote = m[2] ?? "";
    // After «:», or after «=» and a space (`X_TOKEN= empty`, a comment on an empty value), an unquoted value must
    // look like one; right after «=» anything is.
    const loose = m[4] === ":" || /\s$/.test(m[3] ?? "");
    if (start >= lineEnd || lineStart < 0) {
      lineStart = text.lastIndexOf("\n", start) + 1;
      const nl = text.indexOf("\n", start);
      lineEnd = nl < 0 ? text.length : nl;
      counted = lineStart;
      for (const q of QUOTES) counts[q] = 0;
    }
    for (; counted < start; counted++) {
      const ch = text[counted]!;
      if (ch in counts) counts[ch]!++;
    }
    // A quote opened before the name, on this line, and not closed: the argument the name sits in.
    const enclosing = QUOTES.find((q) => (counts[q]! + (q === nameQuote ? 1 : 0)) % 2 === 1);
    out += text.slice(from, pos);
    from = pos;
    const c = text[pos] ?? "";
    let value: [number, number] | undefined;
    let skip: number | undefined;
    if (QUOTES.includes(c) && c !== enclosing) {
      let close = pos + 1;
      while (close < lineEnd && text[close] !== c) close++;
      if (close < lineEnd) {
        const inner = text.slice(pos + 1, close);
        if (inner.trim() && !REFERENCE.test(inner.trim())) value = [pos + 1, close];
        else skip = close + 1;
      }
    }
    if (!value && skip === undefined) {
      const ref = referenceEnd(text, pos, lineEnd);
      if (ref >= 0) skip = ref;
      else {
        let end = pos;
        while (end < lineEnd && !/\s/.test(text[end]!) && text[end] !== enclosing) end++;
        while (end > pos && /[;,)]/.test(text[end - 1]!)) end--;
        const token = text.slice(pos, end);
        if (token && !REFERENCE.test(token) && (!loose || looksLikeValue(token))) value = [pos, end];
      }
    }
    if (value) {
      out += text.slice(pos, value[0]) + "[redacted]";
      from = value[1];
      names.lastIndex = value[1];
    } else if (skip !== undefined) names.lastIndex = skip;
  }
  return out + text.slice(from);
}

export function redact(text: string): string {
  const out = PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
  return NAMES.reduce((acc, names) => namedValues(acc, names), out);
}
