import type { Edits, Style, Cursor } from "../src/types";
export function clamp(x: number, min?: number, max?: number): number;
export const defaultZoomEase: number;
export function ease(x: number): number;
export function sourceAt(edits: Edits, time: number): number;
export function canFollowCursor(cursor: Cursor | undefined): boolean;
export function zoomAt(
  edits: Edits,
  time: number,
  cursor?: Cursor,
): { zoom: number; focusX: number; focusY: number };
export function cropAt(
  edits: Edits,
  time: number,
  cursor?: Cursor,
): { x: number; y: number; size: number };
export function sourceRanges(
  edits: Edits,
  start: number,
  end: number,
): { start: number; end: number }[];
export function cursorAt(
  cursor: Cursor | undefined,
  source: number,
  style: Style,
): { x: number; y: number; pressed: boolean } | null;
export const cursorPath: string;
