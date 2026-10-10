// The drawing of an office at twice the detail of the office's own coordinates: people with a big round head and an
// outline, desks with a keyboard and a monitor on a stand, bevelled floor tiles, a panelled wall, all drawn from code
// with the one primitive rect(x, y, w, h, colour) — no image, nothing to license. Everything here takes pixels of the
// picture, which is RES of them to each unit of office.js's layout.

/** Pixels of the picture to each unit of the layout. */
export const RES = 2;

const INK = "#2a1a12"; // the outline of a person

/** A colour lightened (amount > 0) or darkened (amount < 0): mixed with white or black. */
export function shade(hex, amount) {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))));
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** A filled ellipse, centre (cx, cy) and radii, as rows of rect(). */
export function ellipse(ctx, cx, cy, rx, ry, colour) {
  for (let y = -ry; y < ry; y++) {
    const k = (y + 0.5) / ry;
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - k * k)));
    if (half > 0) ctx.rect(cx - half, cy + y, half * 2, 1, colour);
  }
}

/** A rectangle with a one-pixel outline and a lighter top and left edge: the look of the furniture. */
function slab(ctx, x, y, w, h, colour, edge) {
  ctx.rect(x, y, w, h, edge);
  ctx.rect(x + 1, y + 1, w - 2, h - 2, colour);
  ctx.rect(x + 1, y + 1, w - 2, 1, shade(colour, 0.22));
  ctx.rect(x + 1, y + 1, 1, h - 2, shade(colour, 0.12));
}

// ---------- floor and wall ----------

/** The floor, from y = top down to `height`, in the pattern of the room's theme; `A` and `B` are its two tones. */
export function floorPixels(ctx, width, height, top, A, B, pattern) {
  if (pattern === "planks") {
    for (let y = top, row = 0; y < height; y += 8, row++) {
      const base = row % 2 ? A : B;
      ctx.rect(0, y, width, 8, base);
      ctx.rect(0, y, width, 1, shade(base, 0.14));
      ctx.rect(0, y + 7, width, 1, shade(base, -0.22));
      for (let x = (row * 26) % 48; x < width; x += 48) ctx.rect(x, y, 1, 8, shade(base, -0.3));
      for (let x = (row * 11) % 30 + 5; x < width; x += 30) ctx.rect(x, y + 3, 7, 1, shade(base, -0.1));
    }
  } else if (pattern === "stripes") {
    for (let x = 0; x < width; x += 12) {
      const base = (x / 12) % 2 ? A : B;
      ctx.rect(x, top, Math.min(12, width - x), height - top, base);
      ctx.rect(x, top, 1, height - top, shade(base, 0.12));
    }
    for (let y = top + 2; y < height; y += 4) for (let x = 2 + ((y / 4) % 2) * 3; x < width; x += 6) ctx.rect(x, y, 1, 1, shade(B, -0.18));
  } else if (pattern === "tiles") {
    ctx.rect(0, top, width, height - top, A);
    for (let y = top; y < height; y += 32) {
      ctx.rect(0, y, width, 2, B);
      ctx.rect(0, y + 2, width, 1, shade(A, 0.2));
    }
    for (let x = 0; x < width; x += 32) ctx.rect(x, top, 2, height - top, B);
  } else if (pattern === "grass") {
    ctx.rect(0, top, width, height - top, A);
    for (let y = top + 2; y < height; y += 6) {
      for (let x = ((y / 6) % 2) * 5; x < width; x += 10) {
        const k = (x * 7 + y * 13) % 5;
        ctx.rect(Math.min(x + k, width - 4), y, 1, 3, B);
        ctx.rect(Math.min(x + k + 2, width - 4), y + 1, 1, 2, shade(A, 0.18));
      }
    }
  } else {
    // Tiles of 16 pixels in two tones, each with a light top and left edge and a dark bottom and right one.
    for (let y = top, row = 0; y < height; y += 16, row++) {
      for (let x = 0, col = 0; x < width; x += 16, col++) {
        const base = (row + col) % 2 ? A : B;
        const w = Math.min(16, width - x);
        const h = Math.min(16, height - y);
        ctx.rect(x, y, w, h, base);
        ctx.rect(x, y, w, 1, shade(base, 0.22));
        ctx.rect(x, y, 1, h, shade(base, 0.12));
        ctx.rect(x, y + h - 1, w, 1, shade(base, -0.2));
        ctx.rect(x + w - 1, y, 1, h, shade(base, -0.12));
      }
    }
  }
}

/** The back wall, `wallH` tall: panels, a baseboard, a trim along the top. */
export function wallPixels(ctx, width, wallH, wall, line, skirting) {
  ctx.rect(0, 0, width, wallH, wall);
  for (let x = 0; x < width; x += 32) {
    ctx.rect(x, 0, 1, wallH - 8, shade(wall, -0.12));
    ctx.rect(x + 1, 0, 1, wallH - 8, shade(wall, 0.1));
  }
  ctx.rect(0, 0, width, 2, shade(wall, 0.2));
  ctx.rect(0, 2, width, 1, line);
  ctx.rect(0, wallH - 9, width, 9, skirting);
  ctx.rect(0, wallH - 9, width, 1, shade(skirting, 0.3));
  ctx.rect(0, wallH - 2, width, 2, shade(skirting, -0.3));
}

