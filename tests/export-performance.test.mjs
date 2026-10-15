import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  screenRenderSize,
  selectVideoEncoder,
  videoEncodingArgs,
} from "../desktop/export-performance.mjs";
import { createExportProgress } from "../desktop/export-progress.mjs";
import { createExportNotifier } from "../desktop/export-notification.mjs";
import { defaults, exportArgs, validateEdits } from "../desktop/media.mjs";
const project = {
  duration: 30,
  directory: "/tmp",
  tracks: {
    screen: { width: 5120, height: 2880, file: "screen.mp4", offset: 0 },
  },
};
const edits = {
  segments: [{ start: 0, end: 10 }],
  style: { ...defaults, aspectRatio: "source" },
  zooms: [
    {
      id: "z",
      start: 1,
      end: 3,
      zoom: 2,
      mode: "fixed",
      focusX: 0.5,
      focusY: 0.5,
      ease: 0.6,
    },
  ],
};
test("working resolution retains every output pixel at the maximum retained zoom", () => {
  const options = { mode: "separate", height: 1080, fps: 60 };
  assert.deepEqual(screenRenderSize(project, edits, options), {
    width: 3840,
    height: 2160,
  });
  assert.deepEqual(
    screenRenderSize(project, { ...edits, zooms: [] }, options),
    { width: 1920, height: 1080 },
  );
  assert.deepEqual(
    screenRenderSize(
      project,
      { ...edits, zooms: [{ ...edits.zooms[0], start: 20, end: 24, zoom: 3 }] },
      options,
    ),
    { width: 1920, height: 1080 },
  );
  assert.deepEqual(
    screenRenderSize(project, edits, { ...options, height: 2160 }),
    { width: 5120, height: 2880 },
  );
  const portrait = {
    ...edits,
    style: { ...edits.style, aspectRatio: "9:16", screenFit: "fill" },
  };
  assert.ok(
    screenRenderSize(project, portrait, { ...options, mode: "combined" })
      .height >= 2160,
  );
  const graph = exportArgs(
    project,
    validateEdits(edits, 30),
    options,
    "screen",
    "/tmp/out.mp4",
    { movie: "/tmp/cursor.mov", size: { width: 3840, height: 2160 } },
  );
  assert.match(
    graph[graph.indexOf("-filter_complex") + 1],
    /scale=3840:2160:flags=lanczos/,
  );
  assert.match(
    graph[graph.indexOf("-filter_complex") + 1],
    /overlay=x=0:y=0:format=yuv420/,
  );
});
test("hardware capability is cached, failures select software, cancellation is not cached", async () => {
  if (process.platform !== "darwin") return;
  let calls = 0;
  const probe = async () => {
    calls++;
  };
  assert.equal(await selectVideoEncoder("ok", probe), "h264_videotoolbox");
  assert.equal(await selectVideoEncoder("ok", probe), "h264_videotoolbox");
  assert.equal(calls, 1);
  assert.equal(
    await selectVideoEncoder("no", async () => {
      throw Error("unavailable");
    }),
    "libx264",
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    selectVideoEncoder(
      "cancelled",
      async () => {
        throw Error("cancel");
      },
      c.signal,
    ),
    /cancel/,
  );
  assert.equal(
    await selectVideoEncoder("cancelled", probe),
    "h264_videotoolbox",
  );
  assert.deepEqual(videoEncodingArgs({ encoder: "libx264", quality: "high" }), [
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
  ]);
});
test("ETA includes upcoming passes, handles warmup and stalls, and completes only after finalization", () => {
  let now = 0;
  const p = createExportProgress(
    [
      { track: "screen", work: 4 },
      { track: "camera", work: 1 },
      { track: "finishing", work: 0.1 },
    ],
    () => now,
  );
  assert.equal(p.snapshot().remainingSeconds, null);
  now = 4000;
  const sample = p.update(0.5);
  assert.equal(sample.elapsedSeconds, 4);
  assert.ok(sample.remainingSeconds > 4);
  assert.equal(
    p.update(0.4).ratio,
    sample.ratio,
    "out-of-order progress cannot regress",
  );
  now = 20000;
  assert.equal(
    p.snapshot().remainingSeconds,
    null,
    "a stalled process does not promise an obsolete finish time",
  );
  const camera = p.advance();
  assert.equal(camera.track, "camera");
  assert.ok(camera.ratio < 1);
  now = 21000;
  p.update(1);
  p.advance();
  assert.equal(p.snapshot().track, "finishing");
  assert.ok(p.snapshot().ratio < 1);
  assert.deepEqual(p.advance(), {
    ratio: 1,
    track: "done",
    elapsedSeconds: 21,
    remainingSeconds: 0,
  });
});
test("completion notification opens that export and notification failure does not fail export", () => {
  const sent = [],
    opened = [];
  class Notification extends EventEmitter {
    static isSupported() {
      return true;
    }
    constructor(options) {
      super();
      this.options = options;
      sent.push(this);
    }
    show() {
      this.shown = true;
    }
  }
  const notify = createExportNotifier({
    Notification,
    openPath: (directory) => opened.push(directory),
  });
  notify("Demo", { files: ["a", "b"], directory: "/tmp/first" });
  notify("Next", { files: ["c"], directory: "/tmp/next" });
  assert.equal(sent[0].shown, true);
  assert.equal(sent[0].options.title, "Export complete");
  assert.match(sent[0].options.body, /2 files/);
  sent[0].emit("click");
  assert.deepEqual(opened, ["/tmp/first"]);
  class Unsupported {
    static isSupported() {
      return false;
    }
    constructor() {
      throw Error("should never construct");
    }
  }
  assert.doesNotThrow(() =>
    createExportNotifier({ Notification: Unsupported, openPath() {} })("Demo", {
      files: [],
      directory: "/tmp",
    }),
  );
});

