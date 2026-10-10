import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { beforeEach, test } from "node:test";
import type { IncomingMessage, OutgoingImage } from "../src/channels/channel.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { report } from "../src/commands/report.ts";
import { ConfigSchema } from "../src/core/config.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { officePng } from "../src/office/render.ts";
import { RES, THEMES, drawOffice, officeLayout, officeModel, playScene, plateText, themeIndexes } from "../src/web/public/office.js";
import { badgeOf, drawHome, homeLayout } from "../src/web/public/home.js";
import { ellipse, headPixels, lookOf, shade, standingPixels } from "../src/web/public/art.js";
import { LINE_H, drawText, fit, textWidth, wrap } from "../src/web/public/pixeltext.js";
import { BLEED, DEPTH, GAP, MARGIN, TOP, buildingBusy, buildingLayout, drawBuilding } from "../src/web/public/building.js";
import type { OfficeScene } from "../src/web/public/office.d.ts";
import { isolateHost, tempProject } from "./helpers.ts";

beforeEach(async () => {
  await isolateHost("leftoff-office-");
});

const base = { done: [], doing: [], blocked: [], next: [], option: [] };

test("each agent's state in the office follows the facts: working beats the last report, then what it waits for", () => {
  const model = officeModel({
    agents: [
      { id: "a", live: "running", status: "blocked" },
      { id: "b", live: "idle", status: "blocked" },
      { id: "c", live: "idle", status: "needs_input" },
      { id: "d", live: "idle", status: "progress", awaiting: true },
      { id: "e", live: "unknown", status: "done" },
      { id: "f", live: "closed", status: "none" },
    ],
    handoffs: [{ from: "c", to: "a" }, { from: "c", to: "nobody" }],
  });
  deepStrictEqual(model.agents.map((x) => x.state), ["working", "blocked", "needs", "awaiting", "done", "idle"]);
  strictEqual(model.handoffs.length, 1, "a handoff to someone not in the office is not drawn");
});

test("desk plates are plain upper-case ASCII, short enough for the desk", () => {
  strictEqual(plateText("main-dev"), "MAIN-DEV");
  strictEqual(plateText("Ünïcödé agent with a long name"), "UNICODE AGEN");
});

test("the office grows with the team: three desks a row at least, four at most, the PM at the head", () => {
  const of = (n: number) => officeLayout(officeModel({ agents: Array.from({ length: n }, (_, i) => ({ id: `a${i}` })) }));
  deepStrictEqual([of(1).cols, of(3).cols, of(4).cols, of(9).cols], [3, 3, 4, 4]);
  ok(of(9).height > of(4).height);
  const layout = of(2);
  ok(layout.stations.every((s) => s.y > layout.pm.y), "everyone sits below the PM");
  let drawn = 0;
  drawOffice({ rect: () => void drawn++ }, officeModel({ agents: [{ id: "a", live: "running" }] }), 1234);
  ok(drawn > 200, "something was drawn");
});

test("the still is a real PNG of the scaled office", () => {
  const model = officeModel({ agents: [{ id: "main-dev", face: "🛠️", live: "running" }, { id: "ux", face: "🎨", status: "needs_input" }], handoffs: [{ from: "ux", to: "main-dev" }] });
  const png = officePng(model, 2);
  deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset);
  const { width, height } = officeLayout(model);
  deepStrictEqual([view.getUint32(16), view.getUint32(20)], [width * 2, height * 2]);
  const idatAt = Buffer.from(png).indexOf("IDAT");
  const length = view.getUint32(idatAt - 4);
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length));
  strictEqual(raw.length, height * 2 * (width * 2 * 4 + 1), "every row is there, filter byte included");
});

