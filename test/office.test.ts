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
import { drawOffice, officeLayout, officeModel, playScene, plateText } from "../src/web/public/office.js";
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
  const near = (w: { x: number; y: number }) => Math.abs(w.x - (seat.x + 24)) + Math.abs(w.y - (seat.y + 24)) <= 3;
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
      ok(x >= 0 && y >= 0 && x < b.width + bleed * 2 && y < b.height + bleed * 2, `${layer} ${key}`);
    }
  };
  for (const layer of ["bg", "rooms", "desks", "people"] as const) inside(layer);
  ok(buildingBusy(b, 700, new Map([["a", { visits: [{ agent: "a-a0", kind: "command" as const, at: 0 }] }]])), "an agent walking is something moving");
  ok(!buildingBusy(b, 700, new Map()), "a quiet building is not");
  ok(DEPTH.bg < DEPTH.rooms && DEPTH.rooms < DEPTH.desks && DEPTH.desks < DEPTH.people, "the nearer the layer, the further it moves");
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
