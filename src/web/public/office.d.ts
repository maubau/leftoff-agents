// Types for office.js, which is plain JavaScript because the browser loads it as is.

export interface OfficeAgentInput {
  id: string;
  /** The emoji of its role (see roleFace), which picks the shirt. */
  face?: string | null;
  live?: "running" | "idle" | "closed" | "unknown";
  status?: string;
  awaiting?: boolean;
}

export interface OfficeInput {
  agents?: OfficeAgentInput[];
  handoffs?: Array<{ from: string; to: string }>;
  counts?: { todo: number; doing: number; blocked: number; done: number };
}

export type OfficeState = "working" | "blocked" | "needs" | "awaiting" | "done" | "idle";

export interface OfficeModel {
  agents: Array<{ id: string; plate: string; face: string | null; state: OfficeState }>;
  handoffs: Array<{ from: string; to: string }>;
  counts: { todo: number; doing: number; blocked: number; done: number };
  /** Leave room under each desk for the name and role the panel prints there. */
  captions?: boolean;
  /** A room with the lights off: a project with no agent. Only the PM's row, and nobody at the PM's desk. */
  off?: boolean;
  /** Which of THEMES the room is furnished as; without one it is the plain office. */
  theme?: number;
}

export interface OfficeLayout {
  width: number;
  height: number;
  cols: number;
  pm: { x: number; y: number };
  stations: Array<{ agent: OfficeModel["agents"][number]; x: number; y: number }>;
  /** With `captions`: the box under each desk (office pixels) for that agent's name and role. */
  captions: Array<{ id: string; x: number; y: number; w: number; h: number }>;
}

export interface RectTarget {
  rect(x: number, y: number, w: number, h: number, colour: string): void;
}

export function plateText(name: string, max?: number): string;
export function officeModel(project: OfficeInput): OfficeModel;
export function officeLayout(model: OfficeModel): OfficeLayout;
/** What is happening in the office right now; `at` is on the same clock as the `t` given to drawOffice. */
export interface OfficeScene {
  /** The PM answering the owner: at its screen (from the panel) or with a phone in hand (from the chat app). */
  pm?: "typing" | "phone" | undefined;
  /** Agents the PM has just talked to: each gets up, walks to the PM, they exchange a word, it walks back. */
  visits?: Array<{ agent: string; kind: "status" | "command" | "handoff" | "talk"; at: number }>;
  /** Nobody walks or types; the two sides only speak, one bubble after the other. */
  reduced?: boolean | undefined;
}

export interface OfficePlay {
  walkers: Array<{ agent: string; x: number; y: number; step: number; say?: string }>;
  speaking: Map<string, string>;
  pmSays: string | null;
  /** Whether anything is still going on, so the caller knows to keep drawing at a high frame rate. */
  busy: boolean;
}

export function playScene(model: OfficeModel, layout: OfficeLayout, scene?: OfficeScene, t?: number): OfficePlay;
export type OfficeLayer = "room" | "desks" | "people";
export function drawOffice(ctx: RectTarget, model: OfficeModel, t?: number, scene?: OfficeScene, layer?: OfficeLayer): OfficeLayout;

export interface OfficeTheme {
  name: string;
  colors: Record<string, string>;
  floor: "checker" | "planks" | "stripes" | "tiles" | "grass";
  rug: [string, string] | null;
  items: [string, string];
  stars?: boolean;
}
export const THEMES: OfficeTheme[];
export function themeIndexes(ids: Iterable<string>): Map<string, number>;
export function drawBubble(ctx: RectTarget, x: number, y: number, glyph: string): void;
/** Pixels of the drawing to each unit of the layout: a canvas is `layout.width * RES` wide. */
export const RES: number;
