// Shared by the editor and exporter. Section boundaries and cursor samples use
// source time; the camera animates on the edited output clock so cuts cannot
// skip ahead in a transition.
export const clamp = (x, min = 0, max = 1) => Math.max(min, Math.min(max, x));
export const defaultZoomEase = 0.6;
export const ease = (x) => {
  const t = clamp(x);
  // Zero velocity, acceleration AND jerk at both ends. A broad velocity peak
  // avoids rushing through the middle of the move: v = 105*t^3*(1-t)^3 *
  // (1 + 12*(t-.5)^2). Its peak is 1.640625 vs 1.875 for the old quintic.
  // Evaluate the nearest endpoint to avoid cancellation near full progress.
  const u = Math.min(t, 1 - t);
  const weight =
    u ** 4 *
    (105 + u * (-504 + u * (1050 + u * (-1140 + u * (630 - 140 * u)))));
  return t < 0.5 ? weight : 1 - weight;
};
export function sourceAt(edits, time) {
  let left = Math.max(0, time) * edits.style.speed;
  for (const s of edits.segments) {
    if (left < s.end - s.start) return s.start + left;
    left -= s.end - s.start;
  }
  return edits.segments.at(-1).end;
}
const viewport = (z) => ({
  x: (1 - 1 / z.zoom) * z.focusX,
  y: (1 - 1 / z.zoom) * z.focusY,
  size: 1 / z.zoom,
});
const cameraCache = new WeakMap();
const cursorCache = new WeakMap();
function visibleSamples(cursor) {
  if (!cursor?.clean) return [];
  let samples = cursorCache.get(cursor);
  if (!samples) {
    samples = cursor.samples.filter((sample) => sample.visible);
    cursorCache.set(cursor, samples);
  }
  return samples;
}
export const canFollowCursor = (cursor) => visibleSamples(cursor).length > 0;
function cameraTrack(edits, cursor) {
  const { zoom, focusX, focusY, speed } = edits.style;
  // Edits are mutable during slider/trim gestures, so object identity alone is
  // insufficient. Cache only fields that affect the path, not cursor samples.
  const key = JSON.stringify([
    zoom,
    focusX,
    focusY,
    speed,
    edits.segments,
    edits.zooms,
  ]);
  const cached = cameraCache.get(edits);
  if (cached?.key === key && cached.cursor === cursor) return cached;
  const base = viewport(edits.style);
  const sections = (edits.zooms || []).flatMap((z) => {
    const ranges = sourceRanges(edits, z.start, z.end);
    if (!ranges.length) return [];
    const start = ranges[0].start,
      end = ranges.at(-1).end;
    return [
      {
        start,
        end,
        ramp: Math.min(z.ease, (end - start) / 2),
        crop: {
          ...viewport(z),
          follow: z.mode === "follow" && canFollowCursor(cursor),
        },
      },
    ];
  });
  const transitions = [];
  const touching = (a, b) => a && b && Math.abs(a.end - b.start) < 1e-7;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i],
      previous = sections[i - 1],
      next = sections[i + 1];
    if (!touching(previous, section))
      transitions.push({
        start: section.start,
        end: section.start + section.ramp,
        from: base,
        to: section.crop,
      });
    if (touching(section, next))
      // Adjacent zooms hand off directly. Their exit/entry windows form one
      // transition instead of two trips through the unzoomed frame.
      transitions.push({
        start: section.end - section.ramp,
        end: next.start + next.ramp,
        from: section.crop,
        to: next.crop,
      });
    else
      transitions.push({
        start: section.end - section.ramp,
        end: section.end,
        from: section.crop,
        to: base,
      });
  }
  const track = {
    key,
    base,
    transitions,
    cursor,
    edits,
    duration:
      edits.segments.reduce((sum, s) => sum + s.end - s.start, 0) / speed,
    followPoints: new Map(),
  };
  cameraCache.set(edits, track);
  return track;
}
// Camera motion uses a wider smoothing window than the pointer. Sample on the
// OUTPUT clock, then interpolate with continuous, bounded tangents: cuts, clicks,
// hidden cursors and random seeks must not cause a camera snap. Cursor visibility
// controls the drawn pointer only, never the camera's recorded motion.
function followCrop(track, crop, time) {
  if (!crop.follow) return crop;
  const { edits, cursor, followPoints } = track;
  const samples = visibleSamples(cursor),
    step = 1 / 20,
    travel = 1 - crop.size;
  const point = (index) => {
    const key = `${crop.size}:${index}`;
    if (followPoints.has(key)) return followPoints.get(key);
    let x = 0,
      y = 0,
      sum = 0;
    for (let k = -12; k <= 12; k++) {
      const t = sourceAt(
        edits,
        clamp(index * step + k / 30, 0, track.duration),
      );
      // Hold the last visible position while the pointer is hidden/off-screen.
      const p = rawCursorAt(cursor.samples, t) || samples[indexAt(samples, t)];
      const weight = Math.exp(-0.5 * (k / 4.5) ** 2);
      x += clamp(p.x - crop.size / 2, 0, travel) * weight;
      y += clamp(p.y - crop.size / 2, 0, travel) * weight;
      sum += weight;
    }
    const value = { x: x / sum, y: y / sum };
    // Keep long recordings and arbitrary scrubbing from retaining an entire
    // sampled camera movie. Recomputing an evicted point is deterministic.
    if (followPoints.size >= 4096)
      for (let i = 0; i < 1024; i++)
        followPoints.delete(followPoints.keys().next().value);
    followPoints.set(key, value);
    return value;
  };
  const index = Math.floor(time / step),
    u = time / step - index;
  const a = point(index - 1),
    b = point(index),
    c = point(index + 1),
    d = point(index + 2);
  const tangent = (a, b) => (a * b <= 0 ? 0 : (2 * a * b) / (a + b));
  const result = { size: crop.size };
  for (const key of ["x", "y"]) {
    const delta = c[key] - b[key];
    const m0 = tangent(b[key] - a[key], delta),
      m1 = tangent(delta, d[key] - c[key]);
    result[key] =
      b[key] +
      u * (m0 + u * (3 * delta - 2 * m0 - m1 + u * (m0 + m1 - 2 * delta)));
  }
  return result;
}
function interpolateCrop(from, to, weight) {
  // Equal ratios of magnification feel equally fast. Interpolating viewport
  // edges with this size keeps the zoom pivot stationary, even off-center.
  const size = from.size * Math.exp(Math.log(to.size / from.size) * weight);
  const progress =
    Math.abs(to.size - from.size) < 1e-7
      ? weight
      : (size - from.size) / (to.size - from.size);
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    size,
  };
}
// The time argument is edited OUTPUT seconds, including playback speed.
// Fractional crop edges avoid the stepping caused by integer crop widths.
export function cropAt(edits, time, cursor) {
  return trackCropAt(cameraTrack(edits, cursor), time);
}
function trackCropAt(track, time) {
  const { base, transitions } = track;
  let crop = base;
  for (const transition of transitions) {
    if (time < transition.start) break;
    if (time < transition.end)
      return interpolateCrop(
        followCrop(track, transition.from, time),
        followCrop(track, transition.to, time),
        ease((time - transition.start) / (transition.end - transition.start)),
      );
    crop = transition.to;
  }
  const { x, y, size } = followCrop(track, crop, time);
  return { x, y, size };
}
export function zoomAt(edits, time, cursor) {
  const crop = cropAt(edits, time, cursor),
    travel = 1 - crop.size;
  return {
    zoom: 1 / crop.size,
    focusX: travel > 1e-7 ? crop.x / travel : edits.style.focusX,
    focusY: travel > 1e-7 ? crop.y / travel : edits.style.focusY,
  };
}
export function sourceRanges(edits, start, end) {
  const result = [];
  let offset = 0;
  for (const seg of edits.segments) {
    const a = Math.max(start, seg.start),
      b = Math.min(end, seg.end);
    if (b > a)
      result.push({
        start: offset + (a - seg.start) / edits.style.speed,
        end: offset + (b - seg.start) / edits.style.speed,
      });
    offset += (seg.end - seg.start) / edits.style.speed;
  }
  return result;
}
function indexAt(samples, time) {
  let lo = 0,
    hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].t <= time) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}
