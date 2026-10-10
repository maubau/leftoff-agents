// Types for building.js, which is plain JavaScript because the browser loads it as is.
import type { OfficeLayout, OfficeModel, OfficeScene, RectTarget } from "./office.js";

export const MARGIN: number;
export const TOP: number;
export const GAP: number;
export const BLEED: number;
export const SHIFT: number;
export const DEPTH: { bg: number; rooms: number; desks: number; people: number };
export const MIN_SCALE: number;

export interface BuildingRoomInput {
  id: string;
  name: string;
  model: OfficeModel;
}

export interface BuildingRoom extends BuildingRoomInput {
  layout: OfficeLayout;
  x: number;
  y: number;
  /** Where the project's name goes on the wall. */
  sign: { x: number; y: number; w: number; h: number };
  /** The captions under each desk, in the building's coordinates. */
  captions: Array<{ id: string; x: number; y: number; w: number; h: number }>;
}

export interface Building {
  width: number;
  height: number;
  rooms: BuildingRoom[];
}

export type BuildingLayer = "bg" | "rooms" | "desks" | "people";

export function buildingLayout(rooms: BuildingRoomInput[], maxWidth: number): Building;
export function drawBuilding(ctx: RectTarget, building: Building, layer: BuildingLayer, t?: number, scenes?: Map<string, OfficeScene>): void;
export function buildingBusy(building: Building, t?: number, scenes?: Map<string, OfficeScene>): boolean;
