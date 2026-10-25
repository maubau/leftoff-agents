import { deepStrictEqual, strictEqual } from "node:assert/strict";
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
