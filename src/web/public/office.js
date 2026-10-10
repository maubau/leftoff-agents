// The office: each agent at a desk, the project manager at the head of the room, and the work moving
// between them. One drawing for two places — the panel animates it in a <canvas>, the hub renders a
// still of it to PNG for Telegram — so it draws with a single primitive, rect(x, y, w, h, colour), and
// knows nothing of either. Everything is drawn from code: no image assets, nothing to license.
//
// Where things are (the layout, the routes people walk, the scenes) is in office units; what is drawn is RES
// pixels to a unit, so the drawing can have the detail of art.js. A caller makes its canvas `layout.width * RES`
// wide.

import { ITEMS, RES, above, armsPixels, bubblePixels, deskPixels, ellipse, floorPixels, headPixels, lookOf, paperPixels, plantPixels, seatedPixels, shade, standingPixels, wallPixels, windowPixels } from "./art.js";
import { drawText, fit, textWidth } from "./pixeltext.js";

export { RES };

/** Size of one workstation, in office units (the panel and the PNG scale them up). */
const CELL_W = 56;
const CELL_H = 50;
/** Extra height under each row of agents when the panel prints their names there (model.captions). */
const CAPTION_H = 18;
const WALL = 24;
const MARGIN = 8;
const MIN_COLS = 3;
const MAX_COLS = 4;

const C = {
  wall: "#dfe4ea", wallLine: "#c3cbd6", skirting: "#7b5a3a",
  floorA: "#9db4c8", floorB: "#8aa2b8",
  board: "#e9edf2", boardFrame: "#8d99ad",
  todo: "#9aa3b2", doing: "#4a90e2", blocked: "#e05a4f", done: "#3fb950",
  window: "#7fb0d9", windowFrame: "#c9d3e0", sky: "#a9cdeb",
  deskTop: "#c08a52", desk: "#8f5f33", deskShade: "#74491f", pmDesk: "#5b3a24", pmDeskTop: "#7a5236",
  plate: "#efe3c2", plateText: "#3a2a1a",
  chair: "#262a33", chairHi: "#353b47",
  monitor: "#1b1f27", screenOff: "#2b313c", screenOn: "#1e3a2c", code: ["#5fd38a", "#8fd0ff", "#ffd479"],
  keyboard: "#d5d9e0",
  paper: "#fbfbf7", paperLine: "#9aa3b2", path: "#c9b98a",
  bubble: "#ffffff", bubbleEdge: "#2b313c",
  plant: "#3f8f4f", plantDark: "#2f6e3c", pot: "#b5643a",
  tie: "#c0392b",
  trousers: "#2f3542", shoe: "#14161b", phone: "#1b1f27", phoneLit: ["#8fd0ff", "#4a90e2"],
};

/** The room with the lights off: nobody works there (a project with no agent). */
const DIM = {
  wall: "#161c2b", wallLine: "#1c2437", skirting: "#10141f", floorA: "#26221e", floorB: "#2a2622",
  board: "#8a919b", boardFrame: "#4d5563", windowFrame: "#4a5668", sky: "#1b2638",
};

const BRIGHT = C;
const SHIRTS = { "🛠️": "#3d6fd8", "🎨": "#c04fb0", "🧪": "#3a9d5d", "📝": "#d98a2b", "🚀": "#d04a3a", "📊": "#2a9d9d", "🤖": "#7d8796" };

/** 5×5 glyphs for the bubble over an agent's head. */
const GLYPHS = {
  blocked: { colour: "#e05a4f", rows: ["..x..", "..x..", "..x..", ".....", "..x.."] },
  needs: { colour: "#e3a008", rows: [".xxx.", "...x.", "..x..", ".....", "..x.."] },
  done: { colour: "#3fb950", rows: [".....", "....x", "...x.", "x.x..", ".x..."] },
  idle: { colour: "#7d8796", rows: ["xxxx.", "..x..", ".x...", "xxxx.", "....."] },
  awaiting: { colour: "#4a90e2", rows: ["xxxxx", ".x.x.", "..x..", ".x.x.", "xxxxx"] },
  // What the PM and an agent say to each other when one comes to the other's side.
  ask: { colour: "#4a90e2", rows: [".xxx.", "...x.", "..x..", ".....", "..x.."] },
  tell: { colour: "#4a90e2", rows: ["..x..", "..x..", "..x..", ".....", "..x.."] },
  talk: { colour: "#7d8796", rows: [".....", ".....", "x.x.x", ".....", "....."] },
};

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}