/** A window, `w` × `h`, with a frame, two panes, a sill and a streak of light on the glass. */
export function windowPixels(ctx, x, y, w, h, frame, sky) {
  ctx.rect(x, y, w, h, shade(frame, -0.35));
  ctx.rect(x + 1, y + 1, w - 2, h - 2, frame);
  const gw = (w - 8) / 2;
  for (const gx of [x + 3, x + 5 + gw]) {
    ctx.rect(gx, y + 3, gw, h - 8, sky);
    ctx.rect(gx, y + 3, gw, Math.floor((h - 8) / 2), shade(sky, 0.15));
    ctx.rect(gx + 2, y + 5, 2, 8, shade(sky, 0.4));
    ctx.rect(gx + 5, y + 5, 1, 4, shade(sky, 0.4));
  }
  ctx.rect(x - 2, y + h - 3, w + 4, 3, shade(frame, -0.2));
  ctx.rect(x - 2, y + h - 3, w + 4, 1, shade(frame, 0.2));
}

// ---------- furniture ----------

export function plantPixels(ctx, x, y) {
  ctx.rect(x + 3, y + 14, 12, 3, "#c97a4a");
  ctx.rect(x + 4, y + 17, 10, 9, "#b5643a");
  ctx.rect(x + 4, y + 17, 10, 1, "#d4895a");
  ctx.rect(x + 5, y + 25, 8, 1, "#8c4a28");
  ctx.rect(x + 8, y + 6, 2, 9, "#2f6e3c");
  ellipse(ctx, x + 5, y + 9, 5, 4, "#2f6e3c");
  ellipse(ctx, x + 13, y + 8, 5, 4, "#3f8f4f");
  ellipse(ctx, x + 9, y + 4, 5, 4, "#4fa85f");
  ctx.rect(x + 7, y + 2, 2, 1, "#79c585");
  ctx.rect(x + 3, y + 7, 2, 1, "#5fb56f");
}

/** A sheet of paper with a few lines on it. */
export function paperPixels(ctx, x, y) {
  ctx.rect(x, y, 10, 12, "#8d99ad");
  ctx.rect(x + 1, y + 1, 8, 10, "#fbfbf7");
  for (const line of [3, 5, 7, 9]) ctx.rect(x + 2, y + line, line === 9 ? 3 : 6, 1, "#9aa3b2");
}

/** A speech bubble with a 5×5 glyph in it: rounded, with a tail towards the speaker. */
export function bubblePixels(ctx, x, y, glyph) {
  ctx.rect(x + 2, y, 14, 16, "#2b313c");
  ctx.rect(x, y + 2, 18, 12, "#2b313c");
  ctx.rect(x + 3, y + 1, 12, 14, "#ffffff");
  ctx.rect(x + 1, y + 3, 16, 10, "#ffffff");
  ctx.rect(x + 3, y + 16, 3, 2, "#2b313c");
  ctx.rect(x + 4, y + 16, 1, 1, "#ffffff");
  glyph.rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) if (row[dx] === "x") ctx.rect(x + 4 + dx * 2, y + 3 + dy * 2, 2, 2, glyph.colour);
  });
}

// ---------- people ----------

const POSES = { skin: ["#f3d2b3", "#e2b48f", "#c68e62", "#8d5a3b", "#f6dcc8"] };

/** What a person looks like, from their id: the same agent is the same person everywhere. */
export function lookOf(h, shirt) {
  return { skin: POSES.skin[(h >>> 8) % POSES.skin.length], hairIndex: h % 7, style: (h >>> 3) % 5, glasses: (h >>> 12) % 3 === 0, shirt };
}

const HAIR_COLOURS = ["#2b1d14", "#5a3a22", "#a8763e", "#d9b26a", "#1f1f24", "#8c3b2e", "#b9b9c4"];

