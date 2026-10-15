import type { Edits, TimeRange } from "../src/types";
export function mergeRanges(ranges: TimeRange[]): TimeRange[];
export function validateRemovedAudio(
  ranges: unknown,
  duration: number,
): TimeRange[];
export function audibleRanges(edits: Edits, segment: TimeRange): TimeRange[];
export function audioRemovedAt(edits: Edits, source: number): boolean;
export function audioRemovalFilter(edits: Edits): string;
