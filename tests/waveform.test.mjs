import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { binary, run } from "../desktop/media.mjs";
import {
  assetWaveform,
  extractWaveform,
  projectWaveforms,
} from "../desktop/waveform.mjs";

test("waveform peaks preserve silence, timed transients and opposite-phase stereo with bounded storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-waveform-"));
  try {
    const file = path.join(root, "stereo.wav");
    const tone = "if(between(t,1,2),0.6*sin(2*PI*440*t),0)";
    await run(await binary("ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='${tone}|-(${tone})':s=48000:d=4`,
      "-c:a",
      "pcm_f32le",
      file,
    ]);
    const waveform = await extractWaveform(file, 4);
    assert.equal(waveform.step, 0.01);
    assert.equal(waveform.peaks.length, 400);
    assert.ok(waveform.maximum > 0.59, "stereo channels must not cancel");
    for (const time of [0.5, 2.5, 3.5])
      assert.ok(waveform.peaks[Math.floor(time / waveform.step)] < 0.0001);
    for (const time of [1.1, 1.5, 1.9])
      assert.ok(waveform.peaks[Math.floor(time / waveform.step)] > 0.59);
    const long = await extractWaveform(file, 86400);
    assert.ok(
      long.peaks.length <= 120000,
      "one-day files keep bounded peak storage",
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      extractWaveform(file, 4, { signal: controller.signal }),
      { name: "AbortError" },
    );
    await assert.rejects(
      extractWaveform(path.join(root, "missing.wav"), 4),
      /unavailable/,
    );
    const project = {
      directory: root,
      tracks: {
        screen: { file: "stereo.wav", duration: 4, audio: true },
        camera: { file: "stereo.wav", duration: 4, audio: true },
        microphone: { file: "stereo.wav", duration: 4, audio: true },
      },
    };
    const tracks = await projectWaveforms(project);
    assert.deepEqual(Object.keys(tracks), ["screen", "microphone"]);
    assert.equal(tracks.screen, tracks.microphone);
    assert.equal((await projectWaveforms(project)).screen, tracks.screen);
    project.assets = {
      take: {
        file: "stereo.wav",
        duration: 4,
        audio: true,
        timeMap: [{ start: 0, end: 3, mediaStart: 1, rate: 1 }],
      },
      silent: { file: "stereo.wav", duration: 4, audio: false, timeMap: [] },
      imported: { file: "stereo.wav", duration: 4, audio: true },
    };
    assert.equal(
      await assetWaveform(project, "take"),
      tracks.screen,
      "take audio uses the shared source cache without decoding twice",
    );
    for (const id of ["missing", "silent", "imported", "__proto__"])
      await assert.rejects(assetWaveform(project, id), /no recorded audio/);
    await assert.rejects(
      assetWaveform(project, "take", { signal: controller.signal }),
      { name: "AbortError" },
    );
    await run(await binary("ffmpeg"), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo:d=4",
      "-c:a",
      "pcm_f32le",
      file,
    ]);
    assert.equal(
      (await projectWaveforms(project)).screen.maximum,
      0,
      "changed media invalidates its cached waveform",
    );
    assert.equal((await assetWaveform(project, "take")).maximum, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
