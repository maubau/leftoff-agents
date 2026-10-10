// A project's room as the Home shows it: the office of that project, furnished as its theme says, with its name
// on the sign over the door and its description on a notice board under it, both written in pixels (pixeltext.js).
// One name and one description, and nothing else written: who works there is in the picture. It draws with
// rect(x, y, w, h, colour) like office.js, which draws the room itself.

import { RES, drawBubble, drawOffice, officeLayout, playScene } from "./office.js";
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
