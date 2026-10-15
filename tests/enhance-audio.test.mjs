import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  enhanceProjectAudio,
  enhancementSources,
} from "../desktop/enhance-audio.mjs";
import {
  binary,
  defaults,
  exportProject,
  probe,
  readProject,
  run,
  saveProject,
  validateEdits,
} from "../desktop/media.mjs";
import { editOperations, styleFields } from "../mcp/edits.mjs";

const exec = promisify(execFile);
let root, ffmpeg, project, enhanced, originalHash;
const sha = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-enhance-audio-"));
  process.env.FRAME_AUDIO_CACHE = path.join(root, "cache");
  ffmpeg = await binary("ffmpeg");
  await exec("/usr/bin/say", [
    "-r",
    "150",
    "-o",
    path.join(root, "voice.aiff"),
    "This recording should keep my voice clear while removing the background noise.",
  ]);
  await run(ffmpeg, [
    "-v",
    "error",
    "-i",
    path.join(root, "voice.aiff"),
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=sample_rate=48000:amplitude=0.025:duration=8:seed=42",
    "-filter_complex",
    "[0:a]aresample=48000,adelay=2000,apad,atrim=duration=8[voice];[voice][1:a]amix=inputs=2:normalize=0[a]",
    "-map",
    "[a]",
    "-c:a",
    "pcm_s16le",
    path.join(root, "microphone.wav"),
  ]);
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=30:d=8",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    path.join(root, "screen.mp4"),
  ]);
  project = {
    version: 1,
    kind: "frame-studio",
    name: "Enhance audio test",
    directory: root,
    duration: 8,
    tracks: {
      screen: {
        ...(await probe(path.join(root, "screen.mp4"))),
        file: "screen.mp4",
        offset: 0,
      },
      microphone: {
        ...(await probe(path.join(root, "microphone.wav"))),
        file: "microphone.wav",
        offset: 0.2,
      },
    },
    edits: {
      segments: [{ start: 0, end: 8 }],
      style: { ...defaults, enhanceAudio: true, showCursor: false },
    },
  };
  originalHash = await sha(path.join(root, "microphone.wav"));
  enhanced = await enhanceProjectAudio(project);
});
after(async () => {
  delete process.env.FRAME_AUDIO_CACHE;
  await fs.rm(root, { recursive: true, force: true });
});

async function pcm(file, filters) {
  const { stdout } = await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      file,
      ...(filters ? ["-af", filters] : []),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 8e6 },
  );
  return new Float32Array(
    stdout.buffer.slice(
      stdout.byteOffset,
      stdout.byteOffset + stdout.byteLength,
    ),
  );
}
const rms = (data, start, end) => {
  const samples = data.subarray(
    Math.round(start * 48000),
    Math.round(end * 48000),
  );
  return Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
};

test("bundled RNN suppresses steady noise, retains speech and exact source duration", async () => {
  const [dry, wet] = await Promise.all([
    pcm(path.join(root, "microphone.wav")),
    pcm(enhanced.microphone),
  ]);
  assert.equal(
    wet.length,
    dry.length,
    "Filtering must not shift or extend the timeline",
  );
  const noiseRatio = rms(wet, 0.5, 1.5) / rms(dry, 0.5, 1.5);
  const voiceRatio = rms(wet, 2.5, 6.5) / rms(dry, 2.5, 6.5);
  console.log(
    JSON.stringify({
      noiseReductionDb: -20 * Math.log10(noiseRatio),
      voiceRmsRatio: voiceRatio,
      samples: wet.length,
    }),
  );
  assert(
    noiseRatio < 0.25,
    "At least 12 dB noise reduction in the synthetic fixture",
  );
  assert(voiceRatio > 0.2, "Speech must remain audible");
  assert.equal(await sha(path.join(root, "microphone.wav")), originalHash);
});

