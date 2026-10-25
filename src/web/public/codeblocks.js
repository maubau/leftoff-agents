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