/** The head, 24 × 22, top left at (x, y); `side` turns it towards the right (the PM looking at its screen). */
export function headPixels(ctx, x, y, look, side = false) {
  const hair = HAIR_COLOURS[look.hairIndex];
  const hairEdge = shade(hair, -0.45);
  const skin = look.skin;
  ellipse(ctx, x + 12, y + 11, 12, 11, INK);
  ellipse(ctx, x + 12, y + 11, 11, 10, skin);
  ctx.rect(x + 4, y + 17, 16, 3, shade(skin, 0.06));
  // Ears.
  if (!side) {
    for (const ex of [x - 1, x + 22]) {
      ctx.rect(ex, y + 10, 3, 7, INK);
      ctx.rect(ex + (ex < x ? 1 : 0), y + 11, 2, 5, skin);
    }
  } else {
    ctx.rect(x + 3, y + 10, 4, 7, INK);
    ctx.rect(x + 4, y + 11, 2, 5, skin);
  }

  // Hair, over the top of the head.
  const crown = (depth) => {
    for (let dy = 0; dy < depth; dy++) {
      const k = (dy + 0.5 - 11) / 11;
      const half = Math.round(12 * Math.sqrt(Math.max(0, 1 - k * k)));
      ctx.rect(x + 12 - half, y + dy, half * 2, 1, hairEdge);
      if (half > 2) ctx.rect(x + 12 - half + 1, y + dy + (dy === 0 ? 1 : 0), half * 2 - 2, 1, hair);
    }
    ctx.rect(x + 5, y + 2, 7, 1, shade(hair, 0.3));
  };
  if (look.style === 4) {
    // A cap: the crown in a colour of its own, with a brim.
    const cloth = look.shirt;
    for (let dy = 0; dy < 9; dy++) {
      const k = (dy + 0.5 - 11) / 11;
      const half = Math.round(12 * Math.sqrt(Math.max(0, 1 - k * k)));
      ctx.rect(x + 12 - half, y + dy, half * 2, 1, shade(cloth, -0.4));
      if (half > 2) ctx.rect(x + 12 - half + 1, y + dy + (dy === 0 ? 1 : 0), half * 2 - 2, 1, cloth);
    }
    ctx.rect(x, y + 8, 24, 3, shade(cloth, -0.4));
    ctx.rect(x + 1, y + 8, 22, 1, shade(cloth, 0.2));
    ctx.rect(x + 2, y + 9, 20, 1, shade(cloth, -0.15));
  } else {
    crown(look.style === 1 ? 10 : 9);
    if (look.style === 1) ctx.rect(x + 13, y + 2, 6, 3, shade(hair, 0.4)); // a parting
    // A fringe that stops short of the eyes, and sideburns.
    ctx.rect(x + 1, y + 8, 4, 4, hair);
    if (!side) ctx.rect(x + 19, y + 8, 4, 4, hair);
    if (look.style === 2) {
      // Long: it falls past the ears on both sides.
      ctx.rect(x - 2, y + 7, 5, 15, hairEdge);
      ctx.rect(x - 1, y + 7, 4, 15, hair);
      if (!side) {
        ctx.rect(x + 21, y + 7, 5, 15, hairEdge);
        ctx.rect(x + 21, y + 7, 4, 15, hair);
      }
    }
    if (look.style === 3) {
      // A bun on top.
      ellipse(ctx, x + 12, y - 1, 5, 4, hairEdge);
      ellipse(ctx, x + 12, y - 1, 4, 3, hair);
    }
  }
  // The face: big eyes with a dark pupil, brows, a nose, a mouth.
  const eyes = side ? [x + 12] : [x + 5, x + 14];
  for (const ex of eyes) {
    ctx.rect(ex, y + 11, 5, 6, "#ffffff");
    ctx.rect(ex, y + 11, 5, 1, "#dfe5ec");
    ctx.rect(ex + (side ? 2 : ex < x + 12 ? 2 : 1), y + 12, 2, 5, "#1b1b1f");
    ctx.rect(ex + (side ? 2 : ex < x + 12 ? 2 : 1), y + 12, 1, 1, "#ffffff");
    ctx.rect(ex - 1, y + 10, 6, 1, hairEdge);
  }
  ctx.rect(x + (side ? 20 : 11), y + 15, 2, 3, shade(skin, -0.18));
  ctx.rect(x + (side ? 13 : 9), y + 19, 6, 1, "#a0524a");
  ctx.rect(x + (side ? 14 : 10), y + 20, 4, 1, "#c4685c");
  if (!side) {
    ctx.rect(x + 3, y + 16, 3, 2, "#f0a0a0");
    ctx.rect(x + 18, y + 16, 3, 2, "#f0a0a0");
  }
  if (look.glasses) {
    const frame = "#1b1b1f";
    for (const gx of side ? [x + 11] : [x + 4, x + 13]) {
      ctx.rect(gx, y + 10, 8, 1, frame);
      ctx.rect(gx, y + 17, 8, 1, frame);
      ctx.rect(gx, y + 10, 1, 8, frame);
      ctx.rect(gx + 7, y + 10, 1, 8, frame);
    }
    if (!side) ctx.rect(x + 11, y + 13, 2, 1, frame);
  }
}

/** The shoulders and chest of a seated person, 30 wide, top left at (x, y): a shirt with a collar, and a tie if given. */
export function shouldersPixels(ctx, x, y, look, tie) {
  const cloth = look.shirt;
  ctx.rect(x, y, 30, 16, INK);
  ctx.rect(x + 1, y + 1, 28, 15, cloth);
  ctx.rect(x + 1, y + 1, 28, 1, shade(cloth, 0.25));
  ctx.rect(x + 1, y + 1, 1, 15, shade(cloth, 0.12));
  ctx.rect(x + 28, y + 1, 1, 15, shade(cloth, -0.2));
  // The neck, a V of collar, the tie.
  ctx.rect(x + 11, y - 2, 8, 4, look.skin);
  ctx.rect(x + 11, y, 8, 2, shade(look.skin, -0.14));
  ctx.rect(x + 9, y, 4, 4, "#f2f2f2");
  ctx.rect(x + 17, y, 4, 4, "#f2f2f2");
  if (tie) {
    ctx.rect(x + 14, y + 2, 3, 10, tie);
    ctx.rect(x + 14, y + 2, 3, 3, shade(tie, 0.25));
  }
}

