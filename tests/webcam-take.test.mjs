import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  layerDuration,
  layerSample,
  layerSpans,
  makeTakeMap,
  takeOutputSpans,
  validateTimeMap,
} from "../desktop/webcam-take.mjs";
import {
  binary,
  run,
  probe,
  readProject,
  saveProject,
  exportProject,
  validateEdits,
} from "../desktop/media.mjs";
import { previewProject } from "../desktop/preview.mjs";
import { layersFixture } from "./layers-fixture.mjs";
import { audioEnergy } from "./media-checks.mjs";

const exec = promisify(execFile);
const edits = {
  segments: [
    { start: 0, end: 4 },
    { start: 8, end: 12 },
  ],
  style: { speed: 2 },
};
const timing = makeTakeMap(
  edits,
  [
    { output: 1, media: 0.3 },
    { output: 3, media: 2.3 },
  ],
  2.4,
);
const asset = { sourceKind: "video", duration: 2.4, timeMap: timing.timeMap };
const layer = {
  id: "take",
  assetId: "take",
  start: timing.start,
  end: timing.end,
  mediaStart: 0,
  x: 0.5,
  y: 0.5,
  width: 0.2,
  visible: true,
  opacity: 1,
  roundness: 0.5,
  volume: 1,
  flip: false,
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.0001, `${a} != ${b}`);

test("webcam timing anchors at the playhead and follows cuts and speed", () => {
  assert.equal(timing.start, 2);
  assert.equal(timing.end, 10);
  assert.equal(layerDuration(asset), 8);
  near(layerSample(layer, asset, 3).time, 0.8);
  near(layerSample(layer, asset, 9).time, 1.8);
  assert.equal(layerSample(layer, asset, 5), null);
  assert.equal(layerSample(layer, asset, 10), null);
  assert.deepEqual(
    layerSpans(layer, asset).map((s) => [s.start, s.end]),
    [
      [2, 4],
      [8, 10],
    ],
  );
  const spans = takeOutputSpans(edits, layer, asset);
  assert.deepEqual(
    spans.map((s) => [s.start, s.end]),
    [
      [1, 2],
      [2, 3],
    ],
  );
  spans.forEach((s) => near(s.rate, 1));
  const trimmed = { ...layer, start: 3, end: 9, mediaStart: 1 };
  near(layerSample(trimmed, asset, 3).time, 0.8);
  const moved = { ...trimmed, start: 4, end: 10 };
  near(layerSample(moved, asset, 4).time, 0.8);
  const slowed = takeOutputSpans(
    { ...edits, style: { speed: 1 } },
    layer,
    asset,
  );
  slowed.forEach((s) => near(s.rate, 0.5));
  assert.deepEqual(
    slowed.map((s) => [s.start, s.end]),
    [
      [2, 4],
      [4, 6],
    ],
  );
});

test("webcam timing trims startup delay and a stalled playback clock", () => {
  const recorded = makeTakeMap(
    { segments: [{ start: 0, end: 6 }], style: { speed: 1 } },
    [
      { output: 1, media: 0.4 },
      { output: 2, media: 1.4 },
      { output: 2, media: 2.4 },
      { output: 3, media: 3.4 },
    ],
    3.5,
  );
  const l = { ...layer, ...recorded, mediaStart: 0 };
  const a = { ...asset, duration: 3.5, timeMap: recorded.timeMap };
  near(layerSample(l, a, 1).time, 0.4);
  near(layerSample(l, a, 1.9).time, 1.3);
  near(layerSample(l, a, 2).time, 2.4);
  near(layerSample(l, a, 2.5).time, 2.9);
  assert.throws(() => makeTakeMap(edits, [], 2), /enough playback/);
  assert.throws(
    () =>
      makeTakeMap(
        edits,
        [
          { output: 2, media: 1 },
          { output: 1, media: 2 },
        ],
        2,
      ),
    /clock/,
  );
  assert.throws(
    () => validateTimeMap([{ start: -1, end: 1, mediaStart: 0, rate: 1 }], 3),
    /timing/,
  );
  assert.throws(
    () => validateTimeMap([{ start: 0, end: 2, mediaStart: 1, rate: 2 }], 3),
    /timing/,
  );
});

