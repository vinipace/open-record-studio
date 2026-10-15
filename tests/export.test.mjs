import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
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
import { previewProject } from "../desktop/preview.mjs";
let root, ffmpeg, project;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-studio-test-"));
  ffmpeg = await binary("ffmpeg");
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:duration=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=6",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    path.join(root, "screen.mp4"),
  ]);
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x240:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=320x240:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=green:s=320x240:r=30:d=2",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "camera.mp4"),
  ]);
  project = {
    version: 1,
    kind: "frame-studio",
    name: "Test recording",
    duration: 6,
    directory: root,
    tracks: {
      screen: {
        ...(await probe(path.join(root, "screen.mp4"))),
        file: "screen.mp4",
        offset: 0,
      },
      camera: {
        ...(await probe(path.join(root, "camera.mp4"))),
        file: "camera.mp4",
        offset: 1,
      },
    },
    recording: {
      autoZoom: {
        click: false,
        typing: false,
        selection: false,
        scroll: false,
        drag: false,
      },
    },
    interactions: {
      version: 1,
      events: [
        { id: "click-1", type: "click", t: 2, end: 2, x: 0.3, y: 0.4 },
        { id: "typing-1", type: "typing", t: 3, end: 4, x: 0.3, y: 0.4 },
      ],
    },
    edits: {
      segments: [
        { start: 0.5, end: 1.5 },
        { start: 3, end: 5 },
      ],
      style: { ...defaults, speed: 1.5 },
    },
  };
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function pixel(file, time, point) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      (point
        ? `crop=2:2:trunc(iw*${point[0]}/2)*2:trunc(ih*${point[1]}/2)*2,`
        : "") + "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", reject);
    p.on("close", (c) =>
      c === 0
        ? resolve([...Buffer.concat(chunks)].slice(0, 3))
        : reject(new Error("Pixel extraction failed")),
    );
  });
}
test("separate and combined exports preserve shared cuts, speed, delayed camera, and audio routing", async () => {
  const progress = [];
  // A deliberate manual delay remains blank; capture startup latency is held.
  const delayed = {
    ...project,
    tracks: {
      ...project.tracks,
      camera: { ...project.tracks.camera, offset: 0 },
    },
    edits: {
      ...project.edits,
      style: { ...project.edits.style, cameraOffset: 1 },
    },
  };
  const result = await exportProject(
    delayed,
    delayed.edits,
    {
      mode: "both",
      height: 720,
      fps: 30,
      quality: "standard",
      audio: true,
      cameraAudio: false,
    },
    root,
    { onProgress: (p) => progress.push(p) },
  );
  assert.equal(result.files.length, 3);

  const files = Object.fromEntries(
    result.files.map((f) => [path.basename(f, ".mp4"), f]),
  );
  for (const file of result.files) {
    const meta = await probe(file);
    assert.ok(Math.abs(meta.duration - 2) < 0.08);
    assert.equal(meta.height, 720);
    assert.equal(meta.audio, !file.endsWith("camera.mp4"));
  }
  const black = await pixel(files.camera, 0.1),
    red = await pixel(files.camera, 0.5),
    blue = await pixel(files.camera, 1.2);
  assert.ok(
    Math.max(...black) < 15,
    `Delayed webcam should begin black: ${black}`,
  );
  assert.ok(
    red[0] > 180 && red[1] < 40 && red[2] < 40,
    `First retained camera segment should be red: ${red}`,
  );
  assert.ok(
    blue[2] > 180 && blue[0] < 40,
    `Second retained camera segment should be blue: ${blue}`,
  );
  assert.equal(progress.at(-1).ratio, 1);
  const manifest = JSON.parse(
    await fs.readFile(path.join(result.directory, "export.json")),
  );
  assert.deepEqual(manifest.edits.segments, project.edits.segments);
  assert.deepEqual(manifest.interactions.events, project.interactions.events);
  assert.equal(manifest.interactions.timebase, "source");
  assert.deepEqual(manifest.recording, project.recording);
});
test("capture startup holds the first webcam frame without advancing later frames across cuts", async () => {
  const captured = {
    ...project,
    tracks: {
      ...project.tracks,
      camera: { ...project.tracks.camera, offset: 0.29 },
    },
  };
  const edits = {
    segments: [
      { start: 0, end: 0.2 },
      { start: 2.1, end: 2.7 },
    ],
    style: { ...defaults, speed: 1.5 },
  };
  const result = await exportProject(
    captured,
    edits,
    { mode: "both", height: 720, fps: 60, audio: false },
    root,
  );
  const camera = result.files.find((f) => f.endsWith("camera.mp4"));
  for (const time of [0, 0.05, 0.15, 0.2]) {
    const color = await pixel(camera, time);
    assert.ok(
      color[0] > 180 && color[1] < 40 && color[2] < 40,
      `Expected held or still-synchronized red webcam at ${time}: ${color}`,
    );
  }
  const blue = await pixel(camera, 0.4);
  assert.ok(
    blue[2] > 180 && blue[0] < 40,
    `Expected blue after the original source transition: ${blue}`,
  );
  assert.ok(Math.abs((await probe(camera)).duration - 0.8 / 1.5) < 0.04);
  const combined = result.files.find((f) => f.endsWith("combined.mp4"));
  const composed = await pixel(combined, 0, [0.855, 0.74]);
  assert.ok(
    composed[0] > 180 && composed[1] < 40 && composed[2] < 40,
    `Composition must also start with the held webcam: ${composed}`,
  );
  // MCP previews use this same graph, including mixed capture/manual offsets.
  for (const [adjustment, time, black] of [
    [0, 0, false],
    [0.2, 0.1, true],
    [0.2, 0.25, false],
    [-0.15, 0, false],
  ]) {
    const preview = await previewProject(
      {
        ...captured,
        edits: {
          segments: [{ start: 0, end: 3 }],
          style: { ...defaults, cameraOffset: adjustment },
        },
      },
      { time, mode: "camera", height: 360 },
    );
    const file = path.join(root, "startup-preview.png");
    await fs.writeFile(file, preview.image);
    const color = await pixel(file, 0);
    assert.ok(
      black
        ? Math.max(...color) < 15
        : color[0] > 180 && color[1] < 40 && color[2] < 40,
      `Incorrect preview with adjustment ${adjustment} at ${time}: ${color}`,
    );
  }
});
test("negative camera offset keeps microphone audio in the separate webcam export", async () => {
  const edits = {
    segments: [{ start: 0, end: 1 }],
    style: { ...defaults, cameraOffset: -3 },
  };
  const result = await exportProject(
    {
      ...project,
      tracks: { ...project.tracks, microphone: { ...project.tracks.screen } },
    },
    edits,
    { mode: "separate", height: 720, fps: 30, audio: true, cameraAudio: true },
    root,
  );
  const camera = result.files.find((f) => f.endsWith("camera.mp4"));
  assert.equal((await probe(camera)).audio, true);
  const color = await pixel(camera, 0.25);
  assert.ok(
    color[2] > 180 && color[0] < 40,
    `Expected blue after -2s net offset: ${color}`,
  );
});
test("webcam roundness masks corners in exports and previews while separate camera stays full frame", async () => {
  const captured = {
    ...project,
    tracks: {
      ...project.tracks,
      camera: { ...project.tracks.camera, offset: 0 },
    },
  };
  for (const roundness of [0, 0.5, 1]) {
    const edits = {
      segments: [{ start: 0, end: 0.2 }],
      style: {
        ...defaults,
        padding: 0.2,
        background: "#102030",
        cameraCorner: "top-left",
        cameraSize: 0.2,
        cameraRoundness: roundness,
      },
    };
    const output = await exportProject(
      captured,
      edits,
      { mode: "both", height: 720, fps: 30, audio: false },
      root,
    );
    const combined = output.files.find((f) => f.endsWith("combined.mp4"));
    const preview = await previewProject(
      { ...captured, edits },
      { mode: "combined", time: 0, height: 720, fps: 30 },
    );
    const previewFile = path.join(root, "rounded-preview.png");
    await fs.writeFile(previewFile, preview.image);
    for (const file of [combined, previewFile]) {
      for (const [fraction, visible] of [
        [0.02, roundness === 0],
        [0.12, roundness < 1],
        [0.5, true],
      ]) {
        const point = [
          (45 + 256 * fraction) / 1280,
          (45 + 256 * fraction) / 720,
        ];
        const color = await pixel(file, 0, point);
        if (visible)
          assert.ok(
            color[0] > 180 && color[1] < 40 && color[2] < 40,
            `Roundness ${roundness} should retain webcam at ${fraction}: ${color}`,
          );
        else
          [16, 32, 48].forEach((value, i) =>
            assert.ok(
              Math.abs(color[i] - value) < 10,
              `Roundness ${roundness} should reveal backdrop at ${fraction}: ${color}`,
            ),
          );
      }
    }
    const camera = output.files.find((f) => f.endsWith("camera.mp4"));
    const corner = await pixel(camera, 0, [0.02, 0.02]);
    assert.ok(corner[0] > 180 && corner[1] < 40 && corner[2] < 40);
    assert.equal((await probe(camera)).width, 960);
  }
  const legacy = { ...defaults };
  delete legacy.cameraRoundness;
  for (const [cameraShape, expected] of [
    ["circle", 1],
    ["square", 0],
  ])
    assert.equal(
      validateEdits(
        { segments: [{ start: 0, end: 1 }], style: { ...legacy, cameraShape } },
        6,
      ).style.cameraRoundness,
      expected,
    );
  for (const value of [-0.01, 1.01, NaN])
    assert.throws(
      () =>
        validateEdits(
          {
            segments: [{ start: 0, end: 1 }],
            style: { ...defaults, cameraRoundness: value },
          },
          6,
        ),
      /cameraRoundness/,
    );
});
test("looping GIF exports preserve cuts, speed, separate tracks and omit audio", async () => {
  const result = await exportProject(
    project,
    project.edits,
    {
      format: "gif",
      mode: "both",
      height: 360,
      fps: 20,
      audio: true,
      cameraAudio: true,
    },
    root,
  );
  assert.equal(result.files.length, 3);
  for (const file of result.files) {
    assert.ok(file.endsWith(".gif"));
    const bytes = await fs.readFile(file);
    assert.equal(bytes.subarray(0, 6).toString(), "GIF89a");
    assert.ok(
      bytes.includes(Buffer.from("NETSCAPE2.0\x03\x01\x00\x00", "binary")),
      "GIF must loop forever",
    );
    const meta = await probe(file);
    assert.equal(meta.audio, false);
    assert.equal(meta.height, 360);
    assert.ok(Math.abs(meta.duration - 2) < 0.06);
    await run(ffmpeg, [
      "-v",
      "error",
      "-xerror",
      "-i",
      file,
      "-f",
      "null",
      "-",
    ]);
  }
  const camera = result.files.find((f) => f.endsWith("camera.gif"));
  const red = await pixel(camera, 0.1),
    blue = await pixel(camera, 1.2);
  assert.ok(red[0] > 180 && red[1] < 40 && red[2] < 40);
  assert.ok(blue[2] > 180 && blue[0] < 40);
  const manifest = JSON.parse(
    await fs.readFile(path.join(result.directory, "export.json")),
  );
  assert.equal(manifest.options.format, "gif");
  assert.equal(manifest.options.audio, false);
  assert.equal(manifest.options.cameraAudio, false);
  assert.deepEqual((await fs.readdir(result.directory)).sort(), [
    "camera.gif",
    "combined.gif",
    "export.json",
    "screen.gif",
  ]);
  await assert.rejects(
    () =>
      exportProject(
        project,
        project.edits,
        { format: "gif", mode: "combined", height: 2160, fps: 60 },
        root,
      ),
    /Invalid GIF/,
  );
});
test("cancelled export removes its partial output directory", async () => {
  const before = await fs.readdir(root);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    exportProject(
      project,
      project.edits,
      { mode: "both", height: 720, fps: 30, audio: true },
      root,
      { signal: controller.signal },
    ),
  );
  assert.deepEqual(await fs.readdir(root), before);
  // Abort after the GIF palette has been written, before its encoding pass.
  const gifController = new AbortController();
  await assert.rejects(() =>
    exportProject(
      project,
      project.edits,
      { format: "gif", mode: "combined", height: 360, fps: 20 },
      root,
      {
        signal: gifController.signal,
        onProgress: (p) => {
          if (p.ratio >= 0.4) gifController.abort();
        },
      },
    ),
  );
  assert.deepEqual(await fs.readdir(root), before);
});
test("invalid edits and project paths are rejected", async () => {
  assert.throws(() =>
    validateEdits({ segments: [{ start: 2, end: 1 }], style: defaults }, 6),
  );
  assert.throws(() =>
    validateEdits(
      {
        segments: [
          { start: 0, end: 4 },
          { start: 3, end: 5 },
        ],
        style: defaults,
      },
      6,
    ),
  );
  assert.throws(() =>
    validateEdits(
      { segments: [{ start: 0, end: 4 }], style: { ...defaults, zoom: NaN } },
      6,
    ),
  );
  await saveProject(project);
  const reopened = await readProject(root);
  assert.equal(reopened.tracks.screen.width, 640);
  const unsafe = {
    ...project,
    tracks: { screen: { ...project.tracks.screen, file: "../outside.mp4" } },
  };
  await saveProject(unsafe);
  await assert.rejects(() => readProject(root));
});