/** A drawing clipped above `maxY`: what is behind a desk's top is not drawn. */
export function above(ctx, maxY) {
  return {
    rect(x, y, w, h, colour) {
      if (y >= maxY) return;
      ctx.rect(x, y, w, Math.min(h, maxY - y), colour);
    },
  };
}

/** The arms of a seated person, from the shoulders to the hands on the keyboard; `beat` moves the hands. */
export function armsPixels(ctx, x, y, look, beat) {
  const sleeve = shade(look.shirt, -0.12);
  for (const ax of [x + 30, x + 63]) {
    ctx.rect(ax, y + 38, 6, 11, INK);
    ctx.rect(ax + 1, y + 38, 4, 10, sleeve);
  }
  // Hands, on the keys.
  for (const hx of [x + 38 + beat, x + 54 - beat]) {
    ctx.rect(hx, y + 45, 7, 5, INK);
    ctx.rect(hx + 1, y + 45, 5, 4, look.skin);
  }
}

/** A person at a desk, from the head to the shoulders; the arms and hands come separately (armsPixels). */
export function seatedPixels(ctx, x, y, look, { tie, side = false } = {}) {
  shouldersPixels(above(ctx, y + 40), x + 33, y + 34, look, tie);
  headPixels(ctx, x + 36, y + 12, look, side);
}

/** A person on their feet, 24 wide, anchored at the middle of their feet (fx, fy): big head, shirt, arms, legs. `step` is the walk. */
export function standingPixels(ctx, fx, fy, look, step, tie) {
  const top = fy - 44;
  const stride = step ? 3 : 0;
  const pants = "#2f3542";
  // Legs and shoes; the far foot is a little higher when striding.
  for (const [lx, lift] of [[fx - 9 - stride, 0], [fx + 1 + stride, stride ? 1 : 0]]) {
    ctx.rect(lx, top + 34, 9, 10 - lift, INK);
    ctx.rect(lx + 1, top + 34, 7, 8 - lift, pants);
    ctx.rect(lx - 1, top + 41 - lift, 11, 4, "#14161b");
    ctx.rect(lx, top + 41 - lift, 9, 1, "#3a3f4d");
  }
  // Arms, swinging against the legs.
  const sleeve = shade(look.shirt, -0.12);
  const swing = step ? 2 : 0;
  for (const [ax, dy] of [[fx - 16, swing], [fx + 11, -swing]]) {
    ctx.rect(ax, top + 23 + dy, 6, 13, INK);
    ctx.rect(ax + 1, top + 23 + dy, 4, 9, sleeve);
    ctx.rect(ax + 1, top + 32 + dy, 4, 4, look.skin);
  }
  // The shirt, with its collar and tie.
  ctx.rect(fx - 12, top + 21, 24, 16, INK);
  ctx.rect(fx - 11, top + 22, 22, 14, look.shirt);
  ctx.rect(fx - 11, top + 22, 22, 1, shade(look.shirt, 0.25));
  ctx.rect(fx - 11, top + 22, 1, 14, shade(look.shirt, 0.12));
  ctx.rect(fx - 11, top + 33, 22, 3, shade(pants, 0.05));
  ctx.rect(fx - 11, top + 33, 22, 1, shade(look.shirt, -0.3));
  ctx.rect(fx - 4, top + 19, 8, 4, look.skin);
  ctx.rect(fx - 5, top + 21, 4, 4, "#f2f2f2");
  ctx.rect(fx + 1, top + 21, 4, 4, "#f2f2f2");
  if (tie) ctx.rect(fx - 1, top + 23, 3, 9, tie);
  headPixels(ctx, fx - 12, top, look);
}

// ---------- a desk ----------

/**
 * One workstation's furniture, its top left at (x, y): the chair, the desk with its plate, the keyboard and a
 * monitor on a stand, lit and scrolling (`code` lines) while the agent works. `tray` sheets for the PM's tray.
 */
