import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  binary,
  run,
  probe,
  exportProject,
  exportArgs,
} from "../desktop/media.mjs";
import { normalizeExportOptions } from "../desktop/export-settings.mjs";
import { layersFixture } from "./layers-fixture.mjs";
const exec = promisify(execFile);

async function amplitudes(file, at) {
  const { stdout } = await exec(
    await binary("ffmpeg"),
    [
      "-v",
      "error",
      "-ss",
      String(at),
      "-i",
      file,
      "-t",
      "0.2",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 2e6 },
  );
  const count = stdout.length / 4;
  assert.ok(count > 5000, "export contains decoded audio samples");
  return [440, 880, 1320].map((frequency) => {
    let real = 0,
      imaginary = 0;
    for (let i = 0; i < count; i++) {
      const phase = (2 * Math.PI * frequency * i) / 48000;
      const sample = stdout.readFloatLE(i * 4);
      real += sample * Math.cos(phase);
      imaginary += sample * Math.sin(phase);
    }
    return (Math.hypot(real, imaginary) * 2) / count;
  });
}

test("separate files isolate system and microphone audio, including webcam takes, after cuts and speed changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-audio-routing-"));
  try {
    const { project, directory, video } = await layersFixture(root);
    const ffmpeg = await binary("ffmpeg");
    await run(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=4:sample_rate=48000",
      path.join(directory, "microphone.wav"),
    ]);
    await run(ffmpeg, [
      "-v",
      "error",
      "-i",
      video,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1320:duration=2:sample_rate=48000",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      path.join(directory, "take.mp4"),
    ]);
    project.tracks.microphone = {
      ...(await probe(path.join(directory, "microphone.wav"))),
      file: "microphone.wav",
      offset: 0.2,
    };
    project.assets = {
      take: {
        ...(await probe(path.join(directory, "take.mp4"))),
        file: "take.mp4",
        sourceKind: "video",
        name: "Webcam take",
        timeMap: [{ start: 0, end: 2, mediaStart: 0, rate: 1 }],
      },
    };
    project.edits = {
      ...project.edits,
      segments: [
        { start: 0.25, end: 1.75 },
        { start: 2.25, end: 3.75 },
      ],
      style: {
        ...project.edits.style,
        speed: 1.5,
        volume: 0.5,
        microphoneVolume: 0.6,
      },
      layers: [
        {
          id: "take",
          assetId: "take",
          start: 1,
          end: 3,
          mediaStart: 0,
          x: 0.8,
          y: 0.8,
          width: 0.2,
          opacity: 1,
          visible: true,
          volume: 0.7,
        },
      ],
    };
    // An old client's false cameraAudio flag must not silently discard the mic.
    const result = await exportProject(
      project,
      project.edits,
      {
        mode: "both",
        height: 720,
        fps: 30,
        audio: true,
        cameraAudio: false,
      },
      root,
    );
    const values = {};
    for (const name of ["screen", "camera", "combined"]) {
      const file = path.join(result.directory, `${name}.mp4`);
      const meta = await probe(file);
      assert.ok(Math.abs(meta.duration - 2) < 0.06);
      assert.equal(meta.audio, true);
      values[name] = await amplitudes(file, 0.7);
    }
    const [system, micLeak, takeLeak] = values.screen;
    assert.ok(
      system > 0.02 && system > 30 * micLeak && system > 30 * takeLeak,
      `screen must contain only system audio: ${values.screen}`,
    );
    const [systemLeak, microphone, take] = values.camera;
    assert.ok(
      microphone > 0.02 &&
        take > 0.02 &&
        Math.min(microphone, take) > 30 * systemLeak,
      `webcam must contain only microphones: ${values.camera}`,
    );
    assert.ok(
      values.combined.every((n) => n > 0.02),
      `combined keeps all sources: ${values.combined}`,
    );
    const afterTake = await amplitudes(
      path.join(result.directory, "camera.mp4"),
      1.8,
    );
    assert.ok(
      afterTake[1] > 0.02 && afterTake[2] < 0.001,
      "take audio ends at its timeline boundary",
    );

    const microphoneOnly = {
      ...project,
      tracks: {
        ...project.tracks,
        screen: { ...project.tracks.screen, audio: false },
      },
    };
    const noSystem = await exportProject(
      microphoneOnly,
      microphoneOnly.edits,
      { mode: "separate", height: 720, fps: 30, audio: true },
      root,
    );
    assert.equal(
      (await probe(path.join(noSystem.directory, "screen.mp4"))).audio,
      false,
      "never put microphone audio in a screen without system audio",
    );
    assert.equal(
      (await probe(path.join(noSystem.directory, "camera.mp4"))).audio,
      true,
    );

    // Enhancement keeps this same source selection and uses processed audio.
    for (const mode of ["screen", "camera", "combined"]) {
      const args = exportArgs(
        project,
        {
          ...project.edits,
          style: { ...project.edits.style, enhanceAudio: true },
        },
        { height: 720, fps: 30, audio: true },
        mode,
        "unused.mp4",
        undefined,
        {
          screen: "screen.flac",
          microphone: "microphone.flac",
          "asset-take": "take.flac",
        },
      );
      const graph = args[args.indexOf("-filter_complex") + 1];
      assert.equal(graph.includes("[3:a:0]"), mode !== "camera");
      assert.equal(graph.includes("[4:a:0]"), mode !== "screen");
      assert.equal(graph.includes("[5:a:0]"), mode !== "screen");
    }
    const silent = await exportProject(
      project,
      project.edits,
      {
        mode: "separate",
        height: 720,
        fps: 30,
        audio: false,
        cameraAudio: true,
      },
      root,
    );
    for (const file of silent.files)
      assert.equal((await probe(file)).audio, false);
    const gif = normalizeExportOptions({
      mode: "both",
      format: "gif",
      audio: true,
      cameraAudio: true,
    });
    assert.equal(gif.audio, false);
    assert.equal(gif.cameraAudio, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