/** Plain upper-case ASCII for a plate: accents dropped, anything else becomes a space. */
export function plateText(name, max = 12) {
  return String(name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 .\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * What the office shows, from the panel's project data: who sits where, in what state, and which
 * handoffs are on their way. `face` is the emoji of the agent's role; it picks the shirt.
 */
export function officeModel(project) {
  const agents = (project.agents ?? []).map((a) => ({
    id: a.id,
    plate: plateText(a.id),
    face: a.face ?? null,
    state:
      a.live === "running" ? "working"
        : a.status === "blocked" ? "blocked"
        : a.status === "needs_input" ? "needs"
        : a.awaiting ? "awaiting"
        : a.status === "done" ? "done"
        : "idle",
  }));
  return {
    agents,
    handoffs: (project.handoffs ?? []).filter((h) => agents.some((a) => a.id === h.from) && agents.some((a) => a.id === h.to)),
    counts: project.counts ?? { todo: 0, doing: 0, blocked: 0, done: 0 },
  };
}

/** Where everything is: the PM's desk at the head of the room, then the agents, row after row. */
export function officeLayout(model) {
  const n = model.agents.length;
  const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, n));
  // A room with the lights off (no agent in the project) is only the PM's row.
  const rows = model.off ? 0 : Math.max(1, Math.ceil(n / cols));
  // The panel prints each agent's name and role under its desk; the picture sent to chat has no such room.
  const rowH = CELL_H + (model.captions ? CAPTION_H : 0);
  const width = MARGIN * 2 + cols * CELL_W;
  const height = WALL + CELL_H + rowH * rows + 4;
  const pm = { x: MARGIN + ((cols - 1) * CELL_W) / 2, y: WALL };
  const stations = model.agents.map((agent, i) => {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    // A short last row is centred under the others.
    const offset = ((cols - inRow) * CELL_W) / 2;
    return { agent, x: MARGIN + offset + (i % cols) * CELL_W, y: WALL + CELL_H + row * rowH };
  });
  // Where a caption goes: under the desk, between its legs and the bubble of the row below.
  const captions = model.captions ? stations.map((s) => ({ id: s.agent.id, x: s.x + 2, y: s.y + 37, w: CELL_W - 4, h: CAPTION_H + 9 })) : [];
  return { width, height, cols, pm, stations, captions };
}

/**
 * What a room looks like when it is one of several: each project gets its own walls, floor, rug and two pieces of
 * furniture, so it can be told from the others at a glance. A theme is chosen by the project (see themeIndexes);
 * without one the room is the plain office of the picture sent to chat.
 */