const team = officeModel({ agents: [{ id: "main-dev", face: "🛠️", live: "running" }, { id: "ux", face: "🎨" }, { id: "review", face: "🧪" }] });
const calls = (scene?: OfficeScene, t = 700) => {
  const out: string[] = [];
  drawOffice({ rect: (...a) => void out.push(a.join(",")) }, team, t, scene);
  return out;
};
/** Walk through a scene in 30 ms frames and keep what the walkers did. */
const frames = (scene: OfficeScene, until = 20_000) => {
  const layout = officeLayout(team);
  const out: Array<ReturnType<typeof playScene> & { t: number }> = [];
  for (let t = 0; t <= until; t += 30) out.push({ ...playScene(team, layout, scene, t), t });
  return out;
};

test("a scene is an addition: without one, or with an empty one, the office is drawn exactly as before", () => {
  deepStrictEqual(calls({}, 0), calls(undefined, 0));
  ok(calls({ pm: "typing" }).join() !== calls().join(), "the PM at its screen looks different");
  ok(calls({ pm: "phone" }).join() !== calls({ pm: "typing" }).join(), "and with a phone, different again");
});

test("an agent visiting the PM gets up, walks without jumping, speaks, and sits down where it was", () => {
  const run = frames({ visits: [{ agent: "review", kind: "command", at: 1000 }] });
  const walking = run.filter((f) => f.walkers.length);
  ok(walking.length > 50, "it is on its feet for a while");
  ok(run.filter((f) => f.t < 1000).every((f) => !f.walkers.length), "nobody moves before the visit");
  // Never more than a couple of pixels between two frames: a walk, not a teleport.
  const path = walking.filter((f) => f.walkers[0]!.say === undefined).map((f) => f.walkers[0]!);
  for (let i = 1; i < path.length; i++) ok(Math.abs(path[i]!.x - path[i - 1]!.x) + Math.abs(path[i]!.y - path[i - 1]!.y) <= 3, `step ${i}`);
  const layout = officeLayout(team);
  const seat = layout.stations.find((s) => s.agent.id === "review")!;
  const near = (w: { x: number; y: number }) => Math.abs(w.x - (seat.x + 24)) + Math.abs(w.y - (seat.y + 28)) <= 3;
  ok(near(path[0]!), "it starts from its chair");
  ok(near(path.at(-1)!), "and ends in it");
  const order = run.filter((f) => f.pmSays || f.walkers[0]?.say).map((f) => (f.pmSays ? "pm" : "agent"));
  strictEqual([...new Set(order)].join(), "pm,agent", "the PM speaks, then the agent answers");
  const there = run.find((f) => f.pmSays)!.walkers[0]!;
  deepStrictEqual([there.x, there.y], [layout.pm.x, layout.pm.y + 34], "the exchange happens at the PM's side");
  strictEqual(run.at(-1)!.busy, false, "and then the office is calm again");
});

test("visits queue up: two agents are never at the PM's side together", () => {
  const run = frames({ visits: [{ agent: "ux", kind: "status", at: 0 }, { agent: "review", kind: "handoff", at: 100 }] }, 30_000);
  ok(run.every((f) => f.walkers.length <= 1));
  const who = new Set(run.flatMap((f) => f.walkers.map((w) => w.agent)));
  deepStrictEqual([...who].sort(), ["review", "ux"]);
  ok(playScene(team, officeLayout(team), { visits: [{ agent: "nobody", kind: "status", at: 0 }] }, 10).busy === false, "an agent that is not in the office is not drawn");
});

test("with reduced motion nobody walks or types: the two sides only speak, in turn, from their seats", () => {
  const run = frames({ pm: "typing", visits: [{ agent: "ux", kind: "status", at: 0 }], reduced: true });
  ok(run.every((f) => f.walkers.length === 0));
  const turns = run.filter((f) => f.pmSays || f.speaking.size).map((f) => (f.pmSays ? "pm" : "ux"));
  strictEqual([...new Set(turns)].join(), "pm,ux");
  deepStrictEqual(calls({ pm: "typing", reduced: true }, 100), calls({ pm: "typing", reduced: true }, 9000), "nothing on the desks moves with the clock");
});

