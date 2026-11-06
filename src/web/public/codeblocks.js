// What to copy, apart from what to read: fenced blocks (```…```) and `inline code` in a message, found once and used
// by the panel (a block with a Copy button) and by Telegram (<pre> and <code>, which a tap copies). Plain JavaScript:
// the browser loads it as is.

/**
 * The message cut into pieces: text, a code block (`lang` is the word after the fence, if any) or inline code. A fence
 * left open runs to the end of the message, so a block cut short is still shown as code, never as broken prose.
 */
export function segments(text) {
  const out = [];
  const push = (type, value, lang) => {
    if (type === "text" && !value) return;
    out.push(lang ? { type, value, lang } : { type, value });
  };
  const fence = /```([\w+-]*)[ \t]*\n?([\s\S]*?)(?:\n?```|$(?![\s\S]))/g;
  let last = 0;
  for (const m of String(text).matchAll(fence)) {
    inline(String(text).slice(last, m.index), push);
    push("code", m[2] ?? "", m[1] || undefined);
    last = m.index + m[0].length;
  }
  inline(String(text).slice(last), push);
  return out;
}

function inline(text, push) {
  let last = 0;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    push("text", text.slice(last, m.index));
    push("inline", m[1]);
    last = m.index + m[0].length;
  }
  push("text", text.slice(last));
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escape = (s) => s.replace(/[&<>]/g, (c) => ESCAPES[c]);

/** Telegram's HTML: everything escaped, code blocks in <pre>, inline code in <code>. */
export function telegramHtml(text) {
  return segments(text)
    .map((s) => (s.type === "code" ? `<pre>${escape(s.value)}</pre>` : s.type === "inline" ? `<code>${escape(s.value)}</code>` : escape(s.value)))
    .join("");
}

/**
 * A light Markdown for the panel's chats: fenced code, then by line lists (- * + or 1.), headings (#) and paragraphs,
 * and inside a line `code`, **bold** / __bold__, *italic* / _italic_ and [links](https://…) — http and https only. It
 * gives pieces, never HTML: the page builds them as text nodes, so nothing a message says becomes markup (a <script>
 * is shown as the words «<script>»). Anything else stays as written.
 */
export function markdown(text) {
  const out = [];
  for (const s of fences(String(text ?? ""))) {
    if (s.type === "code") out.push(s);
    else out.push(...lines(s.value));
  }
  return out;
}

function fences(text) {
  const out = [];
  const fence = /```([\w+-]*)[ \t]*\n?([\s\S]*?)(?:\n?```|$(?![\s\S]))/g;
  let last = 0;
  for (const m of text.matchAll(fence)) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push(m[1] ? { type: "code", value: m[2] ?? "", lang: m[1] } : { type: "code", value: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

const LIST = /^\s{0,3}(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

function lines(text) {
  const out = [];
  let para = [];
  const flush = () => {
    // Blank lines at a paragraph's edges belong to the gap around it, which the blocks already make.
    while (para.length && !para[0].trim()) para.shift();
    while (para.length && !para.at(-1).trim()) para.pop();
    if (para.length) out.push({ type: "para", inline: inlineMarks(para.join("\n")) });
    para = [];
  };
  for (const line of text.split("\n")) {
    const item = LIST.exec(line);
    const heading = item ? null : HEADING.exec(line);
    if (item) {
      flush();
      const ordered = Boolean(item[2]);
      const last = out.at(-1);
      if (last?.type === "list" && last.ordered === ordered) last.items.push(inlineMarks(item[3]));
      else out.push({ type: "list", ordered, ...(ordered ? { start: Number(item[2]) } : {}), items: [inlineMarks(item[3])] });
    } else if (heading) {
      flush();
      out.push({ type: "heading", inline: inlineMarks(heading[1]) });
    } else para.push(line);
  }
  flush();
  return out;
}

/** A link's address, if it is one a page may open: http or https, whole. Anything else (javascript:, data:, relative) is not. */
export function safeHref(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Inside a line: `code`, [text](https://…), **bold** or __bold__, *italic* or _italic_ (not inside a word: snake_case stays). */
export function inlineMarks(text) {
  const out = [];
  const marks = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g;
  let last = 0;
  for (const m of text.matchAll(marks)) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "inline", value: m[1] });
    else if (m[2] !== undefined) {
      const href = safeHref(m[3]);
      out.push(href ? { type: "link", value: m[2], href } : { type: "text", value: m[0] });
    } else if (m[4] !== undefined || m[5] !== undefined) out.push({ type: "strong", value: m[4] ?? m[5] });
    else out.push({ type: "em", value: m[6] ?? m[7] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
