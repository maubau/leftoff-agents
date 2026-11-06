import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PROJECT_COLORS, projectColor, projectTagClass } from "../src/web/public/projectcolor.js";

test("a project's colour comes from its id alone: the same everywhere, one of the ten", () => {
  for (const id of ["harbor", "clipforge", "orchard-club", "atlas", "", "ä-ß-项目"]) {
    const c = projectColor(id);
    ok(Number.isInteger(c) && c >= 0 && c < PROJECT_COLORS, id);
    strictEqual(projectColor(id), c, "stable");
  }
  strictEqual(projectTagClass("harbor"), `ptag pc${projectColor("harbor")}`);
  strictEqual(projectColor(null), projectColor(""));
  const used = new Set(Array.from({ length: 200 }, (_, i) => projectColor(`project-${i}`)));
  strictEqual(used.size, PROJECT_COLORS, "every tint is used across many projects");
});

test("with the room's theme the hub decided (D-056), projects with different themes never share a colour", () => {
  deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7].map((theme) => projectColor("same-id", theme)), [0, 1, 2, 3, 4, 5, 6, 7]);
  strictEqual(projectColor("harbor", 3), 3);
  strictEqual(projectColor("harbor", undefined), projectColor("harbor"), "no theme: from the id");
  strictEqual(projectColor("harbor", -1), projectColor("harbor"));
  strictEqual(projectTagClass("harbor", 5), "ptag pc5");
});

/** sRGB relative luminance and WCAG contrast. */
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return null; // grey enough to be no hue at all
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

test("every tint is readable in light and dark, and none is red (red is «Urgent»)", async () => {
  const css = await readFile(new URL("../src/web/public/style.css", import.meta.url), "utf8");
  const read = (block: string) => [...block.matchAll(/\.ptag\.pc(\d) \{ --pt-bg: (#[0-9a-f]{6}); --pt-ink: (#[0-9a-f]{6});/g)].map((m) => ({ i: Number(m[1]), bg: m[2]!, ink: m[3]! }));
  const at = css.indexOf("@media (prefers-color-scheme: dark) {\n  :root:where(:not([data-theme=\"light\"])) .ptag");
  const light = read(css.slice(0, at));
  const dark = read(css.slice(at));
  deepStrictEqual([light.length, dark.length], [PROJECT_COLORS, PROJECT_COLORS]);
  for (const { i, bg, ink } of [...light, ...dark]) {
    ok(contrast(bg, ink) >= 4.5, `pc${i}: ${bg} on ${ink} is ${contrast(bg, ink).toFixed(1)}:1`);
    const h = hue(ink);
    ok(h === null || (h > 20 && h < 330), `pc${i}: ${ink} is red (hue ${h})`);
  }
});

test("the label is on the tasks list, its project menu, the task's head and the Home's summary", async () => {
  const app = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  ok(app.includes('h("span", { class: "tp-item-tags" }, projectTag(x.project)'), "the list");
  ok(app.includes("h(\"button\", { class: projectClass(id), type: \"button\", \"aria-pressed\": String(id === project)"), "the project menu");
  ok(app.includes('h("div", { class: "otask-head" }, projectTag(x.project)'), "the task's head");
  ok(app.includes("project ? null : projectTag(x.project),"), "the Home's summary");
});
