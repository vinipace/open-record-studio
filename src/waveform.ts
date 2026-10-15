import type { Edits, Project, TakeSpan } from "./types";

export type Waveform = {
  step: number;
  duration: number;
  peaks: Float32Array;
  maximum: number;
};
export type WaveformTracks = Partial<Record<"screen" | "microphone", Waveform>>;
export type WaveformState = {
  status: "loading" | "ready" | "error";
  tracks: WaveformTracks;
};

function peakBetween(waveform: Waveform, start: number, end: number) {
  if (end <= 0 || start >= waveform.duration) return 0;
  const first = Math.max(0, Math.floor(start / waveform.step));
  const last = Math.min(waveform.peaks.length, Math.ceil(end / waveform.step));
  let peak = 0;
  for (let i = first; i < last; i++) peak = Math.max(peak, waveform.peaks[i]);
  return peak;
}

// Spans map the edited output clock to the recorded microphone clock. Keeping
// this mapping preserves silence/gaps, capture stalls, cuts and playback speed.
export function drawTakeWaveform(
  canvas: HTMLCanvasElement,
  waveform: Waveform,
  spans: TakeSpan[],
  start: number,
  end: number,
  width: number,
  gain: number,
) {
  const height = 26;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  width = Math.max(1, width);
  canvas.width = Math.min(8192, Math.max(1, Math.round(width * ratio)));
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(canvas.width / width, ratio);
  ctx.fillStyle = "#e7be7238";
  ctx.fillRect(0, height / 2 - 0.35, width, 0.7);
  ctx.fillStyle = "#ffe0a0";
  const bars = Math.max(1, Math.min(2400, Math.ceil(width / 3)));
  let first = 0;
  for (let i = 0; i < bars; i++) {
    const from = start + ((end - start) * i) / bars;
    const to = start + ((end - start) * (i + 1)) / bars;
    while (first < spans.length && spans[first].end <= from) first++;
    let peak = 0;
    for (let j = first; j < spans.length && spans[j].start < to; j++) {
      const span = spans[j];
      peak = Math.max(
        peak,
        peakBetween(
          waveform,
          span.mediaStart +
            (Math.max(from, span.start) - span.start) * span.rate,
          span.mediaStart + (Math.min(to, span.end) - span.start) * span.rate,
        ),
      );
    }
    peak *= gain;
    if (peak < 0.00001) continue;
    const amplitude =
      Math.pow(Math.min(1, peak / Math.max(0.1, waveform.maximum)), 0.6) *
      (height / 2 - 1);
    ctx.fillRect(
      (i * width) / bars,
      height / 2 - amplitude,
      Math.max(0.5, width / bars - 1),
      Math.max(1, amplitude * 2),
    );
  }
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  waveforms: WaveformTracks,
  project: Project,
  edits: Edits,
  start: number,
  end: number,
  width: number,
) {
  const keys = (["screen", "microphone"] as const).filter(
    (key) => waveforms[key],
  );
  const height = 26;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.min(8192, Math.max(1, Math.round(width * pixelRatio)));
  canvas.height = height * pixelRatio;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(canvas.width / width, pixelRatio);
  const bars = Math.max(1, Math.min(2400, Math.ceil(width / 3)));
  for (const [row, key] of keys.entries()) {
    const waveform = waveforms[key]!;
    const track = project.tracks[key]!;
    const gain =
      key === "screen" ? edits.style.volume : edits.style.microphoneVolume;
    const band = height / keys.length;
    const middle = (row + 0.5) * band;
    ctx.fillStyle = "#e7be7238";
    ctx.fillRect(0, middle - 0.35, width, 0.7);
    ctx.fillStyle = key === "microphone" ? "#ffe0a0" : "#e4b868";
    for (let i = 0; i < bars; i++) {
      const from = start + ((end - start) * i) / bars - track.offset;
      const to = start + ((end - start) * (i + 1)) / bars - track.offset;
      const peak = peakBetween(waveform, from, to) * gain;
      if (peak < 0.00001) continue;
      const amplitude =
        Math.pow(Math.min(1, peak / Math.max(0.1, waveform.maximum)), 0.6) *
        (band / 2 - 1);
      ctx.fillRect(
        (i * width) / bars,
        middle - amplitude,
        Math.max(0.5, width / bars - 1),
        Math.max(1, amplitude * 2),
      );
    }
  }
}