export function deskPixels(ctx, x, y, { manager, working, plateWidth, code, tray, plate }) {
  // The chair back, behind where the person sits.
  const chair = "#2a3240";
  ctx.rect(x + 31, y + 26, 34, 22, shade(chair, -0.35));
  ctx.rect(x + 33, y + 25, 30, 1, shade(chair, -0.35));
  ctx.rect(x + 32, y + 26, 32, 21, chair);
  ctx.rect(x + 35, y + 27, 26, 2, shade(chair, 0.3));
  // The desk: a top you see from above, a front with a drawer, two legs.
  const wood = manager ? "#7a5236" : "#c08a52";
  const front = manager ? "#5b3a24" : "#8f5f33";
  ctx.rect(x + 16, y + 40, 80, 13, shade(wood, -0.45));
  ctx.rect(x + 17, y + 41, 78, 11, wood);
  ctx.rect(x + 17, y + 41, 78, 2, shade(wood, 0.22));
  for (const gx of [24, 52, 76]) ctx.rect(x + gx, y + 47, 10, 1, shade(wood, -0.1));
  ctx.rect(x + 16, y + 53, 80, 13, shade(front, -0.45));
  ctx.rect(x + 17, y + 53, 78, 12, front);
  ctx.rect(x + 22, y + 55, 68, 9, shade(front, -0.18));
  ctx.rect(x + 23, y + 56, 66, 7, front);
  ctx.rect(x + 51, y + 58, 10, 2, shade(front, 0.35));
  ctx.rect(x + 18, y + 66, 5, 8, shade(front, -0.3));
  ctx.rect(x + 89, y + 66, 5, 8, shade(front, -0.3));
  // The keyboard.
  ctx.rect(x + 39, y + 44, 26, 7, "#7d8796");
  ctx.rect(x + 40, y + 45, 24, 5, "#dfe5ec");
  for (let k = 0; k < 6; k++) for (const ky of [45, 47]) ctx.rect(x + 41 + k * 4, y + ky, 3, 1, "#9aa3b2");
  // A mug and a notepad, to make it a desk someone works at.
  if (!manager) {
    ctx.rect(x + 22, y + 43, 7, 7, "#8d99ad");
    ctx.rect(x + 23, y + 44, 5, 5, "#f2eee8");
    ctx.rect(x + 29, y + 45, 2, 3, "#8d99ad");
  }
  // The monitor: bezel, screen, neck and foot.
  ctx.rect(x + 67, y + 13, 32, 24, "#14171d");
  ctx.rect(x + 68, y + 14, 30, 22, "#2b313c");
  ctx.rect(x + 70, y + 16, 26, 17, working ? "#10281d" : "#1b2230");
  ctx.rect(x + 70, y + 16, 26, 1, working ? "#1e4a36" : "#2b3548");
  if (working) code.forEach((c, i) => ctx.rect(x + 72 + c.dx, y + 18 + i * 4, c.w, 2, c.colour));
  else ctx.rect(x + 72, y + 18, 8, 2, "#2b3548");
  ctx.rect(x + 94, y + 34, 2, 1, working ? "#4cd964" : "#4a5468");
  ctx.rect(x + 79, y + 37, 6, 5, "#2b313c");
  ctx.rect(x + 74, y + 41, 16, 3, "#14171d");
  ctx.rect(x + 75, y + 41, 14, 1, "#3a4150");
  // Its name on a plate on the front.
  ctx.rect(x + 56 - Math.floor(plateWidth / 2), y + 54, plateWidth, 10, "#8f7b4c");
  ctx.rect(x + 57 - Math.floor(plateWidth / 2), y + 55, plateWidth - 2, 8, plate);
  // The PM's tray: a sheet for each handoff waiting for the owner.
  for (let k = 0; k < Math.min(3, tray ?? 0); k++) paperPixels(ctx, x + 20 + k * 2, y + 30 - k * 3);
}

// ---------- the furniture of a theme ----------

const DARK = "#14171d";