export const THEMES = [
  { name: "library", colors: { wall: "#4a3426", wallLine: "#523b2b", skirting: "#2e2018", floorA: "#7a5230", floorB: "#6e4a2b", sky: "#a9cdeb" }, floor: "planks", rug: ["#7b2d2d", "#a24a3a"], items: ["bookshelf", "lamp"] },
  { name: "lounge", colors: { wall: "#2f4a6b", wallLine: "#375678", skirting: "#1f3148", floorA: "#3a4666", floorB: "#34405f", sky: "#a9cdeb" }, floor: "stripes", rug: ["#3a6ea5", "#5a8fc4"], items: ["sofa", "lamp"] },
  { name: "lab", colors: { wall: "#9fb0c2", wallLine: "#aab9ca", skirting: "#6f7f90", floorA: "#cfd6de", floorB: "#bcc5cf", sky: "#d6ecff" }, floor: "tiles", rug: null, items: ["rack", "globe"] },
  { name: "garden", colors: { wall: "#2f5a3a", wallLine: "#376443", skirting: "#1e3a26", floorA: "#5b8c4a", floorB: "#528242", sky: "#bfe3f5" }, floor: "grass", rug: ["#8a6a3a", "#a8854d"], items: ["bigplant", "aquarium"] },
  { name: "studio", colors: { wall: "#5a2f6b", wallLine: "#663878", skirting: "#3a1d46", floorA: "#2b2433", floorB: "#302838", sky: "#e7c8f0" }, floor: "checker", rug: ["#1f7f8a", "#2fa3a8"], items: ["easel", "speaker"] },
  { name: "cafe", colors: { wall: "#7b3b2a", wallLine: "#86432f", skirting: "#4d2418", floorA: "#d8cdb8", floorB: "#a33b34", sky: "#f2d9a0" }, floor: "checker", rug: null, items: ["coffee", "fridge"] },
  { name: "workshop", colors: { wall: "#8a5a2a", wallLine: "#95632f", skirting: "#5a3a18", floorA: "#6b6f76", floorB: "#62666d", sky: "#cfe3ee" }, floor: "tiles", rug: ["#e0b020", "#2b2b2b"], items: ["toolbench", "shelfBoxes"] },
  { name: "observatory", colors: { wall: "#16213d", wallLine: "#1c2a4b", skirting: "#0d1426", floorA: "#2a3350", floorB: "#262e49", sky: "#0f1830" }, floor: "checker", rug: ["#3b4a7a", "#52639b"], items: ["telescope", "globe"], stars: true },
];

/** Which theme each project gets: by a hash of its id, and the next free one if that is taken, so projects differ. */
export function themeIndexes(ids) {
  const out = new Map();
  const taken = new Set();
  for (const id of [...ids].sort()) {
    let i = hash(id) % THEMES.length;
    if (taken.size < THEMES.length) while (taken.has(i)) i = (i + 1) % THEMES.length;
    taken.add(i);
    out.set(id, i);
  }
  return out;
}

