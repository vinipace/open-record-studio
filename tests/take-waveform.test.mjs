import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { takeOutputSpans } from "../desktop/webcam-take.mjs";

const source = stripTypeScriptTypes(
  (await readFile(new URL("../src/waveform.ts", import.meta.url), "utf8"))
    .replace(/^import[^;]+;/gm, "")
    .replaceAll("export ", ""),
  { mode: "transform" },
);
const draw = vm.runInNewContext(`${source}\ndrawTakeWaveform`, {
  window: { devicePixelRatio: 2 },
});

function paint(spans, { start = 0, end = 6, gain = 1, width = 180 } = {}) {
  const marks = [];
  const context = { scale() {}, fillRect: (...rect) => marks.push(rect) };
  const canvas = { getContext: () => context };
  const peaks = new Float32Array(600);
  for (let i = 100; i < 200; i++) peaks[i] = 0.8;
  draw(
    canvas,
    { peaks, step: 0.01, maximum: 0.8, duration: 6 },
    spans,
    start,
    end,
    width,
    gain,
  );
  return { marks: marks.slice(1), canvas };
}

test("take waveforms align microphone transients through recording stalls, cuts, speed and trims", () => {
  const asset = {
    duration: 6,
    timeMap: [
      { start: 0, end: 2, mediaStart: 1, rate: 0.5 },
      { start: 3, end: 5, mediaStart: 3, rate: 1 },
    ],
  };
  const layer = { start: 2, end: 7, mediaStart: 0 };
  const edits = {
    segments: [
      { start: 0, end: 3 },
      { start: 4, end: 8 },
    ],
    style: { speed: 2 },
  };
  const spans = takeOutputSpans(edits, layer, asset);
  // The retained first half of the slow recording span maps to output 1–1.5s.
  const result = paint(spans, { end: 3.5, width: 210 });
  assert.ok(result.marks.length > 0);
  assert.ok(result.marks.every(([x]) => x >= 60 && x < 90));
  assert.equal(result.canvas.width, 420);
  const moved = takeOutputSpans(
    { ...edits, segments: [{ start: 0, end: 10 }] },
    { ...layer, start: 4, end: 9, mediaStart: 1 },
    asset,
  );
  assert.ok(
    paint(moved, { end: 5, width: 300 }).marks.every(
      ([x]) => x >= 120 && x < 150,
    ),
  );
});

test("muted take stays flat and waveform rendering stays bounded on wide timelines", () => {
  const spans = [{ start: 0, end: 6, mediaStart: 0, rate: 1 }];
  assert.equal(paint(spans, { gain: 0 }).marks.length, 0);
  assert.equal(paint([], {}).marks.length, 0);
  const result = paint(spans, { width: 100000 });
  assert.equal(result.canvas.width, 8192);
  assert.ok(result.marks.length <= 2400);
});
