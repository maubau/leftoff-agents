import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { segments, telegramHtml } from "../src/web/public/codeblocks.js";

/** What to copy, apart from what to read (D-068). An invented key: it unlocks nothing. */
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleOnlyNotARealKey0000000000000000 site-publish@example-host";

test("a fenced block is kept whole, as it must be pasted; inline code is marked; the rest stays text", () => {
  const text = `Paste this line, whole:\n\`\`\`\n${KEY}\n\`\`\`\nThen run \`ls -la\`.`;
  deepStrictEqual(segments(text), [
    { type: "text", value: "Paste this line, whole:\n" },
    { type: "code", value: KEY },
    { type: "text", value: "\nThen run " },
    { type: "inline", value: "ls -la" },
    { type: "text", value: "." },
  ]);
  deepStrictEqual(segments("```bash\necho one\necho two\n```"), [{ type: "code", value: "echo one\necho two", lang: "bash" }]);
  deepStrictEqual(segments("cut short ```\necho x"), [{ type: "text", value: "cut short " }, { type: "code", value: "echo x" }], "an open fence is still code");
  deepStrictEqual(segments("no code here"), [{ type: "text", value: "no code here" }]);
});

test("for Telegram: code in <pre> and <code>, which a tap copies, and nothing in a message becomes markup", () => {
  strictEqual(telegramHtml(`Key:\n\`\`\`\n${KEY}\n\`\`\``), `Key:\n<pre>${KEY}</pre>`);
  strictEqual(telegramHtml("Run `a && b` <now> & then"), "Run <code>a &amp;&amp; b</code> &lt;now&gt; &amp; then");
  strictEqual(telegramHtml("```\n<script>x</script>\n```"), "<pre>&lt;script&gt;x&lt;/script&gt;</pre>");
});

test("the panel's light Markdown: bold, italics, lists and headings as pieces, never HTML; code stays code", async () => {
  const { markdown, inlineMarks } = await import("../src/web/public/codeblocks.js");
  const blocks = markdown("Ecco cosa fare:\n\n**Passo 1**: apri il pannello.\n- uno con `npm test`\n- due *corsivo*\n\n1. primo\n2. secondo\n\n## Fine\n```bash\nnpm ci\n```\nsnake_case_name e 2*3*4");
  deepStrictEqual(blocks.map((b) => b.type), ["para", "list", "list", "heading", "code", "para"]);
  deepStrictEqual(blocks[0], { type: "para", inline: [{ type: "text", value: "Ecco cosa fare:\n\n" }, { type: "strong", value: "Passo 1" }, { type: "text", value: ": apri il pannello." }] });
  deepStrictEqual(blocks[1], { type: "list", ordered: false, items: [[{ type: "text", value: "uno con " }, { type: "inline", value: "npm test" }], [{ type: "text", value: "due " }, { type: "em", value: "corsivo" }]] });
  deepStrictEqual(blocks[2], { type: "list", ordered: true, start: 1, items: [[{ type: "text", value: "primo" }], [{ type: "text", value: "secondo" }]] });
  deepStrictEqual(blocks[4], { type: "code", value: "npm ci", lang: "bash" });
  deepStrictEqual(blocks[5], { type: "para", inline: [{ type: "text", value: "snake_case_name e 2*3*4" }] }, "no italics inside words or sums");
  deepStrictEqual(inlineMarks("__bold__ and _it_ and ** not bold **"), [{ type: "strong", value: "bold" }, { type: "text", value: " and " }, { type: "em", value: "it" }, { type: "text", value: " and ** not bold **" }]);
  deepStrictEqual(markdown("<b>x</b>"), [{ type: "para", inline: [{ type: "text", value: "<b>x</b>" }] }], "markup stays text");
  deepStrictEqual(markdown(""), []);
});

test("links: [text](https://…) and http only; anything else, and any markup, stays text", async () => {
  const { markdown, inlineMarks, safeHref } = await import("../src/web/public/codeblocks.js");
  deepStrictEqual(inlineMarks("see [the guide](https://example.com/a?b=1) now"), [
    { type: "text", value: "see " },
    { type: "link", value: "the guide", href: "https://example.com/a?b=1" },
    { type: "text", value: " now" },
  ]);
  deepStrictEqual(inlineMarks("[plain](http://x.io)"), [{ type: "link", value: "plain", href: "http://x.io/" }]);
  for (const bad of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](/relative)", "[x](ftp://host/file)", "[x]( https://spaced.io)"]) {
    ok(inlineMarks(bad).every((m) => m.type === "text"), bad);
  }
  strictEqual(safeHref("javascript:alert(1)"), null);
  strictEqual(safeHref("HTTPS://Example.com"), "https://example.com/");
  strictEqual(safeHref("not a url"), null);
  deepStrictEqual(markdown("<script>alert(1)</script>"), [{ type: "para", inline: [{ type: "text", value: "<script>alert(1)</script>" }] }], "a script tag is words, never markup");
  deepStrictEqual(markdown("**<img src=x onerror=alert(1)>**"), [{ type: "para", inline: [{ type: "strong", value: "<img src=x onerror=alert(1)>" }] }], "inside bold too");
  deepStrictEqual(markdown("```html\n<script>x</script>\n**not bold**\n```"), [{ type: "code", value: "<script>x</script>\n**not bold**", lang: "html" }], "a code block keeps everything as written, Markdown included");
});

test("the panel builds Markdown as nodes, with links that open apart, and keeps Copy on code", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(app.includes('import { markdown } from "/codeblocks.js";') && app.includes("return markdown(text).map((b) => {"), "richText reads the Markdown");
  ok(app.includes('h("a", { class: "md-link", href: m.href, target: "_blank", rel: "noopener noreferrer"'), "links open apart, without opener");
  ok(app.includes('h("pre", { text: b.value }), button)'), "code blocks keep Copy");
  ok(!/innerHTML/.test(app), "no innerHTML anywhere in the page");
});

test("an unclosed «**» or «__» on a long line stays fast: bold spans at most 1,000 characters", async () => {
  const { markdown } = await import("../src/web/public/codeblocks.js");
  for (const input of ["**a ".repeat(25_000), "__a ".repeat(25_000)]) {
    const started = Date.now();
    markdown(input);
    ok(Date.now() - started < 1000, `${input.slice(0, 4)}… on one line`);
  }
});