test("in reduced motion the office is the same picture whatever the time, handoff sheets and working desks included", () => {
  const busy = officeModel({
    agents: [{ id: "main-dev", face: "🛠️", live: "running" }, { id: "ux", face: "🎨", status: "idle" }, { id: "review", face: "🧪", status: "idle" }],
    handoffs: [{ from: "ux", to: "main-dev" }, { from: "review", to: "main-dev" }],
  });
  const at = (scene: OfficeScene | undefined, t: number) => {
    const out: string[] = [];
    drawOffice({ rect: (...a) => void out.push(a.join(",")) }, busy, t, scene);
    return out;
  };
  for (const scene of [{ reduced: true }, { pm: "typing" as const, reduced: true }, { pm: "phone" as const, reduced: true }]) {
    deepStrictEqual(at(scene, 100), at(scene, 100 + 1700), JSON.stringify(scene));
  }
  ok(at(undefined, 100).join() !== at(undefined, 2300).join(), "while without reduced motion the sheets do travel");
});

test("with captions the office leaves room under each desk for a name and role, and without them nothing changes", () => {
  const agents = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, face: "🛠️" }));
  const plain = officeLayout(officeModel({ agents }));
  const captioned = officeLayout({ ...officeModel({ agents }), captions: true });
  deepStrictEqual(plain.captions, [], "the picture sent to chat has none");
  strictEqual(captioned.width, plain.width);
  ok(captioned.height > plain.height, "the room grows");
  strictEqual(captioned.captions.length, 5);
  captioned.captions.forEach((c, i) => {
    const desk = captioned.stations[i]!;
    ok(c.y >= desk.y + 36, "under the desk, not over it");
    ok(c.x >= desk.x && c.x + c.w <= desk.x + 56, "inside its own column");
    const next = captioned.stations.find((s) => s.y > desk.y);
    if (next) ok(c.y + c.h <= next.y, "above the row below, whose bubbles are at its top");
    ok(c.y + c.h <= captioned.height, "inside the room");
  });
  // The PM's side of the room is the same, so the visit route still ends at its desk.
  deepStrictEqual(captioned.pm, plain.pm);
  const team = officeModel({ agents });
  const run = Array.from({ length: 700 }, (_, k) => playScene({ ...team, captions: true }, captioned, { visits: [{ agent: "a4", kind: "status", at: 0 }] }, k * 30)).filter((f) => f.pmSays);
  ok(run.length > 0 && run[0]!.walkers[0]!.x === captioned.pm.x && run[0]!.walkers[0]!.y === captioned.pm.y + 34, "a visit from the second row still reaches the PM");
});

/** What a drawing leaves on a canvas: the last colour written to each pixel. */
const pixels = (paint: (ctx: { rect: (x: number, y: number, w: number, h: number, c: string) => void }) => void) => {
  const out = new Map<string, string>();
  paint({ rect: (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.set(`${x + i},${y + j}`, c); } });
  return out;
};

test("drawn layer by layer, from the back to the front, the office is the same picture", () => {
  const model = officeModel({
    agents: [{ id: "main-dev", face: "🛠️", live: "running" }, { id: "ux", face: "🎨", status: "needs_input" }, { id: "rv", face: "🧪", awaiting: true }],
    handoffs: [{ from: "ux", to: "main-dev" }],
    counts: { todo: 2, doing: 1, blocked: 1, done: 3 },
  });
  for (const [t, scene] of [[0, undefined], [900, { pm: "phone" as const }], [2600, { visits: [{ agent: "rv", kind: "command" as const, at: 0 }] }]] as const) {
    const whole = pixels((ctx) => drawOffice(ctx, model, t, scene));
    const layered = pixels((ctx) => { for (const layer of ["room", "desks", "people"] as const) drawOffice(ctx, model, t, scene, layer); });
    deepStrictEqual([...layered].sort(), [...whole].sort(), `t=${t}`);
  }
});