/** The pieces of furniture a theme puts against the side of the room, each drawn with its top left at (x, y). */
export const ITEMS = {
  bookshelf(ctx, x, y) {
    slab(ctx, x, y, 28, 54, "#6b4524", "#2a1a10");
    for (let shelf = 0; shelf < 3; shelf++) {
      const top = y + 3 + shelf * 17;
      ctx.rect(x + 3, top, 22, 14, "#2f1d10");
      for (let b = 0, bx = x + 4; bx < x + 23; b++) {
        const w = 3 + (b % 2);
        const tall = b % 3 === 1 ? 10 : 12;
        const c = ["#c0392b", "#2e7d32", "#1565c0", "#f9a825", "#6a1b9a", "#e65100"][(b * 5 + shelf * 2) % 6];
        ctx.rect(bx, top + 14 - tall, w, tall, shade(c, -0.4));
        ctx.rect(bx + 1, top + 15 - tall, w - 1, tall - 1, c);
        bx += w + (b % 4 === 3 ? 1 : 0);
      }
      ctx.rect(x + 2, top + 14, 24, 2, "#8a5a2e");
    }
  },
  lamp(ctx, x, y) {
    ctx.rect(x + 8, y + 50, 12, 4, DARK);
    ctx.rect(x + 9, y + 50, 10, 1, "#3a4150");
    ctx.rect(x + 13, y + 16, 3, 34, "#4a4f5c");
    ctx.rect(x + 13, y + 16, 1, 34, "#6a7080");
    ctx.rect(x + 4, y + 4, 21, 14, "#7a5a18");
    ctx.rect(x + 5, y + 5, 19, 12, "#f0d078");
    ctx.rect(x + 5, y + 5, 19, 2, "#f9eab0");
    ctx.rect(x + 7, y + 18, 15, 2, "#f6e3a1");
    ctx.rect(x + 9, y + 20, 11, 2, "#fbf1c8");
  },
  sofa(ctx, x, y) {
    slab(ctx, x + 2, y + 10, 30, 14, "#2d4f7c", "#0f1b2e");
    slab(ctx, x, y + 22, 34, 14, "#3b66a0", "#0f1b2e");
    slab(ctx, x - 3, y + 18, 8, 22, "#264469", "#0f1b2e");
    slab(ctx, x + 29, y + 18, 8, 22, "#264469", "#0f1b2e");
    ctx.rect(x + 17, y + 24, 1, 10, "#2b4a76");
    ctx.rect(x + 2, y + 40, 4, 4, DARK);
    ctx.rect(x + 28, y + 40, 4, 4, DARK);
  },
  rack(ctx, x, y) {
    slab(ctx, x, y, 24, 54, "#2c3344", DARK);
    for (let u = 0; u < 5; u++) {
      ctx.rect(x + 3, y + 4 + u * 10, 18, 8, "#1f2430");
      ctx.rect(x + 3, y + 4 + u * 10, 18, 1, "#3d465c");
      ctx.rect(x + 5, y + 6 + u * 10, 3, 3, (u * 7) % 3 ? "#4cd964" : "#ff5a4f");
      ctx.rect(x + 10, y + 7 + u * 10, 9, 1, "#4a5468");
      ctx.rect(x + 10, y + 9 + u * 10, 6, 1, "#3d465c");
    }
  },
  globe(ctx, x, y) {
    ctx.rect(x + 9, y + 22, 5, 10, "#6b4a2a");
    slab(ctx, x + 2, y + 31, 19, 4, "#5a3a1e", "#2a1a10");
    ellipse(ctx, x + 12, y + 12, 11, 11, "#14305a");
    ellipse(ctx, x + 12, y + 12, 10, 10, "#3b78c4");
    ctx.rect(x + 6, y + 5, 7, 5, "#4caf50");
    ctx.rect(x + 12, y + 11, 6, 7, "#4caf50");
    ctx.rect(x + 5, y + 4, 4, 1, "#8fd0ff");
  },
  bigplant(ctx, x, y) {
    ctx.rect(x + 6, y + 32, 16, 4, "#c97a4a");
    ctx.rect(x + 7, y + 36, 14, 12, "#b5643a");
    ctx.rect(x + 7, y + 36, 14, 1, "#d4895a");
    ctx.rect(x + 12, y + 8, 3, 24, "#2f6e3c");
    ellipse(ctx, x + 7, y + 14, 7, 5, "#2f6e3c");
    ellipse(ctx, x + 20, y + 12, 7, 5, "#3f8f4f");
    ellipse(ctx, x + 14, y + 6, 8, 6, "#4fa85f");
    ellipse(ctx, x + 8, y + 24, 6, 4, "#3f8f4f");
    ellipse(ctx, x + 20, y + 24, 6, 4, "#2f6e3c");
    ctx.rect(x + 11, y + 2, 4, 1, "#79c585");
  },
  aquarium(ctx, x, y) {
    slab(ctx, x, y + 28, 30, 22, "#74502e", "#2a1a10");
    ctx.rect(x - 1, y, 32, 28, "#8d99ad");
    ctx.rect(x, y + 1, 30, 26, "#c9d3e0");
    ctx.rect(x + 2, y + 3, 26, 22, "#3f8fc4");
    ctx.rect(x + 2, y + 3, 26, 5, "#5fb0e0");
    ctx.rect(x + 5, y + 11, 6, 4, "#f28b30");
    ctx.rect(x + 11, y + 12, 2, 2, "#f28b30");
    ctx.rect(x + 17, y + 16, 6, 3, "#f2d230");
    ctx.rect(x + 5, y + 18, 2, 7, "#3f8f4f");
    ctx.rect(x + 22, y + 15, 2, 10, "#3f8f4f");
    ctx.rect(x + 2, y + 23, 26, 2, "#d9c08a");
  },
  easel(ctx, x, y) {
    for (const lx of [x + 3, x + 22]) ctx.rect(lx, y + 22, 2, 30, "#74502e");
    ctx.rect(x + 12, y + 28, 2, 24, "#74502e");
    slab(ctx, x, y, 28, 24, "#74502e", "#2a1a10");
    ctx.rect(x + 3, y + 3, 22, 18, "#fbfbf7");
    ctx.rect(x + 5, y + 5, 9, 6, "#e05a4f");
    ctx.rect(x + 14, y + 9, 9, 7, "#4a90e2");
    ctx.rect(x + 7, y + 12, 6, 6, "#f2d230");
  },
  speaker(ctx, x, y) {
    slab(ctx, x, y, 22, 38, "#2b2f3a", DARK);
    ellipse(ctx, x + 11, y + 10, 5, 5, "#14171d");
    ellipse(ctx, x + 11, y + 10, 3, 3, "#4a5468");
    ellipse(ctx, x + 11, y + 26, 7, 7, "#14171d");
    ellipse(ctx, x + 11, y + 26, 5, 5, "#4a5468");
    ctx.rect(x + 10, y + 25, 2, 2, "#14171d");
  },
  coffee(ctx, x, y) {
    slab(ctx, x, y + 26, 30, 24, "#8f6a40", "#2a1a10");
    ctx.rect(x + 2, y + 28, 26, 2, "#a9825a");
    slab(ctx, x + 3, y + 2, 16, 24, "#8d99ad", "#3a4150");
    ctx.rect(x + 6, y + 6, 10, 7, "#2b313c");
    ctx.rect(x + 8, y + 17, 6, 8, "#14171d");
    ctx.rect(x + 15, y + 15, 2, 2, "#e05a4f");
    ctx.rect(x + 22, y + 20, 6, 6, "#f2eee8");
    ctx.rect(x + 28, y + 22, 2, 3, "#f2eee8");
  },
  fridge(ctx, x, y) {
    slab(ctx, x, y, 24, 54, "#dfe5ec", "#5a6372");
    ctx.rect(x + 1, y + 19, 22, 2, "#8d99ad");
    ctx.rect(x + 17, y + 6, 2, 9, "#8d99ad");
    ctx.rect(x + 17, y + 25, 2, 14, "#8d99ad");
    ctx.rect(x + 4, y + 8, 6, 5, "#e05a4f");
    ctx.rect(x + 3, y + 51, 18, 2, "#aab3be");
  },
  toolbench(ctx, x, y) {
    slab(ctx, x, y, 30, 26, "#a07a4a", "#2a1a10");
    ctx.rect(x + 3, y + 4, 2, 14, "#c9d3e0");
    ctx.rect(x + 9, y + 5, 7, 4, "#e05a4f");
    ctx.rect(x + 19, y + 6, 4, 11, "#8d99ad");
    ctx.rect(x + 25, y + 5, 3, 3, "#f2c04d");
    slab(ctx, x, y + 26, 30, 7, "#5a3a1e", "#2a1a10");
    ctx.rect(x + 3, y + 33, 4, 17, "#5a3a1e");
    ctx.rect(x + 23, y + 33, 4, 17, "#5a3a1e");
  },
  shelfBoxes(ctx, x, y) {
    slab(ctx, x, y, 28, 54, "#6b4a2a", "#2a1a10");
    for (let shelf = 0; shelf < 3; shelf++) {
      const top = y + 3 + shelf * 17;
      ctx.rect(x + 3, top, 22, 14, "#3a2514");
      slab(ctx, x + 4, top + 4, 9, 10, "#d9b26a", "#6b4a2a");
      slab(ctx, x + 14, top + 6, 9, 8, "#c98a3a", "#6b4a2a");
      ctx.rect(x + 2, top + 14, 24, 2, "#8a5a2e");
    }
  },
  telescope(ctx, x, y) {
    ctx.rect(x + 12, y + 30, 3, 24, "#4a4f5c");
    ctx.rect(x + 4, y + 52, 10, 2, "#4a4f5c");
    ctx.rect(x + 14, y + 52, 10, 2, "#4a4f5c");
    slab(ctx, x + 6, y + 26, 16, 5, "#8d99ad", "#3a4150");
    slab(ctx, x + 3, y + 18, 8, 8, "#c9d3e0", "#3a4150");
    slab(ctx, x + 8, y + 11, 8, 8, "#aab3be", "#3a4150");
    slab(ctx, x + 13, y + 4, 8, 8, "#c9d3e0", "#3a4150");
    slab(ctx, x + 18, y - 2, 8, 8, "#aab3be", "#3a4150");
  },
};

