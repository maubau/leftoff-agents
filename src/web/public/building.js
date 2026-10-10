// The building: one room for each project, side by side and in rows, each with its own agents in it, seen
// through four layers from the back to the front: the background (sky, skyline, the building's facade), the
// rooms (floor, walls, window, whiteboard), the desks (furniture, monitors) and the people. The panel stacks
// them as separate canvases and moves them at different speeds with the pointer or the scroll, which is what
// gives it depth. Like office.js it draws with one primitive, rect(x, y, w, h, colour), and knows nothing of
// the page; the picture of one room is office.js's.

import { drawOffice, officeLayout, playScene } from "./office.js";

/** Space around the rooms (office pixels): at the sides and bottom, above them (the sky), and between them. */
export const MARGIN = 10;
export const TOP = 22;
export const GAP = 8;
/** The background is drawn this much beyond the edges, so it can move without showing a gap. */
export const BLEED = 4;
/** How far the nearest layer moves at most (office pixels), and how much of that each layer takes, back to front. */
export const SHIFT = 5;
export const DEPTH = { bg: 0.15, rooms: 0.45, desks: 0.8, people: 1 };
/** The smallest size of an office pixel on screen (CSS pixels) worth laying the building out for. */
export const MIN_SCALE = 1.8;

const FRAME = "#10141f";

/**
 * Where the rooms go. `rooms` is `[{ id, name, model }]` (a model as office.js draws it); `maxWidth` the widest
 * a row may be, in office pixels. Rooms fill a row until the next would not fit; each row is centred.
 */
export function buildingLayout(rooms, maxWidth) {
  const placed = rooms.map((room) => ({ ...room, layout: officeLayout(room.model), x: 0, y: 0 }));
  const widest = Math.max(0, ...placed.map((r) => r.layout.width));
  const limit = Math.max(maxWidth, widest + MARGIN * 2);
  const rows = [];
  let row = [];
  let rowWidth = 0;
  for (const room of placed) {
    const grown = row.length ? rowWidth + GAP + room.layout.width : room.layout.width;
    if (row.length && grown + MARGIN * 2 > limit) {
      rows.push({ rooms: row, width: rowWidth });
      row = [];
      rowWidth = 0;
    }
    rowWidth = row.length ? rowWidth + GAP + room.layout.width : room.layout.width;
    row.push(room);
  }
  if (row.length) rows.push({ rooms: row, width: rowWidth });

  const width = Math.max(0, ...rows.map((r) => r.width)) + MARGIN * 2;
  let y = TOP;
  for (const r of rows) {
    let x = MARGIN + Math.floor((width - MARGIN * 2 - r.width) / 2);
    for (const room of r.rooms) {
      room.x = x;
      room.y = y;
      x += room.layout.width + GAP;
    }
    y += Math.max(...r.rooms.map((room) => room.layout.height)) + GAP;
  }
  const height = rows.length ? y - GAP + MARGIN : TOP + MARGIN;
  for (const room of placed) {
    // The name of the project goes on the wall between the window and the whiteboard; each agent's caption under its desk.
    room.sign = { x: room.x + 34, y: room.y + 4, w: Math.max(0, room.layout.width - 90), h: 15 };
    room.captions = room.layout.captions.map((c) => ({ ...c, x: c.x + room.x, y: c.y + room.y }));
  }
  return { width, height, rooms: placed };
}

/** A tiny deterministic generator, so the skyline is the same every time. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function background(ctx, b) {
  const W = b.width + BLEED * 2;
  const H = b.height + BLEED * 2;
  const horizon = TOP + BLEED;
  // Sky, lighter towards the horizon.
  ["#5f9fd6", "#74afdf", "#8bbfe8", "#a2cfee", "#bcdcf3"].forEach((colour, i, all) => {
    const top = Math.floor((horizon * i) / all.length);
    ctx.rect(0, top, W, Math.ceil(horizon / all.length) + 1, colour);
  });
  const rnd = lcg(W * 31 + H);
  for (let i = 0; i < Math.max(2, Math.floor(W / 90)); i++) {
    const x = Math.floor(rnd() * (W - 16));
    const y = 2 + Math.floor(rnd() * 5);
    ctx.rect(x + 3, y, 8, 3, "#e3eef8");
    ctx.rect(x, y + 2, 14, 3, "#e3eef8");
  }
  // Two skylines, the far one paler.
  [["#6f92b8", 0.55], ["#4f7299", 0.85]].forEach(([colour, tall]) => {
    let x = 0;
    while (x < W) {
      const w = 5 + Math.floor(rnd() * 8);
      const h = 4 + Math.floor(rnd() * (TOP - 6) * tall);
      ctx.rect(x, horizon - h, Math.min(w, W - x), h, colour);
      x += w + Math.floor(rnd() * 3);
    }
  });
  // The facade of the building the rooms are in: a roof ledge, then brick.
  ctx.rect(0, horizon, W, H - horizon, "#2b2f3a");
  ctx.rect(0, horizon - 2, W, 2, "#3d4352");
  for (let y = horizon + 3, row = 0; y < H; y += 6, row++) {
    ctx.rect(0, y, W, 1, "#323744");
    for (let x = (row % 2) * 6; x < W; x += 12) ctx.rect(x, y + 1, 1, Math.min(5, H - y - 1), "#323744");
  }
}

/**
 * Draw one layer of the building: "bg", "rooms", "desks" or "people". `scenes` maps a room's id to what is
 * happening in it right now (see office.js playScene); `t` is the time in ms.
 */
export function drawBuilding(ctx, building, layer, t = 0, scenes = new Map()) {
  if (layer === "bg") {
    background({ rect: (x, y, w, h, colour) => ctx.rect(x, y, w, h, colour) }, building);
    return;
  }
  for (const room of building.rooms) {
    const at = { rect: (x, y, w, h, colour) => ctx.rect(x + room.x, y + room.y, w, h, colour) };
    if (layer === "rooms") {
      // The walls between this room and its neighbours.
      ctx.rect(room.x - 2, room.y - 2, room.layout.width + 4, room.layout.height + 4, FRAME);
      drawOffice(at, room.model, t, scenes.get(room.id), "room");
    } else drawOffice(at, room.model, t, scenes.get(room.id), layer);
  }
}

/** Whether anything in any room is moving, so the page knows to draw fast. */
export function buildingBusy(building, t = 0, scenes = new Map()) {
  return building.rooms.some((room) => playScene(room.model, room.layout, scenes.get(room.id) ?? {}, t).busy);
}