test("a room with the lights off is only the PM's row, with nobody at the PM's desk", () => {
  const off = officeModel({ agents: [] });
  const lit = officeLayout(off);
  const dark = officeLayout({ ...off, off: true });
  ok(dark.height < lit.height, "no row of desks");
  deepStrictEqual(dark.stations, []);
  const at = (model: typeof off, scene?: OfficeScene) => pixels((ctx) => drawOffice(ctx, model, 500, scene));
  ok(at({ ...off, off: true }).get("0,24") !== at(off).get("0,24"), "the floor is darker");
  deepStrictEqual([...at({ ...off, off: true }, { pm: "phone" })].sort(), [...at({ ...off, off: true })].sort(), "whatever the PM is told, the empty room stays as it is");
});

const room = (id: string, agents: number, extra: Record<string, unknown> = {}) => ({
  id, name: id, model: { ...officeModel({ agents: Array.from({ length: agents }, (_, i) => ({ id: `${id}-a${i}` })) }), captions: true, ...extra },
});

test("the building puts a room per project in rows that fit, and keeps them apart", () => {
  const rooms = [room("a", 2), room("b", 3), room("c", 1), room("d", 0, { off: true }), room("e", 4)];
  const wide = buildingLayout(rooms, 1000);
  const narrow = buildingLayout(rooms, 100);
  strictEqual(wide.rooms.length, 5, "one room for each project, even the empty one");
  for (const b of [wide, narrow]) {
    for (const r of b.rooms) {
      ok(r.x >= MARGIN && r.y >= TOP && r.x + r.layout.width <= b.width - MARGIN && r.y + r.layout.height <= b.height - MARGIN, `${r.id} is inside`);
      deepStrictEqual([r.x, r.y].map(Number.isInteger), [true, true], "on whole pixels");
    }
    for (const [i, p] of b.rooms.entries()) for (const q of b.rooms.slice(i + 1)) {
      const apart = p.x + p.layout.width + GAP <= q.x || q.x + q.layout.width + GAP <= p.x || p.y + p.layout.height + GAP <= q.y || q.y + q.layout.height + GAP <= p.y;
      ok(apart, `${p.id} and ${q.id} do not touch`);
    }
  }
  ok(wide.rooms.some((r) => r.y === TOP && r.x > MARGIN), "wide: rooms share a row");
  deepStrictEqual([...new Set(narrow.rooms.map((r) => r.y))].length, 5, "narrow, as on a phone: one room to a row");
  ok(wide.height < narrow.height, "so the narrow building is taller");
  const dark = wide.rooms.find((r) => r.id === "d")!;
  const lit = wide.rooms.find((r) => r.id === "a")!;
  ok(dark.layout.height < lit.layout.height, "the room with the lights off is small");
  // The sign is on the wall, the captions under their desks, both in the building's own coordinates.
  ok(lit.sign.x >= lit.x && lit.sign.x + lit.sign.w <= lit.x + lit.layout.width && lit.sign.y + lit.sign.h <= lit.y + 24, "the sign is on the wall");
  strictEqual(lit.captions.length, 2);
  ok(lit.captions.every((c) => c.x >= lit.x && c.y > lit.y + 36 && c.y + c.h <= lit.y + lit.layout.height), "each caption is under its desk, in the room");
});

