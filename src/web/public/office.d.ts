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
}

export interface OfficeLayout {
  width: number;
  height: number;
  cols: number;
  pm: { x: number; y: number };
  stations: Array<{ agent: OfficeModel["agents"][number]; x: number; y: number }>;
}

export interface RectTarget {
  rect(x: number, y: number, w: number, h: number, colour: string): void;
}

export function plateText(name: string, max?: number): string;
export function officeModel(project: OfficeInput): OfficeModel;
export function officeLayout(model: OfficeModel): OfficeLayout;
export function drawOffice(ctx: RectTarget, model: OfficeModel, t?: number): OfficeLayout;
