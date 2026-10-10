// The office: each agent at a desk, the project manager at the head of the room, and the work moving
// between them. One drawing for two places — the panel animates it in a <canvas>, the hub renders a
// still of it to PNG for Telegram — so it draws with a single primitive, rect(x, y, w, h, colour), and
// knows nothing of either. Everything is drawn from code: no image assets, nothing to license.

/** Size of one workstation, in office pixels (the panel and the PNG scale them up). */
const CELL_W = 56;
const CELL_H = 50;
/** Extra height under each row of agents when the panel prints their names there (model.captions). */
const CAPTION_H = 18;
const WALL = 24;
const MARGIN = 8;
const MIN_COLS = 3;
const MAX_COLS = 4;

const C = {
  wall: "#2a3550", wallLine: "#33405f", skirting: "#1d2538",
  floorA: "#3b342e", floorB: "#413a33",
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
const HAIR = ["#2b1d14", "#5a3a22", "#a8763e", "#d9b26a", "#1f1f24", "#8c3b2e", "#c7c7cf"];
const SKIN = ["#f3d2b3", "#e2b48f", "#c68e62", "#8d5a3b", "#f6dcc8"];

/** Upper body behind a desk, 10×11. h hair, s skin, e eyes, m mouth, t shirt, k tie. */
const PERSON = [
  "..hhhhhh..",
  ".hhhhhhhh.",
  ".hssssssh.",
  ".sesssses.",
  ".ssssssss.",
  "..ssmmss..",
  "...ssss...",
  ".tttttttt.",
  "tttttttttt",
  "tttttttttt",
  "tt.tttt.tt",
];
const MANAGER = PERSON.map((row, i) => (i >= 7 ? row.slice(0, 4) + (i === 10 ? "kk" : "kk") + row.slice(6) : row));

/** The PM turned towards its screen, in profile: the head of MANAGER, facing right where the monitor is. */
const MANAGER_SIDE = [
  "..hhhhhh..",
  ".hhhhhhhh.",
  ".hhhsssss.",
  ".hhhsssse.",
  ".hhhssssss",
  "..hhssmss.",
  "...hssss..",
  ...MANAGER.slice(7),
];

/** An agent on its feet: the person above the desk-line, then two frames of legs (together, apart). */
const WALKER = PERSON.slice(0, 10);
const LEGS = [
  ["..pppppp..", "..pp..pp..", "..pp..pp..", "..pp..pp..", ".bbb..bbb."],
  ["..pppppp..", ".pp....pp.", ".pp....pp.", "pp......pp", "bb......bb"],
];
const WALKER_H = 15;

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

/** A 3×5 pixel font: enough for desk plates (upper-case letters, digits, a few signs). */
const FONT = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111",
  F: "111100110100100", G: "011100101101011", H: "101101111101101", I: "111010010010111", J: "001001001101010",
  K: "101101110101101", L: "100100100100111", M: "101111111101101", N: "110101101101101", O: "010101101101010",
  P: "110101110100100", Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101", Y: "101101010010010",
  Z: "111001010100111", 0: "111101101101111", 1: "010110010010111", 2: "110001010100111", 3: "110001010001110",
  4: "101101111001001", 5: "111100110001110", 6: "011100111101111", 7: "111001010010010", 8: "111101111101111",
  9: "111101111001110", "-": "000000111000000", ".": "000000000000010", " ": "000000000000000", "_": "000000000000111",
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

function sprite(ctx, rows, x, y, palette) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const colour = palette[row[dx]];
      if (colour) ctx.rect(x + dx, y + dy, 1, 1, colour);
    }
  });
}

function text(ctx, value, x, y, colour) {
  let cx = x;
  for (const ch of value) {
    const bits = FONT[ch] ?? FONT[" "];
    for (let i = 0; i < 15; i++) if (bits[i] === "1") ctx.rect(cx + (i % 3), y + Math.floor(i / 3), 1, 1, colour);
    cx += 4;
  }
}

const textWidth = (value) => Math.max(0, value.length * 4 - 1);

