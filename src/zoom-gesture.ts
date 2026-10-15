import type { Edits, Zoom } from "./types";
import { duration, outputTime, sourceBoundary } from "./timeline";

// The end of a retained clip belongs to the preceding source range, while its
// start belongs to the following range. This matters when dragging over cuts.
export function zoomDragRange(edits: Edits, anchor: number, time: number) {
  const total = duration(edits);
  const bound = (t: number) => Math.max(0, Math.min(total, t));
  const origin = sourceBoundary(edits, bound(anchor));
  const zooms = edits.zooms || [];
  if (zooms.some((z) => origin >= z.start && origin < z.end)) return null;
  const lower = zooms.filter((z) => z.end <= origin).at(-1)?.end ?? 0;
  const upper = zooms.find((z) => z.start > origin)?.start ?? Infinity;
  let end = sourceBoundary(edits, bound(Math.max(anchor, time)), true);
  const start = Math.max(
    lower,
    sourceBoundary(edits, bound(Math.min(anchor, time))),
  );
  end = Math.min(upper, end);
  return end > start ? { start, end } : null;
}

export function moveZoomRange(edits: Edits, zoom: Zoom, delta: number) {
  const start = outputTime(edits, zoom.start),
    end = outputTime(edits, zoom.end);
  const others = (edits.zooms || []).filter((z) => z.id !== zoom.id);
  const lower = others.filter((z) => z.end <= zoom.start).at(-1)?.end ?? 0;
  const upper =
    others.find((z) => z.start >= zoom.end)?.start ??
    edits.segments.at(-1)!.end;
  const shift = Math.max(
    outputTime(edits, lower) - start,
    Math.min(outputTime(edits, upper) - end, delta),
  );
  if (Math.abs(shift) < 1e-9 || end <= start)
    return { start: zoom.start, end: zoom.end };
  const moved = {
    start: Math.max(lower, sourceBoundary(edits, start + shift)),
    end: Math.min(upper, sourceBoundary(edits, end + shift, true)),
  };
  return moved.end - moved.start >= 0.1
    ? moved
    : { start: zoom.start, end: zoom.end };
}
