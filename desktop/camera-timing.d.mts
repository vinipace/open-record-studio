import type { Track } from "../src/types";
export function cameraStartHold(track: Track, adjustment?: number): number;
export function cameraFrameTime(
  track: Track,
  source: number,
  adjustment?: number,
): number | null;