export function rawCursorAt(samples, time) {
  if (!samples?.length || time < samples[0].t || time > samples.at(-1).t + 0.1)
    return null;
  const i = indexAt(samples, time),
    a = samples[i],
    b = samples[i + 1];
  if (!a.visible) return null;
  const f =
    b?.visible && b.t - a.t < 0.15 ? clamp((time - a.t) / (b.t - a.t)) : 0;
  return {
    x: a.x + (b?.x - a.x || 0) * f,
    y: a.y + (b?.y - a.y || 0) * f,
    pressed: a.pressed,
  };
}
export function cursorAt(cursor, source, style) {
  if (!cursor?.clean || !style.showCursor) return null;
  const raw = rawCursorAt(cursor.samples, source);
  if (!raw) return null;
  const radius = style.cursorSmoothing ?? 0.06;
  // Keep clicks pinned to their exact target. Do not blend across hidden spans.
  if (!radius || raw.pressed) return raw;
  let x = 0,
    y = 0,
    weight = 0;
  for (let i = -10; i <= 10; i++) {
    const p = rawCursorAt(cursor.samples, source + (i * radius) / 10);
    if (!p || p.pressed) continue;
    const w = Math.exp(-0.5 * (i / 5) ** 2);
    x += p.x * w;
    y += p.y * w;
    weight += w;
  }
  return weight ? { x: x / weight, y: y / weight, pressed: raw.pressed } : raw;
}
// Identical SVG geometry is used for the preview and the export bitmap.
export const cursorPolygon = [
  [16, 16],
  [16, 48],
  [25, 40],
  [31, 54],
  [38, 51],
  [32, 37],
  [45, 36],
];
export const cursorPath =
  cursorPolygon.map((p, i) => (i ? "L " : "M ") + p.join(" ")).join(" ") + " Z";
