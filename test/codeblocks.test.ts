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

test("an unclosed «**» or «__» on a long line stays fast: bold spans at most 1,000 characters", async () => {
  const { markdown } = await import("../src/web/public/codeblocks.js");
  for (const input of ["**a ".repeat(25_000), "__a ".repeat(25_000)]) {
    const started = Date.now();
    markdown(input);
    ok(Date.now() - started < 1000, `${input.slice(0, 4)}… on one line`);
  }
});
