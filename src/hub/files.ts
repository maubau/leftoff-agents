import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configRoot } from "../core/paths.ts";
import type { Project } from "../core/project.ts";
import { redact } from "./redact.ts";

/**
 * Attachments (D-071), phase 1: where files are kept, their list, the limits, the type and key checks. On the hub's
 * machine, outside every repository, never in a commit: `files/<project>/<yyyy-mm>/<id>-<safe name>`, files 0600 and
 * folders 0700, with `files/<project>/files.jsonl` listing them. Only the file's facts are listed, never its contents.
 */

/** 20 MB a file — the most a Telegram bot can download — and 200 MB per project per calendar month. */
export const FILE_MAX = 20 * 1024 * 1024;
export const MONTH_MAX = 200 * 1024 * 1024;
export const KEEP_MS = 90 * 86_400_000;
const NAME_MAX = 80;

export type FileVia = "panel" | "telegram" | "cli" | "agent";
export type FileChat = { kind: "project" } | { kind: "agent"; agent: string } | { kind: "task"; task: string };

export interface StoredFile {
  /** `f` and lowercase letters and digits: part of the file's name on disk. */
  id: string;
  project: string;
  /** The cleaned name, as shown. */
  name: string;
  /** Where it is on disk: what an agent is given. */
  path: string;
  size: number;
  /** What its first bytes show, as a MIME type. */
  type: string;
  sha256: string;
  at: string;
  /** `owner`, or the agent that sent it. */
  from: string;
  via: FileVia;
  chat: FileChat;
  /** The agents it was given to. */
  givenTo: string[];
  /** A text file in which the redaction patterns found something that looks like a key. */
  keyFound: boolean;
  deletedAt?: string;
}

/** Why a file was refused, for the owner to read; `status` is what the panel's HTTP answer would carry. */
export class FileRefused extends Error {
  readonly reason: "private" | "empty" | "too-large" | "month-full" | "type" | "mismatch";
  readonly status: number;
  constructor(reason: FileRefused["reason"], message: string) {
    super(message);
    this.reason = reason;
    this.status = reason === "too-large" || reason === "month-full" ? 413 : reason === "private" ? 404 : 415;
  }
}

export const filesRoot = () => join(configRoot(), "files");
const listFile = (projectId: string) => join(filesRoot(), safeSegment(projectId), "files.jsonl");

/** A project id as a folder name: it never climbs out of the store. */
function safeSegment(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  if (!clean) throw new Error("not a project id");
  return clean;
}

/** Letters, digits, dots and dashes, never a path, never hidden; the extension kept. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const plain = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-*\.-*/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!plain) return "file";
  if (plain.length <= NAME_MAX) return plain;
  const dot = plain.lastIndexOf(".");
  const ext = dot > 0 && plain.length - dot <= 10 ? plain.slice(dot) : "";
  return plain.slice(0, NAME_MAX - ext.length) + ext;
}

/** The types of phase 1, by extension: images, PDF, and plain text of five kinds. No archives, no executables. */
const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

export const isText = (type: string) => type.startsWith("text/") || type === "application/json";

const startsWith = (bytes: Uint8Array, sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Do the first bytes show this type? Text must be UTF-8 without NUL bytes; JSON must open like JSON. */
export function matchesType(bytes: Uint8Array, type: string): boolean {
  switch (type) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "application/pdf":
      return startsWith(bytes, ascii("%PDF-"));
    default: {
      if (!isText(type) || bytes.includes(0)) return false;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return false;
      }
      if (type !== "application/json") return true;
      const first = text.replace(/^﻿/, "").trimStart()[0];
      return first === "{" || first === "[";
    }
  }
}

/** The type a name says, or undefined when phase 1 does not take it. */
export function typeOfName(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined;
}

/** A text file the redaction patterns would change: it looks like it carries a key. Only the answer is kept. */
export function looksLikeKey(bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8").decode(bytes);
  return redact(text) !== text;
}

async function load(projectId: string): Promise<StoredFile[]> {
  const raw = await readFile(listFile(projectId), "utf8").catch(() => "");
  const out: StoredFile[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line) as StoredFile;
      if (typeof f.id === "string" && typeof f.path === "string") out.push(f);
    } catch {
      /* a damaged line costs that line only */
    }
  }
  return out;
}