// FFmpeg perspective numbers frames from 1. Use the same output-clock camera
// track as Canvas, including transitions that cross removed source footage.
function cropExpressions(edits, fps, cursor) {
  const num = (n) => Number(n.toFixed(10)).toString();
  const track = cameraTrack(edits, cursor);
  const { base, transitions } = track;
  const clock = `(on-1)/${fps}`;
  // A balanced lookup stays under FFmpeg's expression recursion limit even at
  // the maximum 80 sections, and evaluates only the active transition.
  const lookup = (parts) => {
    if (parts.length === 1) return parts[0].value;
    const split = Math.ceil(parts.length / 2);
    return `if(lt(${clock},${num(parts[split - 1].end)}),${lookup(parts.slice(0, split))},${lookup(parts.slice(split))})`;
  };
  const result = {};
  // Perspective has no runtime-command support. Compile the smooth camera path
  // to bounded cubic pieces instead. Adaptive fitting keeps error below 0.01
  // source pixels at 4K without embedding every captured cursor sample. A
  // balanced lookup evaluates just one piece per coordinate per output frame.
  const following = (start, end, key) => {
    const parts = [];
    const read = (t) => trackCropAt(track, t)[key];
    const slope = (t) => (read(t + 0.0001) - read(t - 0.0001)) / 0.0002;
    const fit = (a, b) => {
      const length = b - a,
        value = read(a),
        delta = read(b) - value;
      const m0 = slope(a) * length,
        m1 = slope(b) * length;
      const c = 3 * delta - 2 * m0 - m1,
        d = m0 + m1 - 2 * delta;
      const error = Math.max(
        ...[0.25, 0.5, 0.75].map((u) =>
          Math.abs(read(a + u * length) - (value + u * (m0 + u * (c + u * d)))),
        ),
      );
      if (error > 0.000002 && length > 1 / 480) {
        fit(a, (a + b) / 2);
        fit((a + b) / 2, b);
        return;
      }
      const u = `clip((${clock}-${num(a)})/${num(length)},0,1)`;
      parts.push({
        end: b,
        value: `${num(value)}+(${u})*(${num(m0)}+(${u})*(${num(c)}+(${u})*${num(d)}))`,
      });
    };
    const count = Math.ceil((end - start) / 0.25);
    for (let i = 0; i < count; i++)
      fit(
        start + ((end - start) * i) / count,
        start + ((end - start) * (i + 1)) / count,
      );
    return parts;
  };
  for (const key of ["x", "y", "size"]) {
    const parts = [];
    let previous = 0;
    for (const { start, end, from, to } of transitions) {
      const u = `clip((${clock}-${num(start)})/${num(end - start)},0,1)`;
      // Same easing as ease(), including endpoint symmetry.
      const v = `min(${u},1-(${u}))`;
      const half = `((${v})^4*(105+(${v})*(-504+(${v})*(1050+(${v})*(-1140+(${v})*(630-140*(${v})))))))`;
      const weight = `if(lt(${u},0.5),${half},1-(${half}))`;
      const size = `${num(from.size)}*exp(${num(Math.log(to.size / from.size))}*${weight})`;
      const progress =
        Math.abs(to.size - from.size) < 1e-7
          ? weight
          : `((${size})-${num(from.size)})/${num(to.size - from.size)}`;
      const value =
        key === "size"
          ? size
          : `${num(from[key])}+${num(to[key] - from[key])}*(${progress})`;
      if (key !== "size" && from.follow && start > previous)
        for (const part of following(previous, start, key)) parts.push(part);
      else parts.push({ end: start, value: num(from[key]) });
      if (key !== "size" && (from.follow || to.follow))
        for (const part of following(start, end, key)) parts.push(part);
      else parts.push({ end, value });
      previous = end;
    }
    parts.push({
      end: Infinity,
      value: num(transitions.at(-1)?.to[key] ?? base[key]),
    });
    result[key] = lookup(parts);
  }
  return result;
}
export function perspectiveFilter(edits, fps, cursor) {
  if (
    edits.style.zoom === 1 &&
    !(edits.zooms || []).some(
      (z) => z.zoom > 1 && sourceRanges(edits, z.start, z.end).length,
    )
  )
    return "null";
  const { x, y, size } = cropExpressions(edits, fps, cursor);
  return `perspective=x0='W*(${x})':y0='H*(${y})':x1='W*((${x})+(${size}))':y1='H*(${y})':x2='W*(${x})':y2='H*((${y})+(${size}))':x3='W*((${x})+(${size}))':y3='H*((${y})+(${size}))':sense=source:eval=frame:interpolation=cubic`;
}