function room(ctx, layout, counts, off = false, themeIndex = undefined) {
  const W = layout.width * RES;
  const H = layout.height * RES;
  const wallH = WALL * RES;
  const theme = themeIndex === undefined ? undefined : THEMES[themeIndex % THEMES.length];
  const C = off ? { ...BRIGHT, ...theme?.colors, ...DIM } : theme ? { ...BRIGHT, ...theme.colors } : BRIGHT;
  // The floor in the pattern of the room's theme, a rug under the desks, and the back wall over them.
  floorPixels(ctx, W, H, wallH, C.floorA, C.floorB, theme?.floor);
  if (theme?.rug && !off) {
    const rx = 44;
    const ry = wallH + 24;
    const rw = W - 88;
    const rh = H - wallH - 44;
    ctx.rect(rx, ry, rw, rh, shade(theme.rug[0], -0.4));
    ctx.rect(rx + 1, ry + 1, rw - 2, rh - 2, theme.rug[0]);
    ctx.rect(rx + 5, ry + 5, rw - 10, rh - 10, theme.rug[1]);
    ctx.rect(rx + 9, ry + 9, rw - 18, rh - 18, theme.rug[0]);
    for (let x = rx + 14; x < rx + rw - 14; x += 6) ctx.rect(x, ry + 2, 2, 2, theme.rug[1]);
  }
  wallPixels(ctx, W, wallH, C.wall, C.wallLine, C.skirting);
  // A window on the left, and a whiteboard with the sprint on the right.
  windowPixels(ctx, 16, 6, 44, 32, C.windowFrame, C.sky);
  const bw = 88;
  const bx = W - bw - 16;
  ctx.rect(bx, 6, bw, 34, shade(C.boardFrame, -0.4));
  ctx.rect(bx + 1, 7, bw - 2, 32, C.boardFrame);
  ctx.rect(bx + 3, 9, bw - 6, 28, C.board);
  ctx.rect(bx + 3, 9, bw - 6, 1, shade(C.board, -0.12));
  ["todo", "doing", "blocked", "done"].forEach((column, i) => {
    const cx = bx + 7 + i * 20;
    ctx.rect(cx, 12, 16, 2, C[column]);
    const notes = Math.min(4, counts[column] ?? 0);
    for (let k = 0; k < notes; k++) {
      const nx = cx + (k % 2) * 8;
      const ny = 17 + Math.floor(k / 2) * 9;
      ctx.rect(nx, ny, 7, 7, shade(C[column], -0.35));
      ctx.rect(nx, ny, 6, 6, C[column]);
      ctx.rect(nx, ny, 6, 1, shade(C[column], 0.3));
    }
  });
  ctx.rect(bx + 6, 37, bw - 12, 2, shade(C.boardFrame, -0.25));
  // A clock and a picture between them (a project's sign hides them on the Home).
  const mid = Math.floor(W / 2);
  ellipse(ctx, mid - 26, 22, 10, 10, "#2a1a12");
  ellipse(ctx, mid - 26, 22, 9, 9, "#f2eee8");
  ctx.rect(mid - 27, 15, 2, 8, "#2a1a12");
  ctx.rect(mid - 27, 22, 6, 2, "#2a1a12");
  ctx.rect(mid + 6, 10, 28, 22, "#2a1a12");
  ctx.rect(mid + 7, 11, 26, 20, "#c9b98a");
  ctx.rect(mid + 9, 13, 22, 16, shade(C.sky, -0.1));
  ctx.rect(mid + 9, 23, 22, 6, "#4f8f5a");
  ctx.rect(mid + 20, 15, 6, 6, "#f2c04d");
  if (theme?.stars && !off) for (let k = 0; k < 18; k++) ctx.rect(70 + (hash(`s${k}`) % Math.max(1, W - 190)), 4 + (hash(`t${k}`) % 30), 2, 2, "#f2eee8");
  // Two pieces of furniture of the theme, one on each side of the desks, and a plant in each corner.
  if (theme && !off) {
    ITEMS[theme.items[0]](ctx, 4, wallH + 10);
    ITEMS[theme.items[1]](ctx, W - 34, wallH + 10);
  }
  plantPixels(ctx, 4, H - 30);
  plantPixels(ctx, W - 22, H - 30);
}

/** A speech bubble with one of the glyphs above ("blocked", "needs", "done", ...) in it, its top left at (x, y) in pixels. */
export function drawBubble(ctx, x, y, name) {
  bubblePixels(ctx, x, y, GLYPHS[name]);
}

/**
 * One desk's furniture: the chair, the desk and its plate, the keyboard, the monitor (lit and scrolling while the
 * agent works) and, for the PM, the tray with a sheet per handoff waiting. `who.mode` "typing" is the PM at its
 * screen, which scrolls faster. The person is drawn separately (stationPeople), so the two can be layers.
 */
function stationFurniture(ctx, x, y, who, t) {
  const X = x * RES;
  const Y = y * RES;
  const typing = who.mode === "typing";
  const working = who.state === "working" || typing;
  const name = fit(who.plate, 68);
  const plateWidth = Math.max(28, textWidth(name) + 10);
  const code = [];
  if (working) {
    const scroll = t ? Math.floor(t / (typing ? 220 : 400)) : 0;
    for (let line = 0; line < 3; line++) {
      const seed = hash(`${who.id}:${line + scroll}`);
      code.push({ dx: (seed % 2) * 2, w: 6 + (seed % 7) * 3, colour: C.code[seed % 3] });
    }
  }
  deskPixels(ctx, X, Y, { manager: who.manager, working, plateWidth, code, tray: who.manager ? who.inTray : 0, plate: C.plate });
  drawText(ctx, name, X + 56 - Math.floor(textWidth(name) / 2), Y + 55, C.plateText);
}

