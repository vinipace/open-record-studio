import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cropAt,
  canFollowCursor,
  perspectiveFilter,
} from "../desktop/motion.mjs";
import {
  defaults,
  exportProject,
  binary,
  run,
  validateEdits,
} from "../desktop/media.mjs";
import { previewProject } from "../desktop/preview.mjs";
import { followFixture } from "./follow-fixture.mjs";
const exec = promisify(execFile);
const decode = async (file) =>
  (
    await exec(
      "/opt/homebrew/bin/ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 500e6 },
    )
  ).stdout;

test("following is deterministic, smooth through cuts and hidden/clicked cursors, and fixed shots stay fixed", async () => {
  const root = path.resolve(".cache/follow-unit");
  await fs.rm(root, { recursive: true, force: true });
  const p = await followFixture(root),
    e = p.edits;
  assert(canFollowCursor(p.cursor));
  assert(!canFollowCursor());
  assert(
    !canFollowCursor({
      clean: true,
      samples: p.cursor.samples.map((s) => ({ ...s, visible: false })),
    }),
  );
  assert.throws(
    () =>
      validateEdits({ ...e, zooms: [{ ...e.zooms[0], mode: "unknown" }] }, 4),
    /zoom mode/,
  );
  const positions = Array.from({ length: 281 }, (_, i) =>
    cropAt(e, i / 120, p.cursor),
  );
  for (let i = positions.length - 1; i >= 0; i--) {
    assert.deepEqual(
      cropAt(e, i / 120, p.cursor),
      positions[i],
      "backward seek is repeatable",
    );
    const c = positions[i];
    assert(
      c.x >= -1e-9 &&
        c.y >= -1e-9 &&
        c.x + c.size <= 1 + 1e-9 &&
        c.y + c.size <= 1 + 1e-9,
    );
  }
  assert(
    cropAt(e, 1.5, p.cursor).x - cropAt(e, 0.6, p.cursor).x > 0.25,
    "camera follows movement",
  );
  for (const speed of [0.5, 1, 1.5, 2]) {
    e.style.speed = speed;
    for (const t of [1.5 / speed, 2.1 / speed, 2.3 / speed]) {
      const dt = 0.00001,
        a = cropAt(e, t - dt, p.cursor),
        b = cropAt(e, t, p.cursor),
        c = cropAt(e, t + dt, p.cursor);
      for (const key of ["x", "y", "size"]) {
        assert(
          Math.abs(a[key] - c[key]) < 0.0001,
          `continuous ${key} at cut/hidden span`,
        );
        assert(
          Math.abs(c[key] - 2 * b[key] + a[key]) / dt < 0.005,
          "continuous camera velocity",
        );
      }
    }
  }
  const before = cropAt(e, 1, p.cursor);
  e.style.showCursor = true;
  assert.deepEqual(
    cropAt(e, 1, p.cursor),
    before,
    "visibility is independent of tracking",
  );
  const unpressed = {
    ...p.cursor,
    samples: p.cursor.samples.map((s) => ({ ...s, pressed: false })),
  };
  assert.deepEqual(
    cropAt(e, 1, unpressed),
    before,
    "clicks do not snap the camera",
  );
  e.zooms[0].mode = "fixed";
  assert.deepEqual(cropAt(e, 1, p.cursor), cropAt(e, 1));
  const fixed = cropAt(e, 1);
  e.zooms[0].mode = "follow";
  assert.deepEqual(
    cropAt(e, 1),
    fixed,
    "missing tracking data safely uses saved fixed focus",
  );
});