test("cache reuses completed audio, invalidates changed sources and cancels cleanly", async () => {
  const before = await fs.stat(enhanced.microphone);
  assert.deepEqual(await enhanceProjectAudio(project), enhanced);
  assert.equal((await fs.stat(enhanced.microphone)).mtimeMs, before.mtimeMs);
  const source = path.join(root, "microphone.wav");
  const info = await fs.stat(source);
  await fs.utimes(source, info.atime, new Date(info.mtimeMs + 2000));
  const next = await enhanceProjectAudio(project);
  assert.notEqual(next.microphone, enhanced.microphone);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    enhanceProjectAudio(project, { signal: controller.signal }),
    /abort/i,
  );
  const cacheFiles = await fs.readdir(process.env.FRAME_AUDIO_CACHE);
  assert(
    cacheFiles.every((file) => /^[a-f0-9]{64}\.(flac|rnnn)$/.test(file)),
    "No partial cache files",
  );
  const cancelling = new AbortController();
  const cancelledCache = path.join(root, "cancelled-cache");
  await assert.rejects(enhanceProjectAudio(project, {
    cacheRoot: cancelledCache,
    signal: cancelling.signal,
    onProgress: () => cancelling.abort(),
  }), /abort|cancel/i);
  assert((await fs.readdir(cancelledCache)).every(file => file.endsWith(".rnnn")), "Cancellation removes partially written audio");
});

test("saved option and MCP update support old projects without changing originals", async () => {
  const legacy = { ...defaults };
  delete legacy.enhanceAudio;
  assert.equal(
    validateEdits({ segments: [{ start: 0, end: 8 }], style: legacy }, 8).style
      .enhanceAudio,
    false,
  );
  assert.throws(() => styleFields.enhanceAudio.parse("true"));
  assert.throws(() =>
    validateEdits(
      { ...project.edits, style: { ...defaults, enhanceAudio: "yes" } },
      8,
    ),
  );
  editOperations.update_style.apply(project, {
    changes: { enhanceAudio: true },
  });
  await saveProject(project);
  assert.equal((await readProject(root)).edits.style.enhanceAudio, true);
  assert.equal(await sha(path.join(root, "microphone.wav")), originalHash);
  const take = {
    ...project.tracks.microphone,
    timeMap: [{ start: 0, end: 8, mediaStart: 0, rate: 1 }],
  };
  assert.deepEqual(
    Object.keys(
      enhancementSources({
        ...project,
        assets: { take, muted: { ...take, timeMap: undefined } },
      }),
    ),
    ["microphone", "asset-take"],
  );
});

test("enhanced export uses cached source with cuts, offset, speed and mute ranges", async () => {
  const edits = {
    ...project.edits,
    segments: [
      { start: 1.5, end: 3.5 },
      { start: 4.5, end: 6.5 },
    ],
    style: { ...project.edits.style, speed: 1.25 },
  };
  const result = await exportProject(
    project,
    edits,
    { mode: "combined", height: 720, fps: 30, audio: true },
    root,
  );
  const file = result.files[0];
  const meta = await probe(file);
  assert(meta.audio);
  assert(Math.abs(meta.duration - 3.2) < 0.04);
  // Independently build the expected edited audio from the same cached source.
  const { stdout } = await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      enhanced.microphone,
      "-filter_complex",
      "[0:a]asplit=2[a][b];[a]atrim=start=1.3:end=3.3,asetpts=PTS-STARTPTS,atempo=1.25[c];[b]atrim=start=4.3:end=6.3,asetpts=PTS-STARTPTS,atempo=1.25[d];[c][d]concat=n=2:v=0:a=1[out]",
      "-map",
      "[out]",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 8e6 },
  );
  const expected = new Float32Array(
      stdout.buffer.slice(
        stdout.byteOffset,
        stdout.byteOffset + stdout.byteLength,
      ),
    ),
    actual = await pcm(file);
  let xy = 0,
    xx = 0,
    yy = 0;
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
    xy += actual[i] * expected[i];
    xx += actual[i] ** 2;
    yy += expected[i] ** 2;
  }
  const correlation = xy / Math.sqrt(xx * yy);
  assert(
    correlation > 0.95,
    `Preview source/export timing mismatch: ${correlation}`,
  );
  const muted = await exportProject(
    project,
    { ...edits, removedAudio: [{ start: 0, end: 8 }] },
    { mode: "combined", height: 720, fps: 30, audio: true },
    root,
  );
  assert(rms(await pcm(muted.files[0]), 0, 3) < 0.00001);
});
