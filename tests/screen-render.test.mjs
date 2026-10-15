import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaults, exportArgs, exportProject } from "../desktop/media.mjs";
import {
  screenOutputSize,
  canRenderScreen,
} from "../desktop/screen-render.mjs";
import { motionFixture } from "./motion-fixture.mjs";
const project = {
  directory: "/tmp",
  duration: 4,
  tracks: {
    screen: { file: "screen.mp4", width: 5120, height: 2880, audio: true },
  },
};
const edits = {
  style: { ...defaults },
  segments: [{ start: 1, end: 3 }],
  zooms: [],
};
const options = {
  mode: "separate",
  format: "mp4",
  height: 1080,
  fps: 60,
  audio: true,
  quality: "high",
};
test("GPU screen frames are stream-copied while system audio retains edits", () => {
  const args = exportArgs(
    project,
    edits,
    options,
    "screen",
    "/tmp/export.mp4",
    undefined,
    {},
    { movie: "/tmp/render.mp4", width: 1920, height: 1080 },
  );
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.match(graph, /atrim=start=1:end=3/);
  assert.doesNotMatch(graph, /perspective|\[0:v|fps=|overlay=/);
  assert.deepEqual(screenOutputSize(project, edits, options), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(
    screenOutputSize(project, { ...edits, zooms: [{ zoom: 5 }] }, options),
    { width: 1920, height: 1080 },
  );
  const silent = exportArgs(
    project,
    edits,
    { ...options, audio: false },
    "screen",
    "/tmp/export.mp4",
    undefined,
    {},
    { movie: "/tmp/render.mp4", width: 1920, height: 1080 },
  );
  assert.ok(!silent.includes("-filter_complex"));
  assert.equal(silent[silent.indexOf("-map") + 1], "1:v:0");
  const combined = exportArgs(
    project,
    edits,
    options,
    "combined",
    "/tmp/export.mp4",
    undefined,
    {},
    { movie: "/tmp/render.mp4", width: 1920, height: 1080 },
  );
  assert.doesNotMatch(
    combined[combined.indexOf("-filter_complex") + 1],
    /perspective|\[0:v/,
  );
});
test("unsupported formats keep the existing renderer", async () => {
  assert.equal(
    await canRenderScreen(project, { ...options, format: "gif" }),
    false,
  );
  assert.equal(
    await canRenderScreen(
      {
        ...project,
        tracks: { screen: { ...project.tracks.screen, file: "screen.webm" } },
      },
      options,
    ),
    false,
  );
});
test("cancelling the GPU pass stops the helper and removes its temporary output", async () => {
  if (process.platform !== "darwin") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-gpu-cancel-"));
  try {
    const project = await motionFixture(root);
    assert.equal(await canRenderScreen(project, options), true);
    const before = (await fs.readdir(root)).sort();
    const c = new AbortController();
    let started = false;
    await assert.rejects(
      exportProject(project, project.edits, { ...options, height: 720 }, root, {
        signal: c.signal,
        onProgress: (p) => {
          if (p.track === "screen" && p.ratio > 0) {
            started = true;
            c.abort();
          }
        },
      }),
    );
    assert.equal(started, true);
    assert.deepEqual((await fs.readdir(root)).sort(), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GPU screen render preserves imported video rotation and color", async () => {
  if (process.platform !== "darwin") return;
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const exec = promisify(execFile);
  const { run, probe } = await import("../desktop/media.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-gpu-rotation-"));
  try {
    const p = await motionFixture(root);
    const rotated = path.join(root, "rotated.mp4");
    await run("/opt/homebrew/bin/ffmpeg", [
      "-v",
      "error",
      "-display_rotation",
      "90",
      "-i",
      path.join(root, "screen.mp4"),
      "-c",
      "copy",
      rotated,
    ]);
    p.tracks.screen = {
      ...(await probe(rotated)),
      file: "rotated.mp4",
      offset: 0,
    };
    p.edits = {
      style: {
        ...defaults,
        aspectRatio: "source",
        showCursor: false,
        showCamera: false,
      },
      segments: [{ start: 0, end: 0.2 }],
    };
    const result = await exportProject(
      p,
      p.edits,
      { ...options, mode: "combined", height: 720 },
      root,
    );
    const pixels = async (file) =>
      (
        await exec(
          "/opt/homebrew/bin/ffmpeg",
          [
            "-v",
            "error",
            "-i",
            file,
            "-vf",
            "format=rgb24,scale=8:8",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { encoding: "buffer" },
        )
      ).stdout;
    const source = await pixels(rotated),
      output = await pixels(result.files[0]);
    assert.equal(output.length, source.length);
    const error =
      source.reduce((sum, v, i) => sum + Math.abs(v - output[i]), 0) /
      source.length;
    assert.ok(error < 4, `Rotated image/color mismatch ${error}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a stalled native renderer fails clearly instead of waiting indefinitely", async (t) => {
  const { prepareScreen } = await import("../desktop/screen-render.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-gpu-watchdog-"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  const stalledRun = async (_command, _args, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
      started();
    });
  try {
    const pending = prepareScreen(project, edits, options, root, stalledRun);
    const rejected = assert.rejects(
      pending,
      /screen renderer stopped responding/,
    );
    await ready;
    t.mock.timers.tick(30001);
    await rejected;
  } finally {
    t.mock.timers.reset();
    await fs.rm(root, { recursive: true, force: true });
  }
});
