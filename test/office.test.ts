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