test("each layer of the building draws inside its canvas, and together they show the rooms and who is in them", () => {
  const b = buildingLayout([room("a", 2), room("b", 1)], 1000);
  const inside = (layer: "bg" | "rooms" | "desks" | "people") => {
    const bleed = layer === "bg" ? BLEED : 0;
    const drawn = pixels((ctx) => drawBuilding(ctx, b, layer, 700, new Map([["a", { pm: "typing" as const, visits: [{ agent: "a-a1", kind: "status" as const, at: 0 }] }]])));
    ok(drawn.size > 0, `${layer} draws something`);
    for (const key of drawn.keys()) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      ok(x >= 0 && y >= 0 && x < (b.width + bleed * 2) * RES && y < (b.height + bleed * 2) * RES, `${layer} ${key}`);
    }
  };
  for (const layer of ["bg", "rooms", "desks", "people"] as const) inside(layer);
  ok(buildingBusy(b, 700, new Map([["a", { visits: [{ agent: "a-a0", kind: "command" as const, at: 0 }] }]])), "an agent walking is something moving");
  ok(!buildingBusy(b, 700, new Map()), "a quiet building is not");
  ok(DEPTH.bg < DEPTH.rooms && DEPTH.rooms < DEPTH.desks && DEPTH.desks < DEPTH.people, "the nearer the layer, the further it moves");
});

test("the pixel face writes every letter, digit and accent the panel's languages use, inside its line", () => {
  const sample = "Aa Bb Cc Dd Ee Ff Gg Hh Ii Jj Kk Ll Mm Nn Oo Pp Qq Rr Ss Tt Uu Vv Ww Xx Yy Zz 0123456789 .,:;!?'\"()/-_+&#%@*=<> àèéìòù äöüß ñç âêîôû ÀÈÉÌÒÙ ÄÖÜ Ñ Ç «x» “y” ’ – — …";
  const drawn = pixels((ctx) => drawText(ctx, sample, 0, 0, "#fff"));
  for (const key of drawn.keys()) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    ok(y >= 0 && y < LINE_H && x >= 0 && x < textWidth(sample) + 2, `inside its line: ${key}`);
  }
  const plain = pixels((ctx) => drawText(ctx, "e", 0, 0, "#fff"));
  const acute = pixels((ctx) => drawText(ctx, "é", 0, 0, "#fff"));
  ok(acute.size > plain.size, "an accent adds pixels");
  ok(![...acute.keys()].some((k) => Number(k.split(",")[1]) < 1), "over a small letter, below the first row");
  const dotted = pixels((ctx) => drawText(ctx, "i", 0, 0, "#fff"));
  const diaeresis = pixels((ctx) => drawText(ctx, "ï", 0, 0, "#fff"));
  ok(dotted.has("1,1") && !diaeresis.has("1,1"), "an accented i loses its dot");
  strictEqual(textWidth("ß"), textWidth("ss"), "ß is said as ss");
  const scaled = pixels((ctx) => drawText(ctx, "Hi", 0, 0, "#fff", { scale: 2 }));
  strictEqual(Math.max(...[...scaled.keys()].map((k) => Number(k.split(",")[1]))), 15, "twice the size");
});

test("text is cut to what fits: a name to one line, a description to a few, each ending in dots when cut", () => {
  strictEqual(fit("Clipforge", 100), "Clipforge");
  const cut = fit("Harbor Guesthouse and the rest of its name", 60);
  ok(cut.endsWith("...") && textWidth(cut) <= 60, cut);
  const lines = wrap("Interactive map of robotics companies (Europe, USA, China), with submissions and moderation, and then some more words", 120, 3);
  strictEqual(lines.length, 3);
  ok(lines.every((l) => textWidth(l) <= 120), "every line fits");
  ok(lines.at(-1)!.endsWith("..."), "the last says it was cut");
  deepStrictEqual(wrap("Short one", 120, 3), ["Short one"]);
  deepStrictEqual(wrap("", 120, 3), []);
  ok(wrap("Averyveryveryverylongwordthatwillnotfitonaline x", 60, 2).every((l) => textWidth(l) <= 60), "a long word is cut, not left to overflow");
});

