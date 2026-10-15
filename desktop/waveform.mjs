import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { binary } from "./media.mjs";

const sampleRate = 16000;
const maxBins = 120000;
const cache = new Map();

// Stream PCM into a bounded envelope; never load an entire recording into RAM.
// Preserve both channels so opposite-phase stereo cannot disappear in a mono mix.
export async function extractWaveform(file, duration, { signal } = {}) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400)
    throw new Error("Invalid waveform duration");
  signal?.throwIfAborted();
  const samplesPerBin = Math.max(
    160,
    Math.ceil((duration * sampleRate) / maxBins),
  );
  const step = samplesPerBin / sampleRate;
  const peaks = new Float32Array(Math.ceil(duration / step));
  const command = await binary("ffmpeg");
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        String(duration),
        "-ac",
        "2",
        "-ar",
        String(sampleRate),
        "-f",
        "f32le",
        "pipe:1",
      ],
      { signal, stdio: ["ignore", "pipe", "pipe"] },
    );
    let remainder = Buffer.alloc(0),
      samples = 0,
      maximum = 0,
      error,
      stderr = "";
    child.stdout.on("data", (chunk) => {
      const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
      const length = data.length - (data.length % 8);
      for (let i = 0; i < length; i += 8) {
        const peak = Math.min(
          1,
          Math.max(
            Math.abs(data.readFloatLE(i)),
            Math.abs(data.readFloatLE(i + 4)),
          ),
        );
        const bin = Math.floor(samples++ / samplesPerBin);
        if (bin < peaks.length && Number.isFinite(peak)) {
          peaks[bin] = Math.max(peaks[bin], peak);
          maximum = Math.max(maximum, peak);
        }
      }
      remainder = Buffer.from(data.subarray(length));
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-1500);
    });
    child.on("error", (cause) => {
      error = cause;
    });
    child.on("close", (code) => {
      if (error || code !== 0 || !samples)
        reject(
          error ||
            new Error(
              `Audio waveform unavailable: ${stderr || "No decoded audio"}`,
            ),
        );
      else resolve({ step, duration, peaks, maximum });
    });
  });
}

async function cachedWaveform(project, track, signal) {
  signal?.throwIfAborted();
  const file = path.join(project.directory, track.file);
  const info = await stat(file);
  const identity = `${file}:${info.size}:${info.mtimeMs}:${track.duration}`;
  let waveform = cache.get(identity);
  if (!waveform)
    waveform = await extractWaveform(file, track.duration, { signal });
  signal?.throwIfAborted();
  cache.delete(identity);
  cache.set(identity, waveform);
  while (cache.size > 24) cache.delete(cache.keys().next().value);
  return waveform;
}

export async function assetWaveform(project, id, { signal } = {}) {
  const asset = Object.hasOwn(project.assets || {}, id) && project.assets[id];
  if (!asset?.audio || !asset.timeMap)
    throw new Error("This webcam take has no recorded audio");
  return cachedWaveform(project, asset, signal);
}

export async function projectWaveforms(project, { signal } = {}) {
  const tracks = {};
  for (const key of ["screen", "microphone"]) {
    const track = project.tracks[key];
    if (!track?.audio) continue;
    tracks[key] = await cachedWaveform(project, track, signal);
  }
  return tracks;
}
