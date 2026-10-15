// A recorded take follows the source clips that actually played, including cuts,
// speed changes and decoder stalls. Offsets are relative to the take's source start.
export function validateTimeMap(map, duration) {
  if (map === undefined) return undefined;
  if (!Array.isArray(map) || !map.length || map.length > 4096)
    throw new Error("Invalid webcam timing map");
  let end = 0;
  return map.map((s) => {
    if (
      !s ||
      ![s.start, s.end, s.mediaStart, s.rate].every(Number.isFinite) ||
      s.start < 0 ||
      s.start < end ||
      s.end <= s.start ||
      s.end > 86400 ||
      s.mediaStart < 0 ||
      s.rate < 0.01 ||
      s.rate > 100 ||
      s.mediaStart + (s.end - s.start) * s.rate > duration + 0.05
    )
      throw new Error("Invalid webcam timing map");
    end = s.end;
    return {
      start: s.start,
      end: s.end,
      mediaStart: s.mediaStart,
      rate: s.rate,
    };
  });
}
export const layerDuration = (asset) =>
  asset.timeMap?.at(-1)?.end ?? asset.duration;
export function layerSpans(layer, asset) {
  const map = asset.timeMap || [
    {
      start: 0,
      end: asset.sourceKind === "image" ? 86400 : asset.duration,
      mediaStart: 0,
      rate: 1,
    },
  ];
  return map.flatMap((s) => {
    const origin = layer.start - layer.mediaStart + s.start;
    const start = Math.max(layer.start, origin),
      end = Math.min(layer.end, origin + s.end - s.start);
    return end > start
      ? [
          {
            start,
            end,
            mediaStart: s.mediaStart + (start - origin) * s.rate,
            rate: s.rate,
          },
        ]
      : [];
  });
}
export function layerSample(layer, asset, source) {
  const virtual = source - layer.start + layer.mediaStart;
  if (source < layer.start || source >= layer.end) return null;
  if (!asset.timeMap) return { time: virtual, rate: 1 };
  const span = asset.timeMap.find((s) => virtual >= s.start && virtual < s.end);
  return span
    ? {
        time: span.mediaStart + (virtual - span.start) * span.rate,
        rate: span.rate,
      }
    : null;
}
export function makeTakeMap(edits, samples, duration) {
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 1000000)
    throw new Error("The recording did not cover enough playback time");
  let previous = { output: -1, media: -1 };
  for (const s of samples) {
    if (
      !s ||
      ![s.output, s.media].every(Number.isFinite) ||
      s.output < 0 ||
      s.output < previous.output ||
      s.media < previous.media ||
      s.media < 0 ||
      s.media > duration + 0.1
    )
      throw new Error("Invalid recording clock");
    previous = s;
  }
  // Simplify the measured playback clock to within 20 ms, while preserving stalls.
  const points = [samples[0]];
  let first = 0;
  for (let last = 2; last < samples.length; last++) {
    const a = samples[first],
      b = samples[last];
    const rate = (b.media - a.media) / (b.output - a.output);
    let error = 0;
    for (let i = first + 1; i < last; i++)
      error = Math.max(
        error,
        Math.abs(
          a.media + (samples[i].output - a.output) * rate - samples[i].media,
        ),
      );
    if (!Number.isFinite(rate) || error > 0.02 || last - first > 600) {
      points.push(samples[last - 1]);
      first = last - 1;
    }
  }
  points.push(samples.at(-1));
  const spans = [];
  let output = 0;
  for (const segment of edits.segments) {
    const length = (segment.end - segment.start) / edits.style.speed;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      const start = Math.max(output, a.output),
        end = Math.min(output + length, b.output);
      if (end - start < 0.00001 || b.output <= a.output || b.media <= a.media)
        continue;
      const rate = (b.media - a.media) / (b.output - a.output);
      const mediaStart = a.media + (start - a.output) * rate;
      const boundedEnd = Math.min(end, start + (duration - mediaStart) / rate);
      if (boundedEnd <= start) continue;
      spans.push({
        start: segment.start + (start - output) * edits.style.speed,
        end: segment.start + (boundedEnd - output) * edits.style.speed,
        mediaStart,
        rate: rate / edits.style.speed,
      });
    }
    output += length;
  }
  if (!spans.length || spans.at(-1).end - spans[0].start < 0.05)
    throw new Error("Record at least a moment of video playback");
  const start = spans[0].start,
    end = spans.at(-1).end;
  return {
    start,
    end,
    timeMap: validateTimeMap(
      spans.map((s) => ({ ...s, start: s.start - start, end: s.end - start })),
      duration,
    ),
  };
}
export function takeOutputSpans(edits, layer, asset) {
  const result = [];
  let output = 0;
  for (const clip of edits.segments) {
    for (const span of layerSpans(layer, asset)) {
      const start = Math.max(clip.start, span.start),
        end = Math.min(clip.end, span.end);
      if (end <= start) continue;
      result.push({
        start: output + (start - clip.start) / edits.style.speed,
        end: output + (end - clip.start) / edits.style.speed,
        mediaStart: span.mediaStart + (start - span.start) * span.rate,
        rate: span.rate * edits.style.speed,
      });
    }
    output += (clip.end - clip.start) / edits.style.speed;
  }
  return result;
}
