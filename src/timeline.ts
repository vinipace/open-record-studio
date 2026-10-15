import type { Edits, TimeRange } from "./types";
export function duration(edits: Edits) {
  return (
    edits.segments.reduce((sum, s) => sum + s.end - s.start, 0) /
    edits.style.speed
  );
}
export function sourceTime(edits: Edits, time: number) {
  let remaining = Math.max(0, time) * edits.style.speed;
  for (const s of edits.segments) {
    if (remaining < s.end - s.start) return s.start + remaining;
    remaining -= s.end - s.start;
  }
  return edits.segments.at(-1)!.end;
}
// At a cut, an out-point belongs to the preceding clip, an in-point to the next.
export function sourceBoundary(edits: Edits, time: number, end = false) {
  const t = Math.max(0, Math.min(duration(edits), time));
  let offset = 0;
  for (const [i, segment] of edits.segments.entries()) {
    const next = offset + (segment.end - segment.start) / edits.style.speed;
    if (Math.abs(t - next) < 1e-6)
      return end ? segment.end : (edits.segments[i + 1]?.start ?? segment.end);
    if (t < next) return segment.start + (t - offset) * edits.style.speed;
    offset = next;
  }
  return edits.segments.at(-1)!.end;
}
export function outputTime(edits: Edits, source: number) {
  let time = 0;
  for (const segment of edits.segments) {
    if (source <= segment.start) break;
    time += (Math.min(source, segment.end) - segment.start) / edits.style.speed;
    if (source < segment.end) break;
  }
  return time;
}

// All media, audio and motion use source time. Removing retained source spans
// therefore ripples every track together without changing their sync offsets.
export function removeTimelineRange(edits: Edits, range: TimeRange): Edits {
  const total = duration(edits);
  const start = Math.max(0, Math.min(total, Math.min(range.start, range.end)));
  const end = Math.max(
    start,
    Math.min(total, Math.max(range.start, range.end)),
  );
  if (end - start < 1e-6) return edits;
  let offset = 0;
  const segments: TimeRange[] = [];
  const append = (start: number, end: number) => {
    if (end - start >= 0.05 - 1e-9) segments.push({ start, end });
  };
  for (const segment of edits.segments) {
    const next = offset + (segment.end - segment.start) / edits.style.speed;
    if (end <= offset || start >= next) segments.push({ ...segment });
    else {
      append(
        segment.start,
        segment.start + Math.max(0, start - offset) * edits.style.speed,
      );
      append(
        segment.end - Math.max(0, next - end) * edits.style.speed,
        segment.end,
      );
    }
    offset = next;
  }
  if (!segments.length)
    throw new Error("Keep at least a short part of the video.");
  if (segments.length > 100)
    throw new Error("Keep at most 100 timeline clips.");
  const retained = (item: TimeRange) =>
    segments.some((s) => s.start < item.end && s.end > item.start);
  return {
    ...edits,
    segments,
    ...(edits.zooms ? { zooms: edits.zooms.filter(retained) } : {}),
    ...(edits.layers ? { layers: edits.layers.filter(retained) } : {}),
  };
}
export function segmentAt(edits: Edits, time: number) {
  let end = 0;
  for (let i = 0; i < edits.segments.length; i++) {
    end +=
      (edits.segments[i].end - edits.segments[i].start) / edits.style.speed;
    if (time < end) return i;
  }
  return edits.segments.length - 1;
}
// A split without removed footage needs no decoder change.
export function nextMediaCut(edits: Edits, time: number) {
  let at = 0;
  for (let i = 1; i < edits.segments.length; i++) {
    const previous = edits.segments[i - 1],
      next = edits.segments[i];
    at += (previous.end - previous.start) / edits.style.speed;
    if (at > time + 1e-6 && next.start - previous.end > 0.001)
      return { index: i, time: at, source: next.start };
  }
  return null;
}
export function clock(seconds: number) {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;
}