test("each project's room is furnished differently, the same way every time", () => {
  strictEqual(new Set(THEMES.map((t) => t.name)).size, THEMES.length);
  ok(THEMES.length >= 8);
  const ids = ["atlas", "clipforge", "ledger", "storefront", "harbor", "orchard", "x", "y"];
  const mine = themeIndexes(ids);
  strictEqual(new Set(ids.map((id) => mine.get(id))).size, ids.length, "up to as many projects as there are themes, no two alike");
  deepStrictEqual([...themeIndexes([...ids].reverse())].sort(), [...mine].sort(), "whatever the order they are listed in");
  ok(themeIndexes(Array.from({ length: 12 }, (_, i) => `p${i}`)).size === 12, "more projects than themes still each get one");
  const model = officeModel({ agents: [{ id: "a", face: "🛠️" }] });
  const rooms = THEMES.map((_, theme) => [...pixels((ctx) => drawOffice(ctx, { ...model, theme }, 0, undefined, "room"))].sort().join());
  strictEqual(new Set(rooms).size, THEMES.length, "no two themes draw the same room");
  ok(rooms.every((r) => r !== [...pixels((ctx) => drawOffice(ctx, model, 0, undefined, "room"))].sort().join()), "and none is the plain office");
  const dark = pixels((ctx) => drawOffice(ctx, { ...officeModel({ agents: [] }), off: true, theme: 3 }, 0));
  ok(![...dark.values()].includes("#5b8c4a"), "a room with the lights off keeps its theme's colours out of it");
});

test("a room on the Home has one name on its sign and one description on its board", () => {
  const model = { ...officeModel({ agents: [{ id: "a", face: "🛠️", live: "running" }, { id: "b" }] }), theme: 1 };
  const short = homeLayout(model, "");
  const long = homeLayout(model, "Interactive map of robotics companies (Europe, USA, China), with submissions and moderation");
  strictEqual(short.board, 0, "no description, no board");
  strictEqual(short.height, short.room.height);
  strictEqual(long.lines.length, 3);
  ok(long.height > short.height && long.board === long.height - long.room.height);
  // The sign is on the wall, between the window and the whiteboard.
  ok(long.sign.x >= 30 && long.sign.x + long.sign.w <= long.room.width - 52 && long.sign.y + long.sign.h <= 24, JSON.stringify(long.sign));
  const text = { name: "Clipforge", description: "Guided video editing", badge: null, autonomous: false };
  const drawn = pixels((ctx) => drawHome(ctx, model, text, 0));
  const bounds = homeLayout(model, text.description);
  for (const key of drawn.keys()) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    ok(x >= 0 && y >= 0 && x < bounds.width * RES && y < bounds.height * RES, `inside the card: ${key}`);
  }
  const ink = (box: { x: number; y: number; w: number; h: number }) => [...drawn].filter(([k, c]) => c === "#f2eee8" && (([x, y]) => x >= box.x * RES && x < (box.x + box.w) * RES && y >= box.y * RES && y < (box.y + box.h) * RES)(k.split(",").map(Number) as [number, number])).length;
  ok(ink(bounds.sign) > 30, "the name is written on the sign");
  ok([...drawn].filter(([, c]) => c === "#efe3c2").length > 30, "the description is written on the board");
  // The badge is over the PM's head, unless the PM is talking.
  const badge = { ...text, badge: badgeOf("needs_input") };
  const withBadge = pixels((ctx) => drawHome(ctx, model, badge, 0));
  ok([...withBadge].sort().join() !== [...drawn].sort().join(), "a project that needs you shows it");
  const talking = { visits: [{ agent: "a", kind: "status" as const, at: -300 }], reduced: true }; // the PM speaks first, from its desk
  deepStrictEqual([...pixels((ctx) => drawHome(ctx, model, badge, 0, talking))].sort(), [...pixels((ctx) => drawHome(ctx, model, text, 0, talking))].sort(), "but not over a PM who is saying something");
  strictEqual(badgeOf("progress"), null);
  strictEqual(badgeOf("blocked"), "blocked");
});