function room(ctx, layout, counts, off = false) {
  const { width, height } = layout;
  const C = off ? { ...BRIGHT, ...DIM } : BRIGHT;
  // Floor: a checkerboard of 8-pixel tiles.
  for (let y = WALL; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) ctx.rect(x, y, 8, 8, (x / 8 + y / 8) % 2 ? C.floorA : C.floorB);
  }
  ctx.rect(0, 0, width, WALL, C.wall);
  for (let x = 6; x < width; x += 12) ctx.rect(x, 0, 1, WALL - 3, C.wallLine);
  ctx.rect(0, WALL - 3, width, 3, C.skirting);
  // A window on the left, a whiteboard with the sprint on the right.
  ctx.rect(8, 4, 22, 14, C.windowFrame);
  ctx.rect(9, 5, 20, 12, C.sky);
  ctx.rect(18, 5, 2, 12, C.windowFrame);
  ctx.rect(9, 10, 20, 1, C.windowFrame);
  const bw = 44;
  const bx = width - bw - 8;
  ctx.rect(bx, 3, bw, 16, C.boardFrame);
  ctx.rect(bx + 1, 4, bw - 2, 14, C.board);
  ["todo", "doing", "blocked", "done"].forEach((column, i) => {
    const cx = bx + 3 + i * 10;
    ctx.rect(cx, 5, 8, 1, C[column]);
    const notes = Math.min(4, counts[column] ?? 0);
    for (let k = 0; k < notes; k++) ctx.rect(cx + (k % 2) * 4, 8 + Math.floor(k / 2) * 4, 3, 3, C[column]);
  });
  // A plant in each corner of the room.
  plant(ctx, 2, height - 14);
  plant(ctx, width - 9, height - 14);
}

function plant(ctx, x, y) {
  ctx.rect(x + 1, y, 5, 3, C.plant);
  ctx.rect(x, y + 2, 7, 3, C.plantDark);
  ctx.rect(x + 2, y - 2, 3, 2, C.plant);
  ctx.rect(x + 1, y + 5, 5, 5, C.pot);
}

function bubble(ctx, x, y, glyph) {
  ctx.rect(x, y, 9, 8, C.bubbleEdge);
  ctx.rect(x + 1, y + 1, 7, 6, C.bubble);
  ctx.rect(x + 1, y + 8, 2, 1, C.bubbleEdge);
  sprite(ctx, glyph.rows, x + 2, y + 1, { x: glyph.colour });
}

function paper(ctx, x, y) {
  ctx.rect(x, y, 5, 6, C.paper);
  ctx.rect(x + 1, y + 1, 3, 1, C.paperLine);
  ctx.rect(x + 1, y + 3, 3, 1, C.paperLine);
}

/**
 * One desk's furniture: the chair, the desk and its plate, the keyboard, the monitor (lit and scrolling while the
 * agent works) and, for the PM, the tray with a sheet per handoff waiting. `who.mode` "typing" is the PM at its
 * screen, which scrolls faster. The person is drawn separately (stationPeople), so the two can be layers.
 */
function stationFurniture(ctx, x, y, who, t) {
  const { state, plate, mode } = who;
  const typing = mode === "typing";
  const working = state === "working" || typing;
  ctx.rect(x + 17, y + 13, 14, 9, C.chair);
  ctx.rect(x + 18, y + 14, 12, 1, C.chairHi);

  const top = who.manager ? C.pmDeskTop : C.deskTop;
  const front = who.manager ? C.pmDesk : C.desk;
  ctx.rect(x + 8, y + 20, 40, 2, top);
  ctx.rect(x + 8, y + 22, 40, 10, front);
  ctx.rect(x + 8, y + 31, 40, 1, C.deskShade);
  ctx.rect(x + 10, y + 32, 2, 4, C.deskShade);
  ctx.rect(x + 44, y + 32, 2, 4, C.deskShade);
  // The name plate.
  const pw = Math.max(14, textWidth(plate) + 4);
  const px = x + 28 - Math.floor(pw / 2);
  ctx.rect(px, y + 24, pw, 7, C.plate);
  text(ctx, plate, px + 2, y + 25, C.plateText);
  ctx.rect(x + 20, y + 20, 8, 1, C.keyboard);

  // The monitor: lit and scrolling while working, dark otherwise.
  ctx.rect(x + 33, y + 9, 14, 10, C.monitor);
  ctx.rect(x + 39, y + 19, 2, 1, C.monitor);
  ctx.rect(x + 34, y + 10, 12, 7, working ? C.screenOn : C.screenOff);
  if (working) {
    const scroll = t ? Math.floor(t / (typing ? 220 : 400)) : 0;
    for (let line = 0; line < 3; line++) {
      const seed = hash(`${who.id}:${line + scroll}`);
      ctx.rect(x + 35 + (seed % 2), y + 11 + line * 2, 3 + (seed % 7), 1, C.code[seed % 3]);
    }
  }
  if (who.manager && who.inTray) {
    for (let k = 0; k < Math.min(3, who.inTray); k++) paper(ctx, x + 10 + k, y + 14 - k);
  }
}

