import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface Document<T> {
  data: T;
  body: string;
}

/**
 * Split a Markdown file into its YAML frontmatter and its body.
 * A file without frontmatter yields an empty object and the whole text as body.
 */
export function parseFrontmatter<T = Record<string, unknown>>(text: string): Document<T> {
  const match = FENCE.exec(text);
  if (!match) return { data: {} as T, body: text };
  const data = (parseYaml(match[1] ?? "") ?? {}) as T;
  return { data, body: text.slice(match[0].length) };
}

export function stringifyFrontmatter(data: unknown, body = ""): string {
  const yaml = stringifyYaml(data, { lineWidth: 0 }).trimEnd();
  const trimmed = body.trim();
  return trimmed ? `---\n${yaml}\n---\n\n${trimmed}\n` : `---\n${yaml}\n---\n`;
}
