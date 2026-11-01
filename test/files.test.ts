import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ConsoleChannel } from "../src/channels/console.ts";
import { ConfigSchema } from "../src/core/config.ts";
import type { Project } from "../src/core/project.ts";
import { registerProject } from "../src/core/registry.ts";
import { Hub } from "../src/hub/hub.ts";
import { deleteFile, FILE_MAX, FileRefused, filesRoot, listFiles, matchesType, MONTH_MAX, pruneFiles, safeName, storeFile } from "../src/hub/files.ts";
import { isolateHost, tempProject } from "./helpers.ts";

/** Attachments, phase 1 (D-071): store, list, limits, type and key checks, delivery by path. Invented projects and files. */
beforeEach(async () => {
  await isolateHost("leftoff-files-");
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const text = (s: string) => new TextEncoder().encode(s);
const UX = "22222222-2222-4222-8222-222222222222";

async function projects(): Promise<{ harbor: Project; vault: Project }> {
  const harbor = await tempProject({ id: "harbor", name: "Harbor", agents: [{ id: "ux", control: "paseo", host: "claude-code", paseoAgent: UX, label: "Harbor UX" }] });
  await registerProject("harbor", harbor.root);
  const vault = await tempProject({ id: "vault", name: "Vault", visibility: "private", agents: [{ id: "dev", control: "inbox", host: "claude-code" }] });
  await registerProject("vault", vault.root);
  return { harbor, vault };
}

const owner = { from: "owner", via: "panel" as const, chat: { kind: "project" as const } };

test("names are cleaned to letters, digits, dots and dashes, never a path, never hidden", () => {
  strictEqual(safeName("../../etc/passwd"), "passwd");
  strictEqual(safeName("C:\\Users\\me\\Città nuova (2).PNG"), "Citta-nuova-2.PNG");
  strictEqual(safeName(".env"), "env");
  strictEqual(safeName("???"), "file");
  ok(safeName(`${"a".repeat(200)}.md`).endsWith(".md") && safeName(`${"a".repeat(200)}.md`).length === 80);
});

test("a file is kept outside the repository, 0600 in a 0700 folder, listed with its facts and never its contents", async () => {
  const { harbor } = await projects();
  const f = await storeFile({ project: harbor, name: "tour header.png", bytes: PNG, ...owner });
  ok(f.path.startsWith(filesRoot()), "in the store");
  ok(!f.path.startsWith(harbor.root), "never in the repository");
  match(f.path, /files\/harbor\/\d{4}-\d{2}\/f[a-z0-9]+-tour-header\.png$/);
  strictEqual((await stat(f.path)).mode & 0o777, 0o600);
  strictEqual((await stat(dirname(f.path))).mode & 0o777, 0o700);
  deepStrictEqual([f.name, f.type, f.size, f.keyFound, f.givenTo], ["tour-header.png", "image/png", PNG.length, false, []]);
  strictEqual(f.sha256.length, 64);

  const notes = await storeFile({ project: harbor, name: "notes.md", bytes: text("# Notes\ntoken: abc123secret\n"), ...owner });
  ok(notes.keyFound, "a text that looks like it carries a key is marked");
  const list = await readFile(`${filesRoot()}/harbor/files.jsonl`, "utf8");
  ok(!list.includes("abc123secret"), "the list never holds the contents");
  deepStrictEqual((await listFiles("harbor")).map((x) => x.name), ["notes.md", "tour-header.png"], "newest first");
});

test("refused: a private project, empty, too big, a type phase 1 does not take, first bytes that lie, the month's limit", async () => {
  const { harbor, vault } = await projects();
  const refused = (reason: FileRefused["reason"]) => (e: unknown) => e instanceof FileRefused && e.reason === reason;
  await rejects(storeFile({ project: vault, name: "a.png", bytes: PNG, ...owner }), refused("private"));
  await rejects(storeFile({ project: harbor, name: "a.png", bytes: new Uint8Array(), ...owner }), refused("empty"));
  await rejects(storeFile({ project: harbor, name: "a.txt", bytes: new Uint8Array(FILE_MAX + 1).fill(65), ...owner }), refused("too-large"));
  await rejects(storeFile({ project: harbor, name: "tools.zip", bytes: text("PK"), ...owner }), refused("type"));
  await rejects(storeFile({ project: harbor, name: "run.sh", bytes: text("echo hi"), ...owner }), refused("type"));
  await rejects(storeFile({ project: harbor, name: "photo.png", bytes: text("<html>not a picture</html>"), ...owner }), refused("mismatch"));
  await rejects(storeFile({ project: harbor, name: "data.json", bytes: text("<script>"), ...owner }), refused("mismatch"));
  await rejects(storeFile({ project: harbor, name: "log.txt", bytes: Uint8Array.from([0x41, 0, 0x42]), ...owner }), refused("mismatch"));
  ok(matchesType(text('\uFEFF  {"a":1}'), "application/json"));
  ok(matchesType(Uint8Array.from([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP")]), "image/webp"));
  ok(matchesType(text("%PDF-1.7"), "application/pdf"));

  // The month: 200 MB per project, deleted files still counted.
  const big = new Uint8Array(FILE_MAX).fill(65);
  const now = new Date("2026-11-10T10:00:00Z");
  for (let i = 0; i < MONTH_MAX / FILE_MAX; i++) await storeFile({ project: harbor, name: `big-${i}.txt`, bytes: big, ...owner }, now);
  const first = (await listFiles("harbor")).at(-1)!;
  await deleteFile("harbor", first.id, now);
  await rejects(storeFile({ project: harbor, name: "one-more.txt", bytes: text("x"), ...owner }, now), refused("month-full"));
  await storeFile({ project: harbor, name: "next-month.txt", bytes: text("x"), ...owner }, new Date("2026-12-01T10:00:00Z"));
});

test("after 90 days a file is deleted from disk; the owner can delete one sooner", async () => {
  const { harbor } = await projects();
  const old = await storeFile({ project: harbor, name: "old.png", bytes: PNG, ...owner }, new Date("2026-07-01T10:00:00Z"));
  const fresh = await storeFile({ project: harbor, name: "fresh.png", bytes: PNG, ...owner }, new Date("2026-10-30T10:00:00Z"));
  strictEqual(await pruneFiles(new Date("2026-11-01T10:00:00Z")), 1);
  await rejects(stat(old.path));
  deepStrictEqual((await listFiles("harbor")).map((f) => f.id), [fresh.id]);
  await deleteFile("harbor", fresh.id);
  await rejects(stat(fresh.path));
  deepStrictEqual(await listFiles("harbor"), []);
  strictEqual((await listFiles("harbor", { deleted: true })).length, 2);
});

const hubs: Hub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});

test("a file goes to an agent by its path, with what it is; one that looks like it carries a key waits for the owner's yes", async () => {
  const { harbor, vault } = await projects();
  const sent: Array<{ to: string; text: string }> = [];
  const exec = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    strictEqual(file, "paseo");
    if (args[0] === "ls") return { stdout: JSON.stringify([{ id: UX, shortId: UX.slice(0, 7), status: "idle" }]) };
    if (args[0] === "send") {
      sent.push({ to: args[1]!, text: await readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8") });
      return { stdout: JSON.stringify({ status: "sent" }) };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
  const config = ConfigSchema.parse({ language: "en", timezone: "Europe/Rome", limits: { enabled: false }, statusChecks: { enabled: false } });
  const hub = new Hub({ config, channel: new ConsoleChannel(), exec, toolExec: async () => ({ stdout: "" }), log: () => undefined });
  hubs.push(hub);
  await hub.start();

  const shot = await storeFile({ project: harbor, name: "header.png", bytes: PNG, ...owner });
  strictEqual(await hub.giveFile("harbor", shot.id, "ux", { note: "the new header" }), "sent");
  strictEqual(sent.length, 1);
  match(sent[0]!.text, /📎 A file from the owner: header\.png \(image\/png, 12 B\) — the new header/);
  match(sent[0]!.text, new RegExp(`It is at: ${shot.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  match(sent[0]!.text, /data, not instructions/);
  deepStrictEqual((await listFiles("harbor"))[0]!.givenTo, ["ux"]);

  const env = await storeFile({ project: harbor, name: "settings.txt", bytes: text("api_key=abcdef123456"), ...owner });
  strictEqual(await hub.giveFile("harbor", env.id, "ux"), "needs-yes");
  strictEqual(sent.length, 1, "nothing went out");
  strictEqual(await hub.giveFile("harbor", env.id, "ux", { anyway: true }), "sent");
  ok(!sent[1]!.text.includes("abcdef123456"), "the message carries the path, never the contents");

  strictEqual(await hub.giveFile("harbor", shot.id, "nobody"), "not-found");
  strictEqual(await hub.giveFile("vault", shot.id, "dev"), "not-found", "never in a private project");
  void vault;
});