/**
 * The person at a desk and what they do with their hands: typing, or with a phone (the owner wrote from the chat
 * app), and the bubble over their head. `who.away` leaves the chair empty (the agent is walking to the PM);
 * `who.say` is a glyph for a bubble. Drawn after the furniture, over it.
 */
function stationPeople(ctx, x, y, who, t) {
  const X = x * RES;
  const Y = y * RES;
  const { state, mode } = who;
  const typing = mode === "typing";
  const working = state === "working" || typing;
  if (!who.away) {
    seatedPixels(ctx, X, Y, who.look, { tie: who.manager ? C.tie : undefined, side: typing });
    // The hands on the keyboard move while the agent works.
    armsPixels(ctx, X, Y, who.look, working && t ? Math.floor(t / (typing ? 110 : 180)) % 2 * 2 : 0);
    if (mode === "phone") {
      // The PM picks up its phone, which lights as the thumb moves.
      const sleeve = shade(who.look.shirt, -0.12);
      ctx.rect(X + 59, Y + 28, 6, 19, "#2a1a12");
      ctx.rect(X + 60, Y + 28, 4, 18, sleeve);
      ctx.rect(X + 61, Y + 12, 11, 17, "#0d1014");
      ctx.rect(X + 62, Y + 13, 9, 15, "#1b1f27");
      ctx.rect(X + 63, Y + 14, 7, 12, C.phoneLit[t ? Math.floor(t / 300) % 2 : 0]);
      ctx.rect(X + 58, Y + 26, 9, 6, "#2a1a12");
      ctx.rect(X + 59, Y + 26, 7, 5, who.look.skin);
    }
  }
  const glyph = who.say ? GLYPHS[who.say] : who.away ? null : GLYPHS[state];
  if (glyph && (!who.manager || who.say)) {
    // The idle "z" drifts up a little; the others stay put so they can be read.
    const lift = !who.say && state === "idle" && t ? Math.floor(t / 600) % 2 : 0;
    bubblePixels(ctx, X + 60, Y - 4 - lift * 2, glyph);
  }
}

// ---------- visits: an agent gets up, walks to the PM, they exchange a word, it walks back ----------

/** How fast an agent walks (office pixels per ms), how long each side speaks, and the pause before it turns back. */
const WALK = 0.045;
const SAY_MS = 1100;

/**
 * The route of a visit, in feet positions: from the chair behind the desk, out sideways into the gap
 * between desks, up that gap to the aisle in front of the PM's row, and along it to the PM's side.
 */
function visitRoute(layout, agentId) {
  const st = layout.stations.find((s) => s.agent.id === agentId);
  if (!st) return null;
  const aisle = layout.pm.y + 44;
  const meet = { x: layout.pm.x, y: layout.pm.y + 34 };
  const points = [
    { x: st.x + 24, y: st.y + 28 },
    { x: st.x, y: st.y + 28 },
    { x: st.x, y: aisle },
    { x: meet.x, y: aisle },
    meet,
  ];
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  return { st, points, length };
}

/** A point `d` pixels along the route (walking in straight, axis-aligned legs). */
function along(points, d) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (d <= len || i === points.length - 1) {
      const k = len ? Math.min(1, d / len) : 1;
      return { x: Math.round(a.x + (b.x - a.x) * k), y: Math.round(a.y + (b.y - a.y) * k) };
    }
    d -= len;
  }
  return points[0];
}

/** What the PM and the agent say, by the kind of contact: a question, an order, or just a word. */
const SAYS = {
  status: ["ask", "done"],
  command: ["tell", "done"],
  handoff: ["tell", "done"],
};

/**
 * Where everything in motion is at time `t`. `scene` is
 * `{ pm?: "typing" | "phone", visits?: [{ agent, kind, at }], reduced?: boolean }`, with `at` on the same clock
 * as `t`. Visits play one after another (two agents never stand in the same spot), each starting when it was
 * asked or when the previous one ends. With `reduced` nobody walks: the PM and the agent only speak, one
 * bubble after the other, from where they sit.
 */
