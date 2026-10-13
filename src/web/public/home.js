// A project's room as the Home shows it: the office of that project, furnished as its theme says, with its name
// on the sign over the door and its description on a notice board under it, both written in pixels (pixeltext.js).
// One name and one description, and nothing else written: who works there is in the picture. It draws with
// rect(x, y, w, h, colour) like office.js, which draws the room itself.

import { RES, drawBubble, drawOffice, officeLayout, playScene, themeIndexes } from "./office.js";
import { floorPixels } from "./art.js";
import { LINE_H, drawText, fit, textWidth, wrap } from "./pixeltext.js";

/** The room's sign, on the wall between the window and the whiteboard. */
const SIGN = { x: 34, y: 4, h: 15, edge: 90 };
const LINE_STEP = LINE_H + 1;
const BOARD_LINES = 3;

/** What the room's badge is for each state a project can be in; the others have none. */
const BADGES = { blocked: "blocked", needs_input: "needs", done: "done" };
export const badgeOf = (headline) => BADGES[headline] ?? null;

/**
 * Where things are: the room (office.js's own layout) with the notice board under it, as tall as the lines it holds.
 * `description` is cut to the board; `model` is a model office.js draws.
 */
export function homeLayout(model, description) {
  const room = officeLayout(model);
  const lines = description ? wrap(description, room.width - 14, BOARD_LINES) : [];
  const board = lines.length ? 8 + lines.length * LINE_STEP - 1 : 0;
  return { width: room.width, height: room.height + board, room, lines, board, sign: { x: SIGN.x, y: SIGN.y, w: Math.max(10, room.width - SIGN.edge), h: SIGN.h } };
}

/**
 * The part of a room that does not move: the floor, the walls, the furniture of its theme, the sign and the notice
 * board. A page that redraws the room many times a second draws this once and keeps it.
 */
export function drawHomeBase(ctx, model, text, layout = homeLayout(model, text.description)) {
  drawOffice(ctx, model, 0, undefined, "room");
  // The sign and the board are laid out in office units and drawn RES pixels to a unit (the pixel face too).
  const L = { rect: (x, y, w, h, colour) => ctx.rect(x * RES, y * RES, w * RES, h * RES, colour) };
  const { sign, room } = layout;
  // The sign: a dark plate with the name in it, and a bolt at its start in an autonomous project.
  L.rect(sign.x - 1, sign.y - 1, sign.w + 2, sign.h + 2, "#3d4352");
  L.rect(sign.x, sign.y, sign.w, sign.h, "#0d1220");
  const bolt = text.autonomous ? 8 : 0;
  const name = fit(text.name, sign.w - 6 - bolt);
  const nameX = sign.x + bolt + Math.floor((sign.w - bolt - textWidth(name)) / 2);
  drawText(L, name, nameX, sign.y + 1, "#f2eee8");
  if (text.autonomous) {
    ["...#", "..#.", ".##.", "####", "..#.", ".#..", "#..."].forEach((row, r) => { for (let c = 0; c < 4; c++) if (row[c] === "#") L.rect(sign.x + 3 + c, sign.y + 4 + r, 1, 1, "#f2c04d"); });
  }
  // The notice board.
  if (layout.lines.length) {
    const top = room.height;
    L.rect(0, top, layout.width, layout.board, "#74502e");
    L.rect(2, top + 2, layout.width - 4, layout.board - 4, "#3a2a1e");
    layout.lines.forEach((line, i) => drawText(L, line, 7, top + 5 + i * LINE_STEP, "#efe3c2"));
  }
  return layout;
}

/**
 * What moves in a room: the desks (monitors scrolling, a sheet on its way), the people and what they do, and the
 * badge over the PM's head, unless the PM is saying something. Drawn over drawHomeBase.
 */
export function drawHomeLive(ctx, model, text, t = 0, scene = undefined, layout = homeLayout(model, text.description)) {
  drawOffice(ctx, model, t, scene, "desks");
  drawOffice(ctx, model, t, scene, "people");
  const { room } = layout;
  if (text.badge && !playScene(model, room, scene ?? {}, t).pmSays) drawBubble(ctx, room.pm.x * RES + 60, room.pm.y * RES - 4, text.badge);
}

/** The whole room, with its sign and board: the base and what moves. */
export function drawHome(ctx, model, text, t = 0, scene = undefined, layout = homeLayout(model, text.description)) {
  drawHomeBase(ctx, model, text, layout);
  drawHomeLive(ctx, model, text, t, scene, layout);
  return layout;
}