async function save(projectId: string, files: StoredFile[]): Promise<void> {
  const target = listFile(projectId);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, files.map((f) => JSON.stringify(f)).join("\n") + (files.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}

/** Changes are chained, so two files arriving at once never lose a line, nor slip past the month's limit together. */
let queue: Promise<unknown> = Promise.resolve();
function change<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

export interface NewFile {
  project: Project;
  name: string;
  bytes: Uint8Array;
  from: string;
  via: FileVia;
  chat: FileChat;
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Keep a file, or refuse it with the reason: a private project, empty, over 20 MB, over the project's 200 MB this
 * month, a type phase 1 does not take, or first bytes that are not what its name says.
 */
export function storeFile(input: NewFile, now = new Date()): Promise<StoredFile> {
  return change(async () => {
    const { project, bytes } = input;
    if (project.config.visibility === "private") throw new FileRefused("private", "a private project has no attachments");
    if (bytes.length === 0) throw new FileRefused("empty", "the file is empty");
    if (bytes.length > FILE_MAX) throw new FileRefused("too-large", `the file is over ${FILE_MAX / 1024 / 1024} MB`);
    const name = safeName(input.name);
    const type = typeOfName(name);
    if (!type) throw new FileRefused("type", "this kind of file is not taken: images (PNG, JPEG, WebP, GIF), PDF, text, Markdown, CSV, JSON and logs");
    if (!matchesType(bytes, type)) throw new FileRefused("mismatch", `the file is not what its name says (${type})`);
    const files = await load(project.id);
    const month = monthOf(now);
    const used = files.filter((f) => monthOf(new Date(f.at)) === month).reduce((sum, f) => sum + f.size, 0);
    if (used + bytes.length > MONTH_MAX) throw new FileRefused("month-full", `${project.config.name} has used its ${MONTH_MAX / 1024 / 1024} MB of files this month`);

    const id = `f${now.getTime().toString(36)}${randomBytes(3).toString("hex")}`;
    const folder = join(filesRoot(), safeSegment(project.id), month);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${id}-${name}`);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    const stored: StoredFile = {
      id,
      project: project.id,
      name,
      path,
      size: bytes.length,
      type,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      at: now.toISOString(),
      from: input.from,
      via: input.via,
      chat: input.chat,
      givenTo: [],
      keyFound: isText(type) && looksLikeKey(bytes),
    };
    await save(project.id, [...files, stored]);
    return stored;
  });
}

/** A project's files, newest first; deleted ones only when asked. */
export async function listFiles(projectId: string, options: { deleted?: boolean } = {}): Promise<StoredFile[]> {
  await queue;
  return (await load(projectId)).filter((f) => options.deleted || !f.deletedAt).reverse();
}

export async function getFile(projectId: string, id: string): Promise<StoredFile | undefined> {
  await queue;
  return (await load(projectId)).find((f) => f.id === id && !f.deletedAt);
}

/** Record that an agent was given the file. */
export function markGiven(projectId: string, id: string, agent: string): Promise<StoredFile | undefined> {
  return change(async () => {
    const files = await load(projectId);
    const file = files.find((f) => f.id === id && !f.deletedAt);
    if (!file) return undefined;
    if (!file.givenTo.includes(agent)) file.givenTo.push(agent);
    await save(projectId, files);
    return file;
  });
}

/** Delete a file now: gone from disk, kept in the list as deleted so the month's use still counts it. */
export function deleteFile(projectId: string, id: string, now = new Date()): Promise<StoredFile | undefined> {
  return change(async () => {
    const files = await load(projectId);
    const file = files.find((f) => f.id === id && !f.deletedAt);
    if (!file) return undefined;
    await rm(file.path, { force: true });
    file.deletedAt = now.toISOString();
    await save(projectId, files);
    return file;
  });
}

/**
 * Files older than 90 days are deleted; lines of files deleted more than 90 days ago leave the list. Every project
 * folder in the store, private ones too: what was kept is deleted on time whatever the project became.
 */
export function pruneFiles(now = new Date()): Promise<number> {
  return change(async () => {
    const folders = await readdir(filesRoot(), { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const files = await load(folder.name);
      let changed = false;
      for (const f of files) {
        if (!f.deletedAt && now.getTime() - Date.parse(f.at) > KEEP_MS) {
          await rm(f.path, { force: true });
          f.deletedAt = now.toISOString();
          removed++;
          changed = true;
        }
      }
      const kept = files.filter((f) => !f.deletedAt || now.getTime() - Date.parse(f.deletedAt) <= KEEP_MS);
      if (changed || kept.length !== files.length) await save(folder.name, kept);
    }
    return removed;
  });
}

/** A size as a person reads it. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