/**
 * The person at a desk and what they do with their hands: typing, or with a phone (the owner wrote from the chat
 * app), and the bubble over their head. `who.away` leaves the chair empty (the agent is walking to the PM);
 * `who.say` is a glyph for a bubble. Drawn after the furniture: the last row of the sprite, which the desk used
 * to cover, is left out, so the picture is the same as when the person was drawn first.
 */
function stationPeople(ctx, x, y, who, t) {
  const { state, mode } = who;
  const typing = mode === "typing";
  const working = state === "working" || typing;
  if (!who.away) {
    const palette = { h: who.hair, s: who.skin, e: "#1b1b1f", m: "#a0524a", t: who.shirt, k: C.tie };
    sprite(ctx, (who.manager ? (typing ? MANAGER_SIDE : MANAGER) : PERSON).slice(0, 10), x + 19, y + 10, palette);
    // The hands on the keyboard move while the agent works.
    const beat = working && t ? Math.floor(t / (typing ? 110 : 180)) % 2 : 0;
    ctx.rect(x + 19 + beat, y + 20, 2, 1, who.skin);
    ctx.rect(x + 27 - beat, y + 20, 2, 1, who.skin);
  }
  if (mode === "phone") {
    // The PM picks up its phone, which lights as the thumb moves.
    ctx.rect(x + 27, y + 17, 2, 3, who.shirt);
    ctx.rect(x + 29, y + 9, 5, 8, C.phone);
    ctx.rect(x + 30, y + 10, 3, 6, C.phoneLit[t ? Math.floor(t / 300) % 2 : 0]);
    ctx.rect(x + 28, y + 16, 5, 2, who.skin);
  }
  const glyph = who.say ? GLYPHS[who.say] : who.away ? null : GLYPHS[state];
  if (glyph && (!who.manager || who.say)) {
    // The idle "z" drifts up a little; the others stay put so they can be read.
    const lift = !who.say && state === "idle" && t ? Math.floor(t / 600) % 2 : 0;
    bubble(ctx, x + 29, y + 1 - lift, glyph);
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
    { x: st.x + 24, y: st.y + 24 },
    { x: st.x, y: st.y + 24 },
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

/** An agent on its feet. Anything of it that is behind a desk (the legs of someone just up from the chair) is hidden. */
function walker(ctx, layout, w, who) {
  const desks = [...layout.stations, layout.pm].map((s) => ({ x: s.x + 8, y: s.y + 20, bottom: s.y + 32 }));
  const palette = { h: who.hair, s: who.skin, e: "#1b1b1f", m: "#a0524a", t: who.shirt, p: C.trousers, b: C.shoe };
  const rows = [...WALKER, ...LEGS[w.step]];
  const x0 = w.x - 5;
  const y0 = w.y - (WALKER_H - 1);
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const colour = palette[row[dx]];
      if (!colour) continue;
      const px = x0 + dx;
      const py = y0 + dy;
      if (desks.some((d) => w.y < d.bottom && px >= d.x && px < d.x + 40 && py >= d.y && py < d.bottom)) continue;
      ctx.rect(px, py, 1, 1, colour);
    }
  });
  if (w.say) bubble(ctx, w.x - 1, y0 - 9, GLYPHS[w.say]);
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
    const look = { hair: HAIR[h % HAIR.length], skin: SKIN[(h >>> 8) % SKIN.length], shirt: SHIRTS[s.agent.face] ?? SHIRTS["🤖"] };
    looks.set(s.agent.id, look);
    const away = play?.walkers.some((w) => w.agent === s.agent.id);
    whos.push([s.x, s.y, { ...s.agent, ...look, away, ...(play?.speaking.has(s.agent.id) ? { say: play.speaking.get(s.agent.id) } : {}) }]);
  }
  // A room with the lights off has no one at the PM's desk either.
  whos.push([layout.pm.x, layout.pm.y, { id: "pm", plate: "PM", state: model.handoffs.length ? "working" : "idle", manager: true, inTray: model.handoffs.length, away: Boolean(model.off), hair: HAIR[4], skin: SKIN[1], shirt: "#e8e8ee", ...(scene?.pm && !model.off ? { mode: scene.pm } : {}), ...(play?.pmSays ? { say: play.pmSays } : {}) }]);

  if (want("room")) room(ctx, layout, model.counts, Boolean(model.off));
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
        ctx.rect(Math.round(p.x + (q.x - p.x) * f), Math.round(p.y + (q.y - p.y) * f), 1, 1, C.path);
      }
    }
    const at = motion ? sheetAt(path, motion + i * 900) : path[0];
    paper(ctx, at.x - 2, at.y - 3);
  });
}
