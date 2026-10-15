import type { Style, Track } from "../src/types";
export const aspectRatios: Style["aspectRatio"][];
export const canvasTemplates: {
  id: string;
  name: string;
  ratio: Style["aspectRatio"];
}[];
export function compositionRatio(style: Style, screen: Track): number;
export function compositionSize(
  style: Style,
  resolution: number,
  screen: Track,
): { width: number; height: number };
export function compositionLayout(
  style: Style,
  width: number,
  height: number,
): {
  pad: number;
  innerWidth: number;
  innerHeight: number;
  cameraSize: number;
  cameraGap: number;
};
export function applyCanvasStyle(style: Style, changes: Partial<Style>): Style;