test(
  "webcam take persists and exports synchronized picture and microphone with cuts",
  { timeout: 120000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-webcam-take-"));
    let stage = "fixture";
    try {
      const { project: p, directory } = await layersFixture(root);
      const ffmpeg = await binary("ffmpeg");
      const file = path.join(directory, "take.mkv");
      stage = "generated take";
      // Same codecs/container as a captured take: blue on the left, red on the right.
      await run(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=160x120:r=30:d=4,drawbox=x=80:y=0:w=80:h=120:color=red:t=fill",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=4:sample_rate=48000",
        "-c:v",
        "libvpx",
        "-deadline",
        "realtime",
        "-c:a",
        "libopus",
        "-shortest",
        file,
      ]);
      p.edits.segments = [
        { start: 0, end: 1.5 },
        { start: 2.5, end: 4 },
      ];
      p.edits.style.speed = 0.5;
      p.edits.style.volume = 0;
      const map = makeTakeMap(
        p.edits,
        [
          { output: 1, media: 0.3 },
          { output: 4.5, media: 3.8 },
        ],
        (await probe(file)).duration,
      );
      p.assets = {
        take: {
          file: "take.mkv",
          sourceKind: "video",
          name: "Webcam take 1",
          timeMap: map.timeMap,
        },
      };
      p.edits.layers = [
        { ...layer, start: map.start, end: map.end, flip: true },
      ];
      // Removing the original audio must not remove the replacement microphone take.
      p.edits.removedAudio = [{ start: 0, end: 4 }];
      await saveProject(p);
      const reopened = await readProject(directory);
      assert.equal(reopened.assets.take.audio, true);
      assert.deepEqual(reopened.assets.take.timeMap, map.timeMap);
      assert.deepEqual(reopened.edits.layers, p.edits.layers);
      assert.throws(() =>
        validateEdits(
          {
            ...reopened.edits,
            layers: [{ ...reopened.edits.layers[0], roundness: 2 }],
          },
          4,
          reopened.assets,
        ),
      );
      const pixel = async (file, time, x, y) => {
        const { stdout } = await exec(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            file,
            "-ss",
            String(time),
            "-frames:v",
            "1",
            "-vf",
            "scale=640:360",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { encoding: "buffer", maxBuffer: 1024 * 1024 },
        );
        const offset = (Math.floor(y * 360) * 640 + Math.floor(x * 640)) * 3;
        return [...stdout.subarray(offset, offset + 3)];
      };
      const color = async (file, time, x, y, expected) => {
        const actual = await pixel(file, time, x, y);
        assert.equal(actual.length, 3);
        expected.forEach((c, i) =>
          assert.ok(Math.abs(c - actual[i]) < 20, `${actual} != ${expected}`),
        );
      };
      stage = "preview";
      const preview = await previewProject(reopened, {
        time: 3.5,
        height: 360,
        fps: 30,
      });
      const png = path.join(root, "take-preview.png");
      await fs.writeFile(png, preview.image);
      await color(png, 0, 0.45, 0.5, [255, 0, 0]); // flipped
      await color(png, 0, 0.55, 0.5, [0, 0, 255]);
      await color(png, 0, 0.403, 0.325, [0, 255, 0]); // rounded corner
      stage = "export";
      const result = await exportProject(
        reopened,
        reopened.edits,
        { format: "mp4", mode: "combined", height: 720, fps: 30, audio: true },
        root,
      );
      const output = path.join(result.directory, "combined.mp4");
      assert.ok(Math.abs((await probe(output)).duration - 6) < 0.06);
      await color(output, 0.5, 0.45, 0.5, [0, 255, 0]);
      await color(output, 1.5, 0.45, 0.5, [255, 0, 0]);
      await color(output, 3.5, 0.55, 0.5, [0, 0, 255]);
      await color(output, 5, 0.45, 0.5, [0, 255, 0]);
      assert.ok((await audioEnergy(output, 0.3)) < 0.001);
      assert.ok((await audioEnergy(output, 1.4)) > 0.01);
      assert.ok((await audioEnergy(output, 3.5)) > 0.01);
      assert.ok((await audioEnergy(output, 5)) < 0.001);
      // A cut containing only a gap in the take must render without a stuck frame.
      stage = "gap preview";
      reopened.edits.segments = [{ start: 1.75, end: 2.25 }];
      const gap = await previewProject(reopened, {
        time: 0.3,
        height: 360,
        fps: 30,
      });
      await fs.writeFile(png, gap.image);
      await color(png, 0, 0.5, 0.5, [0, 255, 0]);
    } catch (error) {
      throw new Error(`${stage}: ${error.message}`, { cause: error });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