test("the drawing is RES pixels to a unit of the layout, and nothing is drawn outside it", () => {
  const model = officeModel({ agents: [{ id: "a", face: "🛠️", live: "running" }, { id: "b", face: "🎨" }, { id: "c" }, { id: "d" }], handoffs: [{ from: "a", to: "d" }] });
  const layout = officeLayout(model);
  for (const scene of [undefined, { pm: "phone" as const }, { pm: "typing" as const, visits: [{ agent: "c", kind: "status" as const, at: -2200 }] }]) {
    for (const key of pixels((ctx) => drawOffice(ctx, { ...model, theme: 7 }, 900, scene)).keys()) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      ok(x >= 0 && y >= 0 && x < layout.width * RES && y < layout.height * RES, `${JSON.stringify(scene)} ${key}`);
    }
  }
});

test("people are drawn as people: the same agent the same way, different agents differently, standing as tall as the seat says", () => {
  const looks = Array.from({ length: 24 }, (_, i) => lookOf(i * 2654435761 >>> 0, "#3d6fd8"));
  ok(new Set(looks.map((l) => l.style)).size >= 4, "several hair styles");
  ok(new Set(looks.map((l) => l.skin)).size >= 3, "several skins");
  ok(looks.some((l) => l.glasses) && looks.some((l) => !l.glasses), "glasses on some");
  deepStrictEqual(lookOf(12345, "#fff"), lookOf(12345, "#fff"));
  const heads = looks.map((l) => [...pixels((ctx) => headPixels(ctx, 0, 0, l))].sort().join());
  ok(new Set(heads).size >= 8, "heads that differ");
  // A standing person's head is where a seated one's is: it gets up from its chair, it does not jump.
  const stand = pixels((ctx) => standingPixels(ctx, 48, 56, looks[0]!, 0));
  const top = Math.min(...[...stand.keys()].map((k) => Number(k.split(",")[1])));
  ok(top >= 11 && top <= 13, `its head starts at ${top}, a seated head at 12`);
  strictEqual(shade("#808080", 1), "#ffffff");
  strictEqual(shade("#808080", -1), "#000000");
  const disc = pixels((ctx) => ellipse(ctx, 10, 10, 5, 5, "#fff"));
  ok(disc.has("10,10") && !disc.has("5,5") && disc.size > 60 && disc.size < 90, "a round shape");
});

test("/office answers with the picture and says who is who under it, in the owner's language", async () => {
  const p = await tempProject({
    id: "harbor",
    name: "Harbor",
    agents: [
      { id: "main-dev", control: "inbox", host: "claude-code", label: "Harbor Main Dev", role: "backend; merges" },
      { id: "ux", control: "inbox", host: "claude-code", label: "Harbor UX", role: "frontend and UX" },
    ],
  });
  await registerProject("harbor", p.root);
  await report(p, { ...base, agent: "ux", status: "needs_input", question: "Which calendar?", option: ["iCal", "API"] });
  const hub = new Hub({ config: ConfigSchema.parse({ language: "it", timezone: "Europe/Rome", limits: { enabled: false } }), channel: new ConsoleChannel(), exec: async () => ({ stdout: "[]" }), log: () => undefined });
  const images: OutgoingImage[] = [];
  const replies: string[] = [];
  const message = (text: string, withImages: boolean): IncomingMessage => ({
    text,
    projectId: "harbor",
    threadKey: "t",
    reply: async (r) => void replies.push(r),
    ...(withImages ? { replyImage: async (image: OutgoingImage) => void images.push(image) } : {}),
    typing: async () => undefined,
  });
  await hub.handle(message("/ufficio", true));
  strictEqual(images.length, 1);
  deepStrictEqual([...images[0]!.bytes.subarray(1, 4)], [80, 78, 71]);
  match(images[0]!.caption, /🏢 Harbor — l'ufficio/);
  match(images[0]!.caption, /🎨 Harbor UX — ha bisogno di te/);
  match(images[0]!.caption, /🛠️ Harbor Main Dev — fermo/);

  await hub.handle(message("/office", false));
  match(replies.at(-1)!, /🎨 Harbor UX — ha bisogno di te/, "where pictures cannot go, the words alone");
});
