import { sourceRanges } from "./motion.mjs";

export function mergeRanges(ranges) {
  const result = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else result.push({ start: range.start, end: range.end });
  }
  return result;
}
export function validateRemovedAudio(ranges, duration) {
  if (ranges === undefined) return [];
  if (!Array.isArray(ranges) || ranges.length > 1000)
    throw new Error("Keep at most 1000 removed audio ranges");
  return mergeRanges(
    ranges.map((r) => {
      if (
        !r ||
        typeof r.start !== "number" ||
        typeof r.end !== "number" ||
        !Number.isFinite(r.start) ||
        !Number.isFinite(r.end) ||
        r.start < 0 ||
        r.start >= duration ||
        r.end > duration + 0.001 ||
        r.end <= r.start
      )
        throw new Error("Invalid removed audio range");
      return { start: r.start, end: Math.min(duration, r.end) };
    }),
  );
}
// Visible source-time audio fragments. Video cuts remain unchanged.
export function audibleRanges(edits, segment) {
  const result = [];
  let start = segment.start;
  for (const removed of edits.removedAudio || []) {
    if (removed.end <= start) continue;
    if (removed.start >= segment.end) break;
    if (removed.start > start) result.push({ start, end: removed.start });
    start = Math.max(start, removed.end);
  }
  if (start < segment.end) result.push({ start, end: segment.end });
  return result;
}
export function audioRemovedAt(edits, source) {
  return (edits.removedAudio || []).some(
    (r) => source >= r.start && source < r.end,
  );
}
export function audioRemovalFilter(edits) {
  const ranges = mergeRanges(
    (edits.removedAudio || []).flatMap((r) =>
      sourceRanges(edits, r.start, r.end),
    ),
  );
  if (!ranges.length) return "";
  // Balanced time lookup keeps both expression depth and per-sample work bounded.
  const gain = (lo, hi) => {
    if (lo >= hi) return "1";
    const mid = Math.floor((lo + hi) / 2),
      r = ranges[mid];
    return `if(lt(t,${r.start}),${gain(lo, mid)},if(lt(t,${r.end}),0,${gain(mid + 1, hi)}))`;
  };
  return `,aeval=exprs='val(ch)*${gain(0, ranges.length)}':c=same`;
}