export function playScene(model, layout, scene = {}, t = 0) {
  const walkers = [];
  const speaking = new Map(); // station id → glyph
  let pmSays = null;
  let busy = Boolean(scene.pm);
  let free = -Infinity;
  for (const visit of scene.visits ?? []) {
    const route = visitRoute(layout, visit.agent);
    if (!route) continue;
    const walk = scene.reduced ? 0 : route.length / WALK;
    const total = walk * 2 + SAY_MS * 2;
    const start = Math.max(visit.at, free);
    free = start + total;
    const e = t - start;
    if (e >= total) continue;
    busy = true;
    if (e < 0) continue;
    const [pmGlyph, agentGlyph] = SAYS[visit.kind] ?? ["talk", "done"];
    const step = Math.floor(e / 130) % 2;
    if (e < walk) walkers.push({ agent: visit.agent, ...along(route.points, e * WALK), step });
    else if (e < walk + SAY_MS) {
      if (walk) walkers.push({ agent: visit.agent, ...route.points.at(-1), step: 0 });
      pmSays = pmGlyph;
    } else if (e < walk + SAY_MS * 2) {
      if (walk) walkers.push({ agent: visit.agent, ...route.points.at(-1), step: 0, say: agentGlyph });
      else speaking.set(visit.agent, agentGlyph);
    } else {
      const back = (e - walk - SAY_MS * 2) * WALK;
      walkers.push({ agent: visit.agent, ...along([...route.points].reverse(), back), step });
    }
  }
  return { walkers, speaking, pmSays, busy };
}

/**
 * An agent on its feet. Anything of it that is behind a desk (the legs of someone just up from the chair) is hidden:
 * a desk covers the part of the walker that is behind it.
 */
function walker(ctx, layout, w, who) {
  const regions = [...layout.stations, layout.pm]
    .filter((s) => w.y < s.y + 33)
    .map((s) => ({ x: s.x * RES + 16, y: s.y * RES + 40, w: 80, h: 26 }));
  const fx = w.x * RES;
  const fy = w.y * RES;
  standingPixels(hidden(ctx, regions), fx, fy, who.look, w.step);
  if (w.say) bubblePixels(ctx, fx - 9, fy - 64, GLYPHS[w.say]);
}

/** A drawing that leaves out what falls inside `regions` (`{ x, y, w, h }` each). */
function hidden(ctx, regions) {
  return {
    rect(x, y, w, h, colour) {
      for (let row = 0; row < h; row++) {
        const yy = y + row;
        let spans = [[x, x + w]];
        for (const r of regions) {
          if (yy < r.y || yy >= r.y + r.h) continue;
          spans = spans.flatMap(([a, b]) => {
            if (b <= r.x || a >= r.x + r.w) return [[a, b]];
            const kept = [];
            if (a < r.x) kept.push([a, r.x]);
            if (b > r.x + r.w) kept.push([r.x + r.w, b]);
            return kept;
          });
        }
        for (const [a, b] of spans) if (b > a) ctx.rect(a, yy, b - a, 1, colour);
      }
    },
  };
}

/** Where a handoff's sheet is at time t: from the asker, via the PM's desk, to the teammate. */
function sheetAt(path, t) {
  const legs = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const len = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
    legs.push({ from: path[i - 1], to: path[i], len });
    total += len;
  }
  if (!total) return path[0];
  let d = ((t / 40) % (total + 40)) - 20; // a pause at each end
  d = Math.max(0, Math.min(total, d));
  for (const leg of legs) {
    if (d <= leg.len) {
      const k = leg.len ? d / leg.len : 0;
      return { x: Math.round(leg.from.x + (leg.to.x - leg.from.x) * k), y: Math.round(leg.from.y + (leg.to.y - leg.from.y) * k) };
    }
    d -= leg.len;
  }
  return path.at(-1);
}

