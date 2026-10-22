export interface RectTarget {
  rect(x: number, y: number, w: number, h: number, colour: string): void;
}

/** The owner's choice for an agent's figure (D-062), as `look` in project.yaml. */
export interface LookChoice {
  gender?: "man" | "woman";
  set?: "office" | "cartoon";
}

/**
 * How a person is drawn. The sprite contract (D-062): every set fills the same boxes — the head 24 × 22, the seated
 * shoulders 30 wide, the arms and hands on the keyboard, a standing figure 24 wide anchored at its feet — so the
 * layout and the animations are the same whoever sits there. The shirt is the role's colour; skin, hair colour,
 * glasses and `style` come from the id's hash. `style` is a hair style in the office set (0–4 as always; with a gender,
 * a man's 7, 8, 9, 4 and a woman's 2, 3, 5, 6) and a variant 0–3 in the cartoon set.
 */
export interface PersonLook {
  skin: string;
  hairIndex: number;
  style: number;
  glasses: boolean;
  shirt: string;
  gender?: "man" | "woman";
  set?: "cartoon";
}

export interface Glyph {
  rows: readonly string[];
  colour: string;
}

export type FurnitureDrawer = (ctx: RectTarget, x: number, y: number) => void;

export const RES: number;
export function shade(hex: string, amount: number): string;
export function ellipse(ctx: RectTarget, cx: number, cy: number, rx: number, ry: number, colour: string): void;
export function floorPixels(ctx: RectTarget, width: number, height: number, top: number, a: string, b: string, pattern?: string): void;
export function wallPixels(ctx: RectTarget, width: number, wallH: number, wall: string, line: string, skirting: string): void;
export function windowPixels(ctx: RectTarget, x: number, y: number, w: number, h: number, frame: string, sky: string): void;
export function plantPixels(ctx: RectTarget, x: number, y: number): void;
export function paperPixels(ctx: RectTarget, x: number, y: number): void;
export function bubblePixels(ctx: RectTarget, x: number, y: number, glyph: Glyph): void;
export function lookOf(hash: number, shirt: string, choice?: LookChoice | null): PersonLook;
export function cartoonHeadPixels(ctx: RectTarget, x: number, y: number, look: PersonLook, side?: boolean): void;
export function headPixels(ctx: RectTarget, x: number, y: number, look: PersonLook, side?: boolean): void;
export function shouldersPixels(ctx: RectTarget, x: number, y: number, look: PersonLook, tie?: string): void;
export function above(ctx: RectTarget, maxY: number): RectTarget;
export function armsPixels(ctx: RectTarget, x: number, y: number, look: PersonLook, beat: number): void;
export function seatedPixels(ctx: RectTarget, x: number, y: number, look: PersonLook, options?: { tie?: string; side?: boolean }): void;
export function standingPixels(ctx: RectTarget, x: number, y: number, look: PersonLook, step: number, tie?: string): void;
export function deskPixels(ctx: RectTarget, x: number, y: number, options: {
  manager: boolean;
  working: boolean;
  plateWidth: number;
  code: ReadonlyArray<{ dx: number; w: number; colour: string }>;
  tray?: number;
  plate: string;
}): void;

export const ITEMS: Record<string, FurnitureDrawer>;
export const ITEM_SIZE: Record<string, readonly [width: number, height: number, leftPadding: number]>;
