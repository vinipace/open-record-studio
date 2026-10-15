import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  defaults,
  validateEdits,
  validateCursor,
  exportProject,
  run,
  binary,
  probe,
} from "../desktop/media.mjs";
import {
  sourceAt,
  zoomAt,
  cropAt,
  cursorAt,
  sourceRanges,
  perspectiveFilter,
  ease,
  defaultZoomEase,
} from "../desktop/motion.mjs";
import { edits, samples, cursor, motionFixture } from "./motion-fixture.mjs";
test("zoom entry and exit settle without jerk or overshoot with a 0.6-second default", async () => {
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
  assert.equal(ease(0.5), 0.5);
  for (let i = 1; i <= 1000; i++) {
    const t = i / 1000;
    assert.ok(ease(t) >= ease(t - 0.001), "no bounce or overshoot");
    assert.ok(Math.abs(ease(t) + ease(1 - t) - 1) < 1e-14);
  }
  // A fourth-order departure makes the first three derivatives zero at rest.
  // The old quintic departs cubically (ratio ~8) and fails this assertion.
  const h = 0.002;
  const entryRatio = ease(2 * h) / ease(h);
  const exitRatio = (1 - ease(1 - 2 * h)) / (1 - ease(1 - h));
  for (const ratio of [entryRatio, exitRatio]) {
    assert.ok(ratio > 15.8 && ratio < 16, `endpoint convergence: ${ratio}`);
  }
  const motion = {
    style: { ...defaults },
    segments: [{ start: 0, end: 5 }],
    zooms: [
      {
        id: "gentle",
        start: 0.5,
        end: 4.5,
        zoom: 3,
        focusX: 0.8,
        focusY: 0.2,
        ease: defaultZoomEase,
      },
    ],
  };
  const oldEase = (t) => t ** 3 * (t * (t * 6 - 15) + 10);
  const dt = 1 / 6000;
  const peakSpeed = (fn, duration) =>
    Math.max(
      ...Array.from(
        { length: Math.ceil(duration / dt) },
        (_, i) => (fn(Math.min(duration, (i + 1) * dt)) - fn(i * dt)) / dt,
      ),
    );
  const peak = peakSpeed(
    (t) => Math.log(zoomAt(motion, 0.5 + t).zoom),
    defaultZoomEase,
  );
  const oldPeak = peakSpeed((t) => Math.log(3) * oldEase(t / 0.8), 0.8);
  assert.equal(defaultZoomEase, 0.6);
  assert.ok(Math.abs(zoomAt(motion, 0.8).zoom - Math.sqrt(3)) < 1e-12);
  assert.equal(zoomAt(motion, 1.1).zoom, 3);
  for (let i = 0; i <= 120; i++) {
    const t = (defaultZoomEase * i) / 120;
    const entering = zoomAt(motion, 0.5 + t).zoom;
    const leaving = zoomAt(motion, 4.5 - t).zoom;
    assert.ok(entering >= 1 && entering <= 3 + 1e-12);
    assert.ok(
      Math.abs(entering - leaving) < 1e-12,
      "entry and exit use the same timing",
    );
  }
  motion.zooms[0].ease = 0.8;
  const savedDurationPeak = peakSpeed(
    (t) => Math.log(zoomAt(motion, 0.5 + t).zoom),
    0.8,
  );
  assert.ok(
    savedDurationPeak < oldPeak * 0.9,
    "existing durations also avoid rushing through the middle",
  );
  // Speed and cuts change the hold, not the requested output-time easing.
  motion.style.speed = 2;
  motion.segments = [
    { start: 0, end: 2.5 },
    { start: 3, end: 5 },
  ];
  motion.zooms[0].ease = 0.4;
  assert.ok(Math.abs(zoomAt(motion, 0.25 + 0.2).zoom - Math.sqrt(3)) < 1e-12);
  assert.equal(zoomAt(motion, 0.25).zoom, 1);
  assert.equal(zoomAt(motion, 2).zoom, 1);
  await fs.mkdir("evidence/motion", { recursive: true });
  await fs.writeFile(
    "evidence/motion/easing-check.json",
    JSON.stringify(
      {
        defaultTransitionSeconds: defaultZoomEase,
        entryEndpointOrder: Math.log2(entryRatio),
        exitEndpointOrder: Math.log2(exitRatio),
        peakLogMagnificationSpeed: peak,
        previousDefaultPeakSpeed: oldPeak,
        peakSpeedReductionPercent: (1 - peak / oldPeak) * 100,
        sameDurationPeakSpeedReductionPercent:
          (1 - savedDurationPeak / oldPeak) * 100,
        symmetricEntryExit: true,
        overshoot: false,
      },
      null,
      2,
    ),
  );
});
test("zoom easing, cut mapping, speed and validation preserve source positions", () => {
  assert.equal(sourceAt(edits, 1), 2);
  assert.equal(zoomAt(edits, 1 / 3).zoom, 1);
  assert.equal(zoomAt(edits, 2).zoom, 1);
  assert.equal(zoomAt(edits, 1).zoom, 2.4);
  const before = zoomAt(edits, 1 / 3 + 0.001).zoom;
  assert.ok(before - 1 < 0.000001, "zero-velocity entry");
  assert.deepEqual(sourceRanges(edits, 0.5, 3.5), [
    { start: 1 / 3, end: 1 },
    { start: 1, end: 2 },
  ]);
  assert.deepEqual(validateEdits(edits, 4), edits);
  assert.throws(
    () =>
      validateEdits(
        { ...edits, zooms: [...edits.zooms, { ...edits.zooms[0], id: "z2" }] },
        4,
      ),
    /overlap/,
  );
  assert.throws(() =>
    validateEdits({ ...edits, zooms: [{ ...edits.zooms[0], ease: NaN }] }, 4),
  );
  assert.throws(
    () => validateCursor({ clean: true, samples: [samples[4], samples[0]] }, 4),
    /ordered/,
  );
});
test("camera keeps its pivot fixed and stays continuous through cuts and adjacent zooms", () => {
  const z = {
    id: "pivot",
    start: 0,
    end: 4,
    zoom: 2,
    focusX: 0.85,
    focusY: 0.15,
    ease: 0.8,
  };
  const motion = {
    style: { ...defaults },
    segments: [{ start: 0, end: 4 }],
    zooms: [z],
  };
  for (let t = 0; t <= 4; t += 1 / 120) {
    const c = cropAt(motion, t);
    // The focal point must occupy the same screen position for the whole zoom,
    // not drift sideways as interpolated focus and scale multiply together.
    assert.ok(Math.abs((z.focusX - c.x) / c.size - z.focusX) < 1e-12);
    assert.ok(Math.abs((z.focusY - c.y) / c.size - z.focusY) < 1e-12);
  }
  assert.ok(Math.abs(zoomAt(motion, 0.4).zoom - Math.sqrt(2)) < 1e-12);
  // Mutable edits must invalidate the cached path.
  motion.zooms[0].zoom = 3;
  assert.ok(Math.abs(zoomAt(motion, 0.4).zoom - Math.sqrt(3)) < 1e-12);
  for (const speed of [0.5, 1, 2]) {
    motion.style.speed = speed;
    motion.segments = [
      { start: 0, end: 0.3 },
      { start: 1, end: 4 },
    ];
    const cut = 0.3 / speed,
      dt = 1e-5;
    const before = cropAt(motion, cut - dt),
      at = cropAt(motion, cut),
      after = cropAt(motion, cut + dt);
    for (const key of ["x", "y", "size"]) {
      assert.ok(
        Math.abs(after[key] - before[key]) < 0.0001,
        `continuous ${key} at ${speed}x cut`,
      );
      assert.ok(
        Math.abs(after[key] - at[key] - (at[key] - before[key])) / dt < 0.001,
        `continuous velocity at ${speed}x cut`,
      );
    }
  }
  const adjacent = {
    style: { ...defaults },
    segments: [{ start: 0, end: 4 }],
    zooms: [
      { ...z, id: "left", end: 2, zoom: 2, focusX: 0.1 },
      { ...z, id: "right", start: 2, zoom: 2, focusX: 0.9 },
    ],
  };
  for (let t = 1.2; t <= 2.8; t += 1 / 120)
    assert.equal(
      zoomAt(adjacent, t).zoom,
      2,
      "pan between zooms without zooming out",
    );
  assert.ok(cropAt(adjacent, 1.9).x < cropAt(adjacent, 2.1).x);
  // Trimming away the gap also makes these sections adjacent in output time.
  adjacent.zooms[1].start = 2.5;
  adjacent.segments = [
    { start: 0, end: 2 },
    { start: 2.5, end: 4 },
  ];
  assert.equal(zoomAt(adjacent, 2).zoom, 2);
  adjacent.segments = [{ start: 3, end: 3.2 }];
  for (const t of [0, 0.05, 0.1, 0.15, 0.2]) {
    const c = cropAt(adjacent, t);
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.size <= 1 && c.y + c.size <= 1);
  }
  adjacent.segments = [{ start: 2.1, end: 2.4 }];
  assert.deepEqual(
    cropAt(adjacent, 0.1),
    { x: 0, y: 0, size: 1 },
    "discarded zooms have no camera motion",
  );
});
test("cursor smoothing reduces jitter, pins clicks and never draws baked cursors", () => {
  const raw = [],
    smooth = [];
  for (let t = 0.5; t < 1; t += 1 / 120) {
    raw.push(cursorAt(cursor, t, { ...defaults, cursorSmoothing: 0 }).x);
    smooth.push(cursorAt(cursor, t, defaults).x);
  }
  const acceleration = (v) =>
    v
      .slice(2)
      .reduce((sum, x, i) => sum + Math.abs(x - 2 * v[i + 1] + v[i]), 0);
  assert.ok(acceleration(smooth) < acceleration(raw) * 0.2);
  const pressed = cursorAt(cursor, 2.01, defaults),
    original = cursorAt(cursor, 2.01, { ...defaults, cursorSmoothing: 0 });
  assert.deepEqual(pressed, original);
  assert.equal(cursorAt({ ...cursor, clean: false }, 1, defaults), null);
  assert.equal(cursorAt(cursor, 1, { ...defaults, showCursor: false }), null);
  const hidden = {
    clean: true,
    samples: [
      { ...samples[0], visible: false },
      { ...samples[0], t: 1, visible: false },
    ],
  };
  assert.equal(cursorAt(hidden, 0.5, defaults), null);
});
function decode(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("/opt/homebrew/bin/ffmpeg", [
      "-v",
      "error",
      "-i",
      file,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const chunks = [];
    let error = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => (error += d));
    p.on("error", reject);
    p.on("close", (c) =>
      c ? reject(new Error(error)) : resolve(Buffer.concat(chunks)),
    );
  });
}
test("60 fps export matches eased crop and smoothed cursor through a cut, frame by frame", async () => {
  const root = path.resolve(".cache/motion-test");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const project = await motionFixture(root);
  const result = await exportProject(
    project,
    edits,
    { mode: "separate", height: 720, fps: 60, audio: false, quality: "high" },
    root,
  );
  const screen = result.files.find((f) => f.endsWith("screen.mp4"));
  const pixels = await decode(screen),
    frameBytes = 1280 * 720 * 3,
    frames = Math.floor(pixels.length / frameBytes);
  assert.ok(Math.abs(frames - 140) <= 1);
  let maxColorError = 0,
    maxCursorError = 0,
    cursorFrames = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / 60,
      source = sourceAt(edits, t),
      crop = cropAt(edits, t);
    const x = 192,
      y = 576,
      offset = f * frameBytes + (y * 1280 + x) * 3;
    const expected = [
      (crop.x + (x / 1280) * crop.size) * 255,
      (crop.y + (y / 720) * crop.size) * 255,
    ];
    maxColorError = Math.max(
      maxColorError,
      Math.abs(pixels[offset] - expected[0]),
      Math.abs(pixels[offset + 1] - expected[1]),
      Math.abs(pixels[offset + 2] - (48 + source * 30)),
    );
    const p = cursorAt(cursor, source, edits.style),
      cx = ((p.x - crop.x) / crop.size) * 1280,
      cy = ((p.y - crop.y) / crop.size) * 720;
    if (cx < 0 || cx > 1180 || cy < 0 || cy > 620) continue;
    let minX = Infinity,
      minY = Infinity;
    for (
      let yy = Math.max(0, Math.floor(cy - 70));
      yy < Math.min(720, cy + 100);
      yy++
    )
      for (
        let xx = Math.max(0, Math.floor(cx - 70));
        xx < Math.min(1280, cx + 100);
        xx++
      ) {
        const k = f * frameBytes + (yy * 1280 + xx) * 3;
        if (pixels[k] > 215 && pixels[k + 1] > 215 && pixels[k + 2] > 215) {
          minX = Math.min(minX, xx);
          minY = Math.min(minY, yy);
        }
      }
    assert.ok(Number.isFinite(minX), `Cursor absent on frame ${f}`);
    // The white fill begins inside the dark outline; estimate the hotspot
    // from that inset and allow source-resolution antialiasing / H.264 loss.
    const error = Math.max(
      Math.abs(minX - cx - 1.5 / crop.size),
      Math.abs(minY - cy - 3 / crop.size),
    );
    maxCursorError = Math.max(maxCursorError, error);
    cursorFrames++;
  }
  assert.ok(maxColorError < 5, `Zoom/color mismatch ${maxColorError}`);
  assert.ok(maxCursorError < 5, `Cursor mismatch ${maxCursorError}`);
  assert.ok(cursorFrames > 100);
  const evidence = {
    frames,
    outputFps: 60,
    maxColorError,
    maxCursorError,
    cursorFrames,
    hardwareCapture: false,
  };
  await fs.mkdir("evidence/motion", { recursive: true });
  await fs.writeFile(
    "evidence/motion/export-check.json",
    JSON.stringify(evidence, null, 2),
  );
  await fs.copyFile(screen, "evidence/motion/zoom-and-cursor.mp4");
  assert.deepEqual((await fs.readdir(result.directory)).sort(), [
    "camera.mp4",
    "export.json",
    "screen.mp4",
  ]);
});

