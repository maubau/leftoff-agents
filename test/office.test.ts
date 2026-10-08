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
import { drawOffice, officeLayout, officeModel, plateText } from "../src/web/public/office.js";
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
