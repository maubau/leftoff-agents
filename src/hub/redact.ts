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
  // Backblaze B2's account and upload tokens, wherever they are: «4_» then hex, then underscored parts.
  [/\b4_[0-9a-f]{25,}_[A-Za-z0-9_+/=-]{16,}/g, "4_…[redacted]"],
  // A key named in prose, after a space: «auth token 9f8e…», «secret Xy7…». Only what looks like one: 20 characters
  // or more, with a digit or a symbol.
  [/\b(token|secret|password|api[ _-]?key)(\s+)(?=[A-Za-z0-9_+/=.-]*[\d_+/=.-])([A-Za-z0-9_+/=.-]{20,})/gi, "$1$2[redacted]"],
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
  // camelCase too: accountAuthToken, authorizationToken, clientSecret, dbPassword.
  /\b((?:[A-Za-z0-9]+_)*[A-Za-z0-9]*?(?:password|passwd|secret|token|api[_-]?key)(?:_[A-Za-z0-9]+)*)(["']?)([ \t]*([:=])[ \t]*)/gi,
  /\b((?:[A-Z0-9]+_)*(?:PASS|ACCESS_KEY|PRIVATE_KEY)(?:_[A-Z0-9]+)*)(["']?)([ \t]*([:=])[ \t]*)/g,
];

/** A reference to a secret, not the secret: $X (upper case, as variables are named), ${x}, $(cmd), ${{ x }}, {{ x }}, <x>, %X%. */
const REFERENCE = /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[^}]*\}|\$\([^)]*\)|\$\{\{.*\}\}|\{\{.*\}\}|<[^>]*>|%\w+%)$/s;
/** After «:» prose is common («token: we decided»): an unquoted value there must look like one. */
const looksLikeValue = (v: string) => v.length >= 6 && (/[\d_\-+/=.!@#%^&*]/.test(v) || v.length >= 16);
const QUOTES = ["'", '"', "`"];

/**
 * Where the unquoted reference that starts here ends, or -1: `$(…)`, `${…}`, `${{ … }}`, `{{ … }}`, `<…>`. It must be
 * the whole value — what follows it is a space, the end of the line, the enclosing quote, `;` or `)` — and it is looked for within
 * REFERENCE_MAX characters, so a long line of unclosed ones costs nothing.
 */
const REFERENCE_MAX = 200;
function referenceEnd(text: string, at: number, lineEnd: number, enclosing: string | undefined): number {
  const opens: Array<[string, string]> = [["${{", "}}"], ["{{", "}}"], ["$(", ")"], ["${", "}"], ["<", ">"]];
  for (const [open, close] of opens) {
    if (!text.startsWith(open, at)) continue;
    const found = text.slice(at + open.length, Math.min(lineEnd, at + REFERENCE_MAX)).indexOf(close);
    if (found < 0) return -1;
    const end = at + open.length + found + close.length;
    const next = text[end] ?? "";
    return end >= lineEnd || /[\s;)]/.test(next) || next === enclosing ? end : -1;
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
  let lineStart = -1;
  let lineEnd = 0;
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
    }
    // The argument the name sits in: a quote right before it, with an optional «^» (`grep '^X_TOKEN=' f`,
    // `-e "X_TOKEN=…"`). An apostrophe anywhere else on the line («it's», «don't») is prose, not an argument.
    const lead = text.slice(Math.max(lineStart, start - 2), start);
    const enclosing = nameQuote ? undefined : QUOTES.find((q) => lead.endsWith(q) || lead.endsWith(`${q}^`));
    out += text.slice(from, pos);
    from = pos;
    const c = text[pos] ?? "";
    let value: [number, number] | undefined;
    let skip: number | undefined;
    if (QUOTES.includes(c) && c !== enclosing) {
      let close = pos + 1;
      while (close < lineEnd && text[close] !== c) close++;
      const inner = text.slice(pos + 1, close);
      // No close on the line, or a space right after it: this quote closes something (`grep '^export X_TOKEN=' f`),
      // it does not open a value.
      if (close >= lineEnd || /^\s/.test(inner)) skip = pos + 1;
      else if (inner.trim() && !REFERENCE.test(inner.trim())) value = [pos + 1, close];
      else skip = close + 1;
    }
    if (!value && skip === undefined) {
      const ref = referenceEnd(text, pos, lineEnd, enclosing);
      if (ref >= 0) skip = ref;
      else {
        let end = pos;
        while (end < lineEnd && !/\s/.test(text[end]!) && text[end] !== enclosing) end++;
        while (end > pos && /[;,)]/.test(text[end - 1]!)) end--;
        const token = text.slice(pos, end);
        if (token && !REFERENCE.test(token) && (!loose || looksLikeValue(token))) value = [pos, end];
      }
    }
    // YAML: `password:` with the value alone, indented, on the next line.
    if (!value && skip === undefined && m[4] === ":" && /^[ \t]*\r?$/.test(text.slice(pos, lineEnd)) && lineEnd < text.length) {
      const next = /^([ \t]+)(\S+?)[ \t]*\r?(?:\n|$)/.exec(text.slice(lineEnd + 1, lineEnd + 1 + REFERENCE_MAX * 5));
      if (next && looksLikeValue(next[2]!) && !REFERENCE.test(next[2]!)) {
        const at = lineEnd + 1 + next[1]!.length;
        value = [at, at + next[2]!.length];
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
