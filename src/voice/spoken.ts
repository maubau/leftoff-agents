/**
 * The text a chat answer becomes when it is read aloud. Written answers carry
 * things that sound absurd spoken — status emoji, commit hashes, URLs, markup —
 * and can be long; a voice note should be the gist, with the details left in
 * the text that always accompanies it.
 */
import { messages, type Lang } from "../i18n/index.ts";

const EMOJI = /[\p{Extended_Pictographic}‍️]/gu;
const CODE_BLOCK = /```[\s\S]*?```/g;
const PULL_REQUEST = /\b(?:pull\s+request|PR)\s*#?\s*(\d+)\b/gi;
const FILE_PATH = /(?:^|\s)(?:\.{0,2}\/|\/)[\w.@+/-]+/g;
const URL = /\bhttps?:\/\/\S+/g;
const HEX = "(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}";
/** "commit b7ca285" → "commit"; a bare hash elsewhere → "un commit". */
const SHA_AFTER_WORD = new RegExp(`\\b(commit[:\\s]+)${HEX}\\b`, "gi");
const SHA = new RegExp(`\\b${HEX}\\b`, "g");

export function spokenText(text: string, options: { maxChars: number; language: Lang }): string {
  const m = messages(options.language).spoken;
  let out = text
    .replace(CODE_BLOCK, m.codeBlock)
    .replace(PULL_REQUEST, (_, number: string) => m.pullRequest(number))
    .replace(FILE_PATH, m.file)
    .replace(URL, m.link)
    .replace(SHA_AFTER_WORD, (_, word: string) => word.trim().replace(/:$/, ""))
    .replace(SHA, m.commit)
    .replace(EMOJI, "")
    // snake_case identifiers (needs_input) read as two words, not one blob.
    .replace(/(?<=[A-Za-z])_(?=[A-Za-z])/g, " ")
    // Inline technical literals are useful in writing but painful when spelled
    // out by TTS. Keep ordinary short words; collapse paths, hashes and tokens.
    .replace(/`([^`]+)`/g, (_, literal: string) =>
      /[\\/]|[_-].*[_-]|^[A-Fa-f0-9]{7,}$|.{32,}/.test(literal)
        ? m.technicalRef
        : literal,
    )
    .replace(/[*]+|^\s*[#>]+\s*/gm, "")
    .replace(/^\s*[•\-–]\s+/gm, "")
    // Each line of a list becomes its own sentence.
    .replace(/([^.!?:;\n])\s*\n+/g, "$1. ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\s*\./g, "$1")
    .trim();

  if (out.length <= options.maxChars) return out;
  // Cut at the last full sentence that fits, and say where the rest is.
  const room = options.maxChars - 40;
  const cut = Math.max(out.lastIndexOf(". ", room), out.lastIndexOf("? ", room), out.lastIndexOf("! ", room));
  out = out.slice(0, cut > room / 2 ? cut + 1 : room).trim();
  return `${out} ${m.rest}`;
}