test("decoded camera motion stays continuous across a cut inside a ramp and an adjacent pan", async () => {
  const root = path.resolve(".cache/zoom-continuity");
  await fs.rm(root, { recursive: true, force: true });
  const project = await motionFixture(root);
  const motion = {
    style: { ...defaults, speed: 1.5, showCursor: false },
    segments: [
      { start: 0, end: 1 },
      { start: 1.45, end: 4 },
    ],
    zooms: [
      {
        id: "in",
        start: 0.4,
        end: 2.5,
        zoom: 2.2,
        focusX: 0.85,
        focusY: 0.2,
        ease: 0.8,
      },
      {
        id: "pan",
        start: 2.5,
        end: 3.9,
        zoom: 2.2,
        focusX: 0.15,
        focusY: 0.8,
        ease: 0.6,
      },
    ],
  };
  const result = await exportProject(
    project,
    motion,
    { mode: "separate", height: 720, fps: 60, audio: false, quality: "high" },
    root,
  );
  const screen = result.files.find((f) => f.endsWith("screen.mp4"));
  const pixels = await decode(screen),
    bytes = 1280 * 720 * 3,
    frames = pixels.length / bytes;
  let maxError = 0,
    maxPixelStep = 0;
  const observations = [];
  for (let f = 0; f < frames; f++) {
    const c = cropAt(motion, f / 60),
      offset = f * bytes + (576 * 1280 + 192) * 3;
    // A small patch measures geometric motion rather than a single H.264
    // quantization edge. The fixture is a linear gradient, so its mean has
    // exactly the same expected position as the center pixel for either encoder.
    const observed = [0, 0];
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const sample = offset + (dy * 1280 + dx) * 3;
        observed[0] += pixels[sample] / 81;
        observed[1] += pixels[sample + 1] / 81;
      }
    const expected = [(c.x + 0.15 * c.size) * 255, (c.y + 0.8 * c.size) * 255];
    maxError = Math.max(
      maxError,
      ...observed.map((v, i) => Math.abs(v - expected[i])),
    );
    if (f)
      maxPixelStep = Math.max(
        maxPixelStep,
        ...observed.map((v, i) => Math.abs(v - observations.at(-1)[i])),
      );
    observations.push(observed);
  }
  assert.ok(maxError < 5, `actual rendered viewport disagrees by ${maxError}`);
  assert.ok(
    maxPixelStep < 9,
    `visible camera jump of ${maxPixelStep} gradient levels`,
  );
  // Frame 40 is the cut, which used to skip directly through the entry ramp.
  const cutStep = Math.max(
    ...observations[40].map((v, i) => Math.abs(v - observations[39][i])),
  );
  assert.ok(cutStep <= 5, `zoom snapped at source cut: ${cutStep}`);
  await fs.mkdir("evidence/motion", { recursive: true });
  await fs.copyFile(screen, "evidence/motion/continuous-zoom.mp4");
  await fs.writeFile(
    "evidence/motion/continuity-check.json",
    JSON.stringify(
      { frames, outputFps: 60, maxColorError: maxError, maxPixelStep, cutStep },
      null,
      2,
    ),
  );
});

test("the maximum 80 zoom sections render without exceeding expression depth", async () => {
  const root = path.resolve(".cache/zoom-capacity");
  await fs.mkdir(root, { recursive: true });
  const motion = {
    style: defaults,
    segments: [{ start: 0, end: 80 }],
    zooms: Array.from({ length: 80 }, (_, i) => ({
      id: `z${i}`,
      start: i,
      end: i + 0.9,
      zoom: 2,
      focusX: i % 2,
      focusY: 0.5,
      ease: 0.3,
    })),
  };
  const graph = path.join(root, "filter.txt");
  await fs.writeFile(graph, `[0:v]${perspectiveFilter(motion, 60)}[out]`);
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=s=32x18:r=60:d=0.1",
    "-filter_complex_script",
    graph,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
});
