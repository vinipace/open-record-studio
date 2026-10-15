import type { CanvasLayer, CanvasAsset } from "../src/types";
export function layerRect(
  layer: CanvasLayer,
  asset: CanvasAsset,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number };
export function validateLayers(
  layers: unknown,
  assets: Record<string, CanvasAsset>,
  duration: number,
): CanvasLayer[];
