import test from "node:test";
import assert from "node:assert/strict";
import { compositionLayout } from "../desktop/composition.mjs";
import { defaults, validateEdits, exportArgs } from "../desktop/media.mjs";
import {
  availableStyleFields,
  editOperations,
  styleFields,
} from "../mcp/edits.mjs";

const edits = (style = {}) => ({
  segments: [{ start: 0, end: 1 }],
  style: { ...defaults, ...style },
});

test("webcam margin defaults preserve existing placement and zero reaches the canvas edge", () => {
  const legacy = edits();
  delete legacy.style.cameraMargin;
  const normalized = validateEdits(legacy, 1);
  assert.equal(normalized.style.cameraMargin, 0.035);
  assert.equal(compositionLayout(legacy.style, 1920, 1080).cameraGap, 67);
  assert.equal(compositionLayout(normalized.style, 1920, 1080).cameraGap, 67);
  assert.equal(
    compositionLayout({ ...defaults, cameraMargin: 0 }, 1920, 1080).cameraGap,
    0,
  );
  assert.equal(
    compositionLayout({ ...defaults, cameraMargin: 0.1 }, 1280, 720).cameraGap,
    128,
  );
  assert.equal(
    compositionLayout({ ...defaults, cameraMargin: 0.1 }, 3840, 2160).cameraGap,
    384,
  );
  for (const value of [-0.01, 0.201, NaN, Infinity, "0.05", null]) {
    assert.throws(
      () => validateEdits(edits({ cameraMargin: value }), 1),
      /cameraMargin/,
    );
    assert.equal(styleFields.cameraMargin.safeParse(value).success, false);
  }
});

test("maximum webcam size and margin stay inside landscape, portrait, square and ultrawide canvases", () => {
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [1080, 1080],
    [5120, 1440],
  ]) {
    for (const cameraSize of [0.1, 0.22, 0.5]) {
      for (const cameraMargin of [0, 0.035, 0.2]) {
        const layout = compositionLayout(
          { ...defaults, cameraSize, cameraMargin },
          width,
          height,
        );
        assert(layout.cameraGap >= 0);
        assert(layout.cameraGap + layout.cameraSize <= Math.min(width, height));
      }
    }
  }
});

test("MCP exposes margin only for projects with a webcam and patches it without replacing other settings", () => {
  const p = { tracks: { camera: {} }, edits: edits() };
  assert(availableStyleFields(p).includes("cameraMargin"));
  editOperations.update_style.apply(p, { changes: { cameraMargin: 0.08 } });
  assert.equal(p.edits.style.cameraMargin, 0.08);
  assert.equal(p.edits.style.cameraSize, 0.22);
  assert.equal(p.edits.style.padding, 0);
  const withoutCamera = { tracks: {}, edits: edits() };
  assert(!availableStyleFields(withoutCamera).includes("cameraMargin"));
  assert.throws(
    () =>
      editOperations.update_style.apply(withoutCamera, {
        changes: { cameraMargin: 0.08 },
      }),
    /Unavailable style controls/,
  );
});

test("all four export corners honor margin, while separate camera and screen video remain unchanged", () => {
  const track = {
    width: 1920,
    height: 1080,
    duration: 1,
    offset: 0,
    audio: false,
    video: true,
    file: "source.mp4",
  };
  const p = {
    directory: "/tmp/frame-margin",
    duration: 1,
    tracks: { screen: track, camera: track },
  };
  const options = { height: 720, fps: 30, audio: false };
  for (const cameraCorner of [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ]) {
    const args = exportArgs(
      p,
      edits({ cameraCorner, cameraMargin: 0.1 }),
      options,
      "combined",
      "/tmp/out.mp4",
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    const x = cameraCorner.endsWith("right") ? "W-w-128" : "128";
    const y = cameraCorner.startsWith("bottom") ? "H-h-128" : "128";
    assert(graph.includes(`[framed][camfit]overlay=x=${x}:y=${y}:`));
  }
  for (const mode of ["camera", "screen"]) {
    assert.deepEqual(
      exportArgs(p, edits({ cameraMargin: 0 }), options, mode, "/tmp/out.mp4"),
      exportArgs(
        p,
        edits({ cameraMargin: 0.2 }),
        options,
        mode,
        "/tmp/out.mp4",
      ),
    );
  }
});