/**
 * Draw the whole office. `ctx` needs one method, rect(x, y, w, h, colour); `t` is a time in ms for
 * the animation (0 for a still, as in the picture sent to chat). `scene` (see playScene) is what is
 * happening right now: the PM answering the owner, an agent walking over to the PM. Without it the
 * drawing is the plain office.
 *
 * `layer` draws only one of the three the picture is made of, from the back to the front: "room" (floor, walls,
 * window, whiteboard), "desks" (chairs, desks, monitors, the handoff sheets on their way) and "people" (who sits
 * there, what they hold, the bubbles, whoever is walking). The panel stacks them as separate canvases that move
 * at different speeds; drawn one after the other, in that order, they are the whole picture.
 */
export function drawOffice(ctx, model, t = 0, scene = undefined, layer = undefined) {
  const layout = officeLayout(model);
  const play = scene ? playScene(model, layout, scene, t) : undefined;
  // In reduced motion the scene still tells its story, but nothing on the desks moves.
  const motion = scene?.reduced ? 0 : t;
  const want = (name) => layer === undefined || layer === name;
  const people = new Map();
  const looks = new Map();
  const whos = [];
  for (const s of layout.stations) {
    const h = hash(s.agent.id);
    people.set(s.agent.id, s);
    const look = lookOf(h, SHIRTS[s.agent.face] ?? SHIRTS["🤖"]);
    looks.set(s.agent.id, { look });
    const away = play?.walkers.some((w) => w.agent === s.agent.id);
    whos.push([s.x, s.y, { ...s.agent, look, away, ...(play?.speaking.has(s.agent.id) ? { say: play.speaking.get(s.agent.id) } : {}) }]);
  }
  // A room with the lights off has no one at the PM's desk either.
  whos.push([layout.pm.x, layout.pm.y, { id: "pm", plate: "PM", state: model.handoffs.length ? "working" : "idle", manager: true, inTray: model.handoffs.length, away: Boolean(model.off), look: { skin: "#e2b48f", hairIndex: 4, style: 1, glasses: false, shirt: "#e8e8ee" }, ...(scene?.pm && !model.off ? { mode: scene.pm } : {}), ...(play?.pmSays ? { say: play.pmSays } : {}) }]);

  if (want("room")) room(ctx, layout, model.counts, Boolean(model.off), model.theme);
  if (want("desks")) {
    for (const [x, y, who] of whos) stationFurniture(ctx, x, y, who, motion);
    handoffTrails(ctx, model, layout, people, motion);
  }
  if (want("people")) {
    for (const [x, y, who] of whos) stationPeople(ctx, x, y, who, motion);
    for (const w of play?.walkers ?? []) walker(ctx, layout, w, looks.get(w.agent));
  }
  return layout;
}

/** Each handoff: a dotted trail from the asker's desk to the PM's and on to the teammate's, and a sheet on it. */
function handoffTrails(ctx, model, layout, people, motion) {
  const pmDesk = { x: layout.pm.x + 28, y: layout.pm.y + 37 };
  model.handoffs.forEach((handoff, i) => {
    const a = people.get(handoff.from);
    const b = people.get(handoff.to);
    if (!a || !b) return;
    const lane = pmDesk.y + 5 + (i % 3) * 2;
    const path = [
      { x: a.x + 6, y: a.y + 4 },
      { x: a.x + 6, y: lane },
      { x: pmDesk.x, y: lane },
      { x: pmDesk.x, y: pmDesk.y },
      { x: pmDesk.x, y: lane },
      { x: b.x + 50, y: lane },
      { x: b.x + 50, y: b.y + 4 },
    ];
    for (let k = 1; k < path.length; k++) {
      const p = path[k - 1];
      const q = path[k];
      const steps = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      for (let s = 0; s <= steps; s += 3) {
        const f = steps ? s / steps : 0;
        ctx.rect(Math.round((p.x + (q.x - p.x) * f) * RES), Math.round((p.y + (q.y - p.y) * f) * RES), 2, 2, C.path);
      }
    }
    const at = motion ? sheetAt(path, motion + i * 900) : path[0];
    paperPixels(ctx, at.x * RES - 5, at.y * RES - 6);
  });
}