test("a hardware failure during rendering retries software and leaves only verified outputs", async () => {
  if (process.platform !== "darwin") return;
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { binary, run, exportProject, probe } =
    await import("../desktop/media.mjs");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "frame-export-fallback-"),
  );
  const ffmpeg = await binary("ffmpeg");
  const previous = process.env.FRAME_FFMPEG;
  try {
    await run(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=0.5",
      "-c:v",
      "libx264",
      path.join(root, "source.mp4"),
    ]);
    const wrapper = path.join(root, "ffmpeg");
    await fs.writeFile(
      wrapper,
      `#!${process.execPath}\n` +
        `import {spawnSync} from 'node:child_process'; import fs from 'node:fs';\n` +
        `const a=process.argv.slice(2); if(a.includes('h264_videotoolbox') && a.at(-1).endsWith('.mp4')) {fs.writeFileSync(a.at(-1),'partial'); process.exit(1);} const p=spawnSync(${JSON.stringify(ffmpeg)},a,{stdio:'inherit'}); process.exit(p.status ?? 1);\n`,
    );
    await fs.chmod(wrapper, 0o755);
    process.env.FRAME_FFMPEG = wrapper;
    const p = {
      name: "Fallback",
      duration: 0.5,
      directory: root,
      tracks: {
        screen: {
          file: "source.mp4",
          width: 320,
          height: 180,
          duration: 0.5,
          offset: 0,
        },
      },
    };
    const e = {
      segments: [{ start: 0, end: 0.5 }],
      style: { ...defaults, showCursor: false },
    };
    const progress = [];
    const result = await exportProject(
      p,
      e,
      { mode: "combined", height: 720, fps: 30, audio: false, quality: "high" },
      root,
      { onProgress: (p) => progress.push(p) },
    );
    assert.equal((await probe(result.files[0])).video, true);
    assert.equal(progress.at(-1).encoder, "libx264");
    assert.equal(progress.at(-1).ratio, 1);
    assert.ok(progress.every((p, i) => !i || p.ratio >= progress[i - 1].ratio));
    assert.ok(
      !(await fs.readdir(root)).some((p) => p.startsWith(".frame-export-")),
    );
  } finally {
    if (previous === undefined) delete process.env.FRAME_FFMPEG;
    else process.env.FRAME_FFMPEG = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ETA recalibrates per pass instead of carrying cached preparation or a faster previous pass forward", () => {
  let now = 0;
  const p = createExportProgress(
    [
      { track: "cached audio", work: 0.25 },
      { track: "screen", work: 1 },
      { track: "camera", work: 1 },
    ],
    () => now,
  );
  now = 100;
  p.update(1);
  p.advance();
  now = 60100;
  const screen = p.update(0.25);
  // 180 seconds of screen remain plus a similarly weighted 240-second camera pass.
  assert.equal(screen.remainingSeconds, 420);
  now = 240100;
  p.update(1);
  p.advance();
  assert.equal(p.snapshot().remainingSeconds, null);
  now = 300100;
  const camera = p.update(0.1);
  // This camera is slower. Its own observed rate predicts the remaining 90%.
  assert.ok(Math.abs(camera.remainingSeconds - 540) < 0.001);
});