/**
 * Which theme a project's room has: the one the hub saved for it (`project.theme`), and only if it has none, the one worked out
 * from all the projects. A project that is added never changes the look of the rooms that are there.
 */
export function themeFor(project, all) {
  return project.theme ?? themeIndexes(all.map((p) => p.id)).get(project.id) ?? 0;
}

/** The empty plot where a new project would go, as a card the size of a room: bare earth between stakes, a "+" on a board. */
export const PLOT = { width: 184, scene: 80, board: 22 };
export const plotLayout = () => ({ width: PLOT.width, height: PLOT.scene + PLOT.board });

export function drawPlot(ctx, label) {
  const W = PLOT.width * RES;
  const SCENE = PLOT.scene * RES;
  const L = { rect: (x, y, w, h, colour) => ctx.rect(x * RES, y * RES, w * RES, h * RES, colour) };
  // Sky and a low skyline, then the grass the plot is on.
  const horizon = 22 * RES;
  ["#6aa7d8", "#82b8e2", "#9ac8ea", "#b4d6f0"].forEach((c, i) => ctx.rect(0, Math.floor((horizon * i) / 4), W, Math.ceil(horizon / 4) + 1, c));
  for (let x = 0, k = 0; x < W; k++) {
    const w = 10 + ((k * 7) % 9);
    const h = 8 + ((k * 13) % 22);
    ctx.rect(x, horizon - h, Math.min(w, W - x), h, k % 2 ? "#5f86ad" : "#4f7299");
    x += w + 2;
  }
  floorPixels(ctx, W, SCENE, horizon, "#5b8c4a", "#528242", "grass");
  // The plot: bare earth, a dark edge, and a stake at each corner with a rope between them.
  const px = 30 * RES, py = 32 * RES, pw = W - 60 * RES, ph = 38 * RES;
  ctx.rect(px - 2, py - 2, pw + 4, ph + 4, "#6b4a2a");
  ctx.rect(px, py, pw, ph, "#b8956a");
  for (let i = 0; i < 26; i++) ctx.rect(px + 6 + ((i * 37) % (pw - 14)), py + 4 + ((i * 53) % (ph - 10)), 3, 2, i % 2 ? "#a78252" : "#c9a97c");
  for (const [sx, sy] of [[px - 4, py - 6], [px + pw - 2, py - 6], [px - 4, py + ph - 8], [px + pw - 2, py + ph - 8]]) {
    ctx.rect(sx, sy, 6, 14, "#4a2f18");
    ctx.rect(sx + 1, sy, 4, 3, "#8a5a2e");
  }
  for (let x = px + 6; x < px + pw - 4; x += 6) { ctx.rect(x, py - 4, 3, 1, "#e8d9b0"); ctx.rect(x, py + ph - 2, 3, 1, "#e8d9b0"); }
  // A big plus on the earth, in the colour of the Create button, and a shovel in the ground.
  const cx = Math.floor(W / 2), cy = py + Math.floor(ph / 2);
  ctx.rect(cx - 15, cy - 4, 30, 8, "#2a2013");
  ctx.rect(cx - 4, cy - 15, 8, 30, "#2a2013");
  ctx.rect(cx - 13, cy - 2, 26, 4, "#f2c04d");
  ctx.rect(cx - 2, cy - 13, 4, 26, "#f2c04d");
  ctx.rect(cx - 13, cy - 2, 26, 1, "#ffe08a");
  ctx.rect(px + pw - 22, py + 6, 3, 22, "#8a5a2e");
  ctx.rect(px + pw - 26, py + 26, 11, 8, "#aab3be");
  ctx.rect(px + pw - 26, py + 26, 11, 2, "#dfe5ec");
  // A few flowers outside the stakes.
  for (const [fx, fy, c] of [[10, 52, "#e05a4f"], [18, 62, "#f2c04d"], [W / RES - 12, 56, "#c04fb0"], [W / RES - 22, 66, "#f2eee8"]]) {
    L.rect(fx, fy, 1, 4, "#2f6e3c");
    L.rect(fx - 1, fy - 2, 3, 3, c);
  }
  // The board under the scene, like the notice board of a room, with the label in pixels.
  const top = SCENE;
  ctx.rect(0, top, W, PLOT.board * RES, "#74502e");
  ctx.rect(4, top + 4, W - 8, PLOT.board * RES - 8, "#3a2a1e");
  const text = fit(label, PLOT.width - 16);
  drawText(L, text, Math.floor((PLOT.width - textWidth(text)) / 2), PLOT.scene + 6, "#efe3c2");
}
