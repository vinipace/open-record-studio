import type {
  CanvasAsset,
  CanvasLayer,
  Edits,
  TakeSample,
  TakeSpan,
} from "../src/types";
export function validateTimeMap(
  map: TakeSpan[] | undefined,
  duration: number,
): TakeSpan[] | undefined;
export function layerDuration(asset: CanvasAsset): number;
export function layerSpans(layer: CanvasLayer, asset: CanvasAsset): TakeSpan[];
export function layerSample(
  layer: CanvasLayer,
  asset: CanvasAsset,
  source: number,
): { time: number; rate: number } | null;
export function makeTakeMap(
  edits: Edits,
  samples: TakeSample[],
  duration: number,
): { start: number; end: number; timeMap: TakeSpan[] };
export function takeOutputSpans(
  edits: Edits,
  layer: CanvasLayer,
  asset: CanvasAsset,
): TakeSpan[];
