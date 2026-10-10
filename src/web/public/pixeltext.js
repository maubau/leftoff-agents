// Text in pixels: a 5×7 face with lower case, digits, punctuation and the accents the panel's six languages use,
// drawn with the one primitive office.js draws with, rect(x, y, w, h, colour). Names and descriptions on the Home's
// rooms are written with it, so that everything in a room is the same kind of picture. No font file, nothing to
// license. (office.js's 3×5 face, upper case only, is for the desk plates.)

/** The height of a line of text, descenders and accents included, and the gap kept under it. */
export const LINE_H = 10;
export const LEADING = 2;

// A glyph is its rows from `top` down (rows are numbered from the top of the line: capitals and ascenders start at
// 1, the body of a lower-case letter at 3, descenders reach row 9; row 0 is for accents over capitals).
const g = (top, ...rows) => ({ top, rows });

const GLYPHS = {
  " ": g(1, "..."), // a space is 3 wide
  A: g(1, ".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
  B: g(1, "####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."),
  C: g(1, ".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."),
  D: g(1, "####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."),
  E: g(1, "#####", "#....", "#....", "####.", "#....", "#....", "#####"),
  F: g(1, "#####", "#....", "#....", "####.", "#....", "#....", "#...."),
  G: g(1, ".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."),
  H: g(1, "#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
  I: g(1, "###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"),
  J: g(1, "..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."),
  K: g(1, "#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"),
  L: g(1, "#....", "#....", "#....", "#....", "#....", "#....", "#####"),
  M: g(1, "#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"),
  N: g(1, "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"),
  O: g(1, ".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
  P: g(1, "####.", "#...#", "#...#", "####.", "#....", "#....", "#...."),
  Q: g(1, ".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"),
  R: g(1, "####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"),
  S: g(1, ".####", "#....", "#....", ".###.", "....#", "....#", "####."),
  T: g(1, "#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."),
  U: g(1, "#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
  V: g(1, "#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."),
  W: g(1, "#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"),
  X: g(1, "#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"),
  Y: g(1, "#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."),
  Z: g(1, "#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"),
  0: g(1, ".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."),
  1: g(1, "..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."),
  2: g(1, ".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"),
  3: g(1, "####.", "....#", "....#", ".###.", "....#", "....#", "####."),
  4: g(1, "...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."),
  5: g(1, "#####", "#....", "####.", "....#", "....#", "#...#", ".###."),
  6: g(1, "..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."),
  7: g(1, "#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."),
  8: g(1, ".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."),
  9: g(1, ".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."),
  a: g(3, ".###.", "....#", ".####", "#...#", ".####"),
  b: g(1, "#....", "#....", "####.", "#...#", "#...#", "#...#", "####."),
  c: g(3, ".###.", "#...#", "#....", "#...#", ".###."),
  d: g(1, "....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"),
  e: g(3, ".###.", "#...#", "#####", "#....", ".###."),
  f: g(1, "..##", ".#..", "####", ".#..", ".#..", ".#..", ".#.."),
  g: g(3, ".####", "#...#", "#...#", "#...#", ".####", "....#", ".###."),
  h: g(1, "#....", "#....", "####.", "#...#", "#...#", "#...#", "#...#"),
  i: g(1, ".#.", "...", "##.", ".#.", ".#.", ".#.", "###"),
  ı: g(3, "##.", ".#.", ".#.", ".#.", "###"), // i without its dot, under an accent
  j: g(1, "...#", "....", "..##", "...#", "...#", "...#", "...#", "#..#", ".##."),
  k: g(1, "#....", "#....", "#..#.", "#.#..", "##...", "#.#..", "#..#."),
  l: g(1, "##.", ".#.", ".#.", ".#.", ".#.", ".#.", "###"),
  m: g(3, "##.#.", "#.#.#", "#.#.#", "#...#", "#...#"),
  n: g(3, "####.", "#...#", "#...#", "#...#", "#...#"),
  o: g(3, ".###.", "#...#", "#...#", "#...#", ".###."),
  p: g(3, "####.", "#...#", "#...#", "#...#", "####.", "#....", "#...."),
  q: g(3, ".####", "#...#", "#...#", "#...#", ".####", "....#", "....#"),
  r: g(3, "#.##", "##..", "#...", "#...", "#..."),
  s: g(3, ".####", "#....", ".###.", "....#", "####."),
  t: g(2, ".#..", "###.", ".#..", ".#..", ".#..", "..##"),
  u: g(3, "#...#", "#...#", "#...#", "#...#", ".####"),
  v: g(3, "#...#", "#...#", "#...#", ".#.#.", "..#.."),
  w: g(3, "#...#", "#...#", "#.#.#", "#.#.#", ".#.#."),
  x: g(3, "#...#", ".#.#.", "..#..", ".#.#.", "#...#"),
  y: g(3, "#...#", "#...#", "#...#", ".####", "....#", "....#", ".###."),
  z: g(3, "#####", "...#.", "..#..", ".#...", "#####"),
  ".": g(7, "#"),
  ",": g(7, ".#", "#."),
  ":": g(3, "#", ".", ".", ".", "#"),
  ";": g(3, ".#", "..", "..", ".#", "#."),
  "!": g(1, "#", "#", "#", "#", "#", ".", "#"),
  "?": g(1, ".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."),
  "'": g(1, "#", "#"),
  '"': g(1, "#.#", "#.#"),
  "(": g(1, "..#", ".#.", "#..", "#..", "#..", ".#.", "..#"),
  ")": g(1, "#..", ".#.", "..#", "..#", "..#", ".#.", "#.."),
  "/": g(1, "....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."),
  "-": g(4, "####"),
  _: g(8, "#####"),
  "+": g(2, "..#..", "..#..", "#####", "..#..", "..#.."),
  "&": g(1, ".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"),
  "#": g(1, ".#.#.", "#####", ".#.#.", ".#.#.", "#####", ".#.#."),
  "%": g(1, "##..#", "##.#.", "...#.", "..#..", ".#...", ".#.##", "#..##"),
  "@": g(1, ".###.", "#...#", "#.###", "#.#.#", "#.###", "#....", ".###."),
  "*": g(2, "#.#.#", ".###.", "#####", ".###.", "#.#.#"),
  "=": g(3, "#####", ".....", "#####"),
  "<": g(2, "...#", "..#.", ".#..", "..#.", "...#"),
  ">": g(2, "#...", ".#..", "..#.", ".#..", "#..."),
};

/** Marks over a letter (rows 1-2 over a small letter, row 0 over a capital), and the cedilla under one. */
const MARKS = {
  "̀": { low: ["#..", ".#."], cap: [".#"] }, // grave
  "́": { low: [".#.", "#.."], cap: ["#."] }, // acute
  "̂": { low: [".#.", "#.#"], cap: [".#."] }, // circumflex
  "̈": { low: ["...", "#.#"], cap: ["#.#"] }, // diaeresis
  "̃": { low: ["##.#", "#.#."], cap: ["#.#"] }, // tilde
  "̧": { below: [".#."] }, // cedilla
};

/** Other characters said another way. */
const SAME = { "’": "'", "‘": "'", "“": '"', "”": '"', "«": '"', "»": '"', "–": "-", "—": "-", "−": "-", "•": "-", "·": "-", "×": "x", " ": " ", ß: "ss", ø: "o", Ø: "O", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE" };

/** One character as what is drawn for it: its glyph, and any mark over or under it. */
function parts(ch) {
  const base = ch.normalize("NFD");
  const letter = SAME[base[0]] ?? base[0];
  const first = letter.length > 1 ? letter[0] : letter;
  const marks = [...base.slice(1)].map((m) => MARKS[m]).filter(Boolean);
  return { letter: GLYPHS[first] ? first : "?", extra: letter.length > 1 ? letter.slice(1) : "", marks };
}

/** How wide a character is, spacing included (a letter said as two, like ß, takes both). */
function advance(ch) {
  const { letter, extra, marks } = parts(ch);
  const glyph = marks.length && letter === "i" ? GLYPHS["ı"] : GLYPHS[letter];
  return glyph.rows[0].length + 1 + [...extra].reduce((n, c) => n + (GLYPHS[c] ? GLYPHS[c].rows[0].length + 1 : 0), 0);
}

/** How wide a text is, in pixels. */
export function textWidth(text, scale = 1) {
  let w = 0;
  for (const ch of String(text)) w += advance(ch);
  return Math.max(0, w - 1) * scale;
}

/** Draw `text` with its top-left at (x, y); returns its width. `shadow`, a colour, adds a one-pixel shadow under it. */
export function drawText(ctx, text, x, y, colour, { scale = 1, shadow } = {}) {
  const put = (ch, cx, tint, dy) => {
    const { letter, extra, marks } = parts(ch);
    const dotless = marks.length && letter === "i";
    const glyph = dotless ? GLYPHS["ı"] : GLYPHS[letter];
    const capital = glyph.top === 1 && letter !== "i" && letter !== "l" && !/[bdfhkt]/.test(letter);
    glyph.rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) if (row[c] === "#") ctx.rect(x + (cx + c) * scale, y + (glyph.top + r + dy) * scale, scale, scale, tint);
    });
    for (const mark of marks) {
      if (mark.below) mark.below.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] === "#") ctx.rect(x + (cx + 1 + c) * scale, y + (8 + r + dy) * scale, scale, scale, tint); });
      else {
        const rows = capital ? mark.cap : mark.low;
        const top = capital ? 0 : 1;
        rows.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] === "#") ctx.rect(x + (cx + 1 + c) * scale, y + (top + r + dy) * scale, scale, scale, tint); });
      }
    }
    // A letter said as two (ß as ss): the second follows the first.
    let next = cx + glyph.rows[0].length + 1;
    for (const c of extra) {
      if (!GLYPHS[c]) continue;
      GLYPHS[c].rows.forEach((row, r) => { for (let k = 0; k < row.length; k++) if (row[k] === "#") ctx.rect(x + (next + k) * scale, y + (GLYPHS[c].top + r + dy) * scale, scale, scale, tint); });
      next += GLYPHS[c].rows[0].length + 1;
    }
  };
  let cx = 0;
  for (const ch of String(text)) {
    const w = advance(ch);
    if (shadow) put(ch, cx, shadow, 1);
    put(ch, cx, colour, 0);
    cx += w;
  }
  return textWidth(text, scale);
}

/** `text` cut to fit `maxWidth` pixels, ending in "..." when something was left out. */
export function fit(text, maxWidth) {
  const chars = [...String(text).replace(/\s+/g, " ").trim()];
  if (textWidth(chars.join("")) <= maxWidth) return chars.join("");
  while (chars.length && textWidth(`${chars.join("").trimEnd()}...`) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}...`;
}

/** `text` broken into at most `maxLines` lines of at most `maxWidth` pixels, at spaces; the last ends in "..." if cut. */
export function wrap(text, maxWidth, maxLines) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    // A word too long for a line on its own is cut where it no longer fits.
    const word = textWidth(words[i]) <= maxWidth ? words[i] : fit(words[i], maxWidth);
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next) <= maxWidth) {
      line = next;
      i++;
    } else {
      lines.push(line);
      line = "";
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (i < words.length && lines.length) lines[lines.length - 1] = fit(`${lines[lines.length - 1]}...`, maxWidth);
  return lines;
}
