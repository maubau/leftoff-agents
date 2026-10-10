// Types for home.js, which is plain JavaScript because the browser loads it as is.
import type { OfficeLayout, OfficeModel, OfficeScene, RectTarget } from "./office.js";

export interface HomeText {
  name: string;
  description: string;
  /** "blocked", "needs" or "done": the bubble at the end of the sign. */
  badge: string | null;
  autonomous: boolean;
}

export interface HomeLayout {
  width: number;
  height: number;
  room: OfficeLayout;
  lines: string[];
  board: number;
  sign: { x: number; y: number; w: number; h: number };
}

export function badgeOf(headline: string): string | null;
export function homeLayout(model: OfficeModel, description: string): HomeLayout;
export function drawHome(ctx: RectTarget, model: OfficeModel, text: HomeText, t?: number, scene?: OfficeScene, layout?: HomeLayout): HomeLayout;
export function drawHomeBase(ctx: RectTarget, model: OfficeModel, text: HomeText, layout?: HomeLayout): HomeLayout;
export function drawHomeLive(ctx: RectTarget, model: OfficeModel, text: HomeText, t?: number, scene?: OfficeScene, layout?: HomeLayout): void;