// ---------- more furniture, to fill a room ----------

Object.assign(ITEMS, {
  cabinet(ctx, x, y) {
    slab(ctx, x, y, 26, 42, "#8d99ad", "#3a4150");
    for (let d = 0; d < 3; d++) {
      ctx.rect(x + 3, y + 3 + d * 13, 20, 11, "#9fabbd");
      ctx.rect(x + 3, y + 3 + d * 13, 20, 1, "#c9d3e0");
      ctx.rect(x + 3, y + 13 + d * 13, 20, 1, "#6a7586");
      ctx.rect(x + 10, y + 7 + d * 13, 6, 2, "#3a4150");
    }
  },
  watercooler(ctx, x, y) {
    ellipse(ctx, x + 11, y + 9, 8, 9, "#2c5fa0");
    ellipse(ctx, x + 11, y + 9, 7, 8, "#5aa0e6");
    ctx.rect(x + 7, y + 3, 3, 8, "#a8d2f8");
    slab(ctx, x + 2, y + 18, 20, 28, "#dfe5ec", "#5a6372");
    ctx.rect(x + 6, y + 24, 5, 3, "#4a90e2");
    ctx.rect(x + 13, y + 24, 5, 3, "#e05a4f");
    ctx.rect(x + 5, y + 31, 14, 7, "#aab3be");
    ctx.rect(x + 5, y + 31, 14, 1, "#c9d3e0");
  },
  copier(ctx, x, y) {
    slab(ctx, x, y + 14, 36, 22, "#aeb7c4", "#3a4150");
    slab(ctx, x + 2, y + 6, 32, 10, "#dfe5ec", "#3a4150");
    ctx.rect(x + 5, y + 9, 22, 3, "#8d99ad");
    ctx.rect(x + 28, y + 18, 5, 3, "#4cd964");
    ctx.rect(x + 4, y + 26, 22, 2, "#6a7586");
    ctx.rect(x + 4, y + 36, 28, 8, "#5a6372");
    ctx.rect(x + 6, y + 2, 14, 5, "#fbfbf7");
  },
  bin(ctx, x, y) {
    ctx.rect(x + 1, y + 2, 14, 14, "#2c3344");
    ctx.rect(x + 2, y + 3, 12, 12, "#4a5468");
    ctx.rect(x, y, 16, 3, "#6a7586");
    ctx.rect(x + 4, y + 5, 1, 9, "#3a4150");
    ctx.rect(x + 8, y + 5, 1, 9, "#3a4150");
    ctx.rect(x + 11, y + 5, 1, 9, "#3a4150");
  },
  stool(ctx, x, y) {
    ctx.rect(x, y, 16, 5, "#2a1a10");
    ctx.rect(x + 1, y + 1, 14, 3, "#c0392b");
    ctx.rect(x + 7, y + 5, 2, 8, "#4a4f5c");
    ctx.rect(x + 3, y + 13, 10, 2, "#2c3344");
  },
  plantSmall(ctx, x, y) {
    plantPixels(ctx, x, y);
  },
  coatrack(ctx, x, y) {
    ctx.rect(x + 8, y + 4, 3, 44, "#6b4a2a");
    ctx.rect(x + 3, y + 46, 13, 4, "#4a2f18");
    for (const [hx, hy] of [[x + 2, y + 6], [x + 11, y + 6], [x + 3, y + 14], [x + 11, y + 14]]) ctx.rect(hx, hy, 6, 2, "#8a5a2e");
    slab(ctx, x - 1, y + 8, 9, 22, "#3d6fd8", "#1b2a4a");
    ctx.rect(x + 11, y + 16, 8, 18, "#c0392b");
    ctx.rect(x + 11, y + 16, 8, 1, "#e0685c");
  },
  lockers(ctx, x, y) {
    for (let k = 0; k < 3; k++) {
      slab(ctx, x + k * 11, y, 11, 52, k % 2 ? "#5a7a9a" : "#4a6a8a", "#1b2a3a");
      ctx.rect(x + k * 11 + 3, y + 5, 5, 8, "#2b3f55");
      ctx.rect(x + k * 11 + 8, y + 26, 2, 5, "#c9d3e0");
    }
  },
  vending(ctx, x, y) {
    slab(ctx, x, y, 28, 52, "#c0392b", "#4a1410");
    ctx.rect(x + 3, y + 4, 16, 30, "#1b2230");
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) ctx.rect(x + 4 + c * 5, y + 6 + r * 9, 4, 6, ["#f2c04d", "#4a90e2", "#e05a4f", "#4cd964"][(r * 3 + c) % 4]);
    ctx.rect(x + 21, y + 6, 5, 12, "#2b313c");
    ctx.rect(x + 22, y + 8, 3, 2, "#4cd964");
    ctx.rect(x + 4, y + 38, 20, 10, "#14171d");
  },
  tableCoffee(ctx, x, y) {
    slab(ctx, x, y, 36, 8, "#a07a4a", "#2a1a10");
    ctx.rect(x + 3, y + 8, 4, 12, "#5a3a1e");
    ctx.rect(x + 29, y + 8, 4, 12, "#5a3a1e");
    ctx.rect(x + 6, y - 5, 7, 6, "#f2eee8");
    ctx.rect(x + 7, y - 4, 5, 2, "#7a4a24");
    ctx.rect(x + 22, y - 3, 10, 4, "#c0392b");
    ctx.rect(x + 22, y - 3, 10, 1, "#e0685c");
  },
  bench(ctx, x, y) {
    slab(ctx, x, y, 46, 8, "#a07a4a", "#2a1a10");
    ctx.rect(x + 3, y + 8, 4, 12, "#5a3a1e");
    ctx.rect(x + 39, y + 8, 4, 12, "#5a3a1e");
    ctx.rect(x, y - 12, 46, 3, "#8a5a2e");
    ctx.rect(x + 4, y - 9, 3, 9, "#8a5a2e");
    ctx.rect(x + 39, y - 9, 3, 9, "#8a5a2e");
  },
  armchair(ctx, x, y) {
    slab(ctx, x + 2, y, 24, 14, "#a0453a", "#3a1410");
    slab(ctx, x, y + 12, 28, 14, "#c0584a", "#3a1410");
    slab(ctx, x - 2, y + 8, 7, 20, "#8a3a30", "#3a1410");
    slab(ctx, x + 23, y + 8, 7, 20, "#8a3a30", "#3a1410");
    ctx.rect(x + 3, y + 28, 4, 4, DARK);
    ctx.rect(x + 21, y + 28, 4, 4, DARK);
  },
});

/** How big each piece is, `[width, height, left padding]` in pixels, so a room can stand them side by side on a line. */
export const ITEM_SIZE = {
  bookshelf: [28, 54, 0], lamp: [29, 54, 0], sofa: [40, 44, 3], rack: [24, 54, 0], globe: [24, 35, 0], bigplant: [28, 48, 0],
  aquarium: [32, 50, 0], easel: [28, 52, 0], speaker: [22, 38, 0], coffee: [30, 50, 0], fridge: [24, 54, 0], toolbench: [30, 50, 0],
  shelfBoxes: [28, 54, 0], telescope: [28, 56, 0], cabinet: [26, 42, 0], watercooler: [24, 46, 0], copier: [36, 44, 0], bin: [16, 16, 0],
  stool: [16, 15, 0], plantSmall: [18, 26, 0], coatrack: [20, 50, 1], lockers: [33, 52, 0], vending: [28, 52, 0], tableCoffee: [36, 20, 0],
  bench: [46, 20, 0], armchair: [32, 32, 2],
};
