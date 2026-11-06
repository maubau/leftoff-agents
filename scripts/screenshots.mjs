/**
 * The README's screenshots, from the demo only: invented projects, agents and tasks, never anyone's real ones.
 *
 *   npm run demo -- --port 4790 > /tmp/demo.log &      # then, from a folder with the tools below installed:
 *   PLAYWRIGHT_DIR=/tmp/shot/ CHROME=…/chrome-headless-shell TWEMOJI=…/twemoji.woff2 \
 *     node scripts/screenshots.mjs /tmp/demo.log docs/images
 *
 * Needs `playwright-core` (in PLAYWRIGHT_DIR), a Chromium (CHROME) and `twemoji-colr-font`'s woff2 (TWEMOJI), none of
 * them dependencies of Leftoff. Pictures are 1080×675 at 2×, light and dark («-dark»). Emoji are Twemoji (CC-BY 4.0,
 * see docs/images/CREDITS.md), drawn as small images: headless Chromium does not draw colour emoji fonts reliably in
 * the live page. Optimise the PNGs afterwards (256 colours keeps them sharp at about 40% of the size).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_DIR ?? "/tmp/shot/");
const { chromium } = require("playwright-core");
const [log, out] = process.argv.slice(2);
const url = readFileSync(log, "utf8").match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/)[0];
const base = url.replace(/\?.*/, "");
const token = new URL(url).searchParams.get("token");
const FONT = readFileSync(process.env.TWEMOJI);
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });

/** Each emoji drawn once with Twemoji in a plain page (where it draws reliably), as a transparent PNG data URL. */
const cache = new Map();
async function emojiImages(chars) {
  const todo = chars.filter((c) => !cache.has(c));
  if (todo.length) {
    const ctx = await browser.newContext({ bypassCSP: true, deviceScaleFactor: 1 });
    await ctx.route("http://x.test/**", (r) => (r.request().url().endsWith("/tw.woff2") ? r.fulfill({ body: FONT, contentType: "font/woff2" }) : r.fulfill({ body: `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:Tw;src:url(/tw.woff2)} html,body{margin:0;background:transparent} #e{display:inline-block;font:64px/72px Tw;width:72px;height:72px;text-align:center}</style><body><span id="e">📌</span></body>`, contentType: "text/html; charset=utf-8" })));
    const page = await ctx.newPage();
    await page.goto("http://x.test/"); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400);
    for (const ch of todo) {
      await page.evaluate((c) => { document.getElementById("e").textContent = c; }, ch);
      await page.waitForTimeout(50);
      const png = await page.locator("#e").screenshot({ omitBackground: true });
      cache.set(ch, `data:image/png;base64,${png.toString("base64")}`);
    }
    await ctx.close();
  }
  return Object.fromEntries(chars.map((c) => [c, cache.get(c)]));
}

const EMOJI = /(\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*)/u;
const errors = [];
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1080, height: 675 }, deviceScaleFactor: 2, bypassCSP: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const shoot = async (name) => {
    await page.waitForTimeout(2500);
    const chars = await page.evaluate((src) => { const re = new RegExp(src, "gu"); const set = new Set(); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) for (const m of w.currentNode.textContent.matchAll(re)) set.add(m[0]); return [...set]; }, EMOJI.source);
    const imgs = await emojiImages(chars);
    // Swapped in just before the picture: the page re-renders every few seconds and would put the characters back.
    await page.evaluate(([src, map]) => {
      const re = new RegExp(src, "u");
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = []; while (w.nextNode()) if (re.test(w.currentNode.textContent) && !w.currentNode.parentElement.closest("select, option, textarea, pre, code")) nodes.push(w.currentNode);
      for (const node of nodes) {
        const frag = document.createDocumentFragment();
        for (const part of node.textContent.split(new RegExp(src, "u"))) {
          if (!part) continue;
          if (map[part]) { const img = document.createElement("img"); img.src = map[part]; img.alt = part; img.style.cssText = "height:1.15em;width:1.15em;vertical-align:-0.2em;display:inline"; frag.append(img); }
          else frag.append(part);
        }
        node.replaceWith(frag);
      }
    }, [EMOJI.source, imgs]);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${out}/${name}${scheme === "dark" ? "-dark" : ""}.png` });
  };
  await page.goto(url); await page.waitForSelector(".room-card"); await page.waitForTimeout(1500);
  await shoot("overview");
  await page.goto(base + "#/p/clipforge"); await page.waitForSelector(".phead"); await page.waitForTimeout(1500);
  // The office is what this picture is for: the page scrolled to its heading.
  await page.evaluate(() => { const h = [...document.querySelectorAll("#main h2")].find((e) => /office/i.test(e.textContent)); const m = document.getElementById("main"); if (h) m.scrollTop = h.offsetTop - m.offsetTop - 16; });
  await shoot("project");
  const tasks = await page.evaluate((t) => fetch("/api/owner-tasks?status=open", { headers: { authorization: `Bearer ${t}` } }).then((r) => r.json()), token);
  const key = tasks.tasks.find((x) => x.title.startsWith("Add the voice service key"));
  await page.goto(base + `#/tasks/${key.id}`); await page.waitForSelector(".tp-msgs .msg"); await page.waitForTimeout(1500);
  await shoot("tasks");
  await ctx.close();
}
console.log("errors:", errors.length ? errors : "none");
await browser.close();