test("follow MP4/GIF renders and MCP preview match the shared camera at every frame", async () => {
  const root = path.resolve(".cache/follow-render");
  await fs.rm(root, { recursive: true, force: true });
  const project = await followFixture(root),
    checks = [];
  // Include a fixed-to-follow handoff, speed, a cut, cursor jitter and a hidden span.
  project.edits.zooms = [
    {
      ...project.edits.zooms[0],
      id: "fixed",
      mode: "fixed",
      end: 0.7,
      ease: 0.2,
      focusX: 0.8,
    },
    { ...project.edits.zooms[0], start: 0.7 },
  ];
  for (const [format, fps, height] of [
    ["mp4", 30, 720],
    ["mp4", 60, 720],
    ["gif", 20, 360],
  ]) {
    const result = await exportProject(
      project,
      project.edits,
      { format, fps, height, mode: "separate", audio: false, quality: "high" },
      root,
    );
    const pixels = await decode(
      result.files.find((f) => f.endsWith(`screen.${format}`)),
    );
    const width = (height / 9) * 16,
      bytes = width * height * 3,
      frames = pixels.length / bytes;
    assert(Math.abs(frames - (3.5 / 1.5) * fps) <= 1);
    let maxError = 0;
    for (let f = 0; f < frames; f++) {
      const c = cropAt(project.edits, f / fps, project.cursor);
      if (format === "gif") {
        // The global 256-color palette dithers this moving RGB gradient. Test
        // average local color across the whole frame instead of isolated dots.
        let error = 0,
          count = 0;
        for (let y = 16; y < height - 16; y += 16)
          for (let x = 16; x < width - 16; x += 16) {
            const mean = [0, 0];
            for (let yy = y - 4; yy < y + 4; yy++)
              for (let xx = x - 4; xx < x + 4; xx++) {
                const offset = f * bytes + (yy * width + xx) * 3;
                mean[0] += pixels[offset] / 64;
                mean[1] += pixels[offset + 1] / 64;
              }
            error +=
              Math.abs(mean[0] - (c.x + ((x - 0.5) / width) * c.size) * 255) +
              Math.abs(mean[1] - (c.y + ((y - 0.5) / height) * c.size) * 255);
            count += 2;
          }
        maxError = Math.max(maxError, error / count);
        continue;
      }
      for (const [px, py] of [
        [0.15, 0.8],
        [0.7, 0.3],
      ]) {
        const x = Math.floor(width * px),
          y = Math.floor(height * py),
          offset = f * bytes + (y * width + x) * 3;
        maxError = Math.max(
          maxError,
          Math.abs(pixels[offset] - (c.x + (x / width) * c.size) * 255),
          Math.abs(pixels[offset + 1] - (c.y + (y / height) * c.size) * 255),
        );
      }
    }
    assert(
      maxError < (format === "gif" ? 7 : 5),
      `${format}/${fps}: camera color error ${maxError}`,
    );
    checks.push({ format, fps, frames, maxError });
  }
  const preview = await previewProject(project, {
    time: 1.2,
    mode: "screen",
    height: 360,
  });
  const file = path.join(root, "preview.png");
  await fs.writeFile(file, preview.image);
  const image = await decode(file),
    c = cropAt(project.edits, preview.time, project.cursor);
  const offset = (288 * 640 + 96) * 3;
  assert(Math.abs(image[offset] - (c.x + 0.15 * c.size) * 255) < 5);
  assert(Math.abs(image[offset + 1] - (c.y + 0.8 * c.size) * 255) < 5);
  await fs.mkdir("evidence/follow", { recursive: true });
  await fs.writeFile(
    "evidence/follow/renders.json",
    JSON.stringify(
      { checks, previewFrame: preview.frame, previewMatches: true },
      null,
      2,
    ),
  );
});

test("80 follow sections compile and render without expression-depth failures", async () => {
  const root = path.resolve(".cache/follow-stress");
  await fs.mkdir(root, { recursive: true });
  const e = {
    style: defaults,
    segments: [{ start: 0, end: 80 }],
    zooms: Array.from({ length: 80 }, (_, i) => ({
      id: `z${i}`,
      mode: "follow",
      start: i,
      end: i + 0.9,
      zoom: 2,
      focusX: 0.5,
      focusY: 0.5,
      ease: 0.3,
    })),
  };
  const cursor = {
    clean: true,
    samples: Array.from({ length: 9601 }, (_, i) => ({
      t: i / 120,
      x: 0.5 + 0.4 * Math.sin(i / 60),
      y: 0.4,
      visible: true,
      pressed: false,
    })),
  };
  const graph = path.join(root, "filter.txt"),
    started = performance.now();
  const filter = perspectiveFilter(e, 60, cursor);
  assert(performance.now() - started < 10000, "bounded compilation time");
  assert(filter.length < 12e6, "does not embed raw 120Hz samples");
  await fs.writeFile(graph, `[0:v]${filter}[out]`);
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
