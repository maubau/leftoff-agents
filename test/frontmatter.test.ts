import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter, stringifyFrontmatter } from "../src/core/frontmatter.ts";

test("round-trips data and body", () => {
  const text = stringifyFrontmatter({ agent: "claude", done: ["a", "b"] }, "Some notes.");
  const parsed = parseFrontmatter<{ agent: string; done: string[] }>(text);
  deepStrictEqual(parsed.data, { agent: "claude", done: ["a", "b"] });
  strictEqual(parsed.body.trim(), "Some notes.");
});

test("treats a file without frontmatter as all body", () => {
  const parsed = parseFrontmatter("just text\n");
  deepStrictEqual(parsed.data, {});
  strictEqual(parsed.body, "just text\n");
});

test("does not mistake a horizontal rule mid-file for frontmatter", () => {
  const parsed = parseFrontmatter("# Title\n\n---\n\nmore\n");
  deepStrictEqual(parsed.data, {});
});
