import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { layerSpans, takeOutputSpans } from "../desktop/webcam-take.mjs";
import { mergeRanges } from "../desktop/audio-edits.mjs";
import { sourceRanges } from "../desktop/motion.mjs";

const load = async (file, name) =>
  stripTypeScriptTypes(
    (await readFile(new URL(file, import.meta.url), "utf8"))
      .replace(/^import[\s\S]*?from "[^"]+";/gm, "")
      .replace(`export class ${name}`, `class ${name}`),
    { mode: "transform" },
  ) + `\n${name}`;

const timelineSlice = vm.runInNewContext(
  stripTypeScriptTypes(
    (
      await readFile(
        new URL("../src/timeline-viewport.ts", import.meta.url),
        "utf8",
      )
    ).replaceAll("export ", ""),
    { mode: "transform" },
  ) + "\ntimelineSlice",
);

class Element {
  children = [];
  dataset = {};
  style = {};
  classList = { toggle() {} };
  attrs = {};
  set innerHTML(value) {
    this.children = [];
    this.parts = Object.fromEntries(
      (value.includes("track-label")
        ? [".track-symbol", ".track-label > span:last-child", ".lane"]
        : ["span"]
      ).map((key) => [key, new Element()]),
    );
    this.append(...Object.values(this.parts));
  }
  querySelector(key) {
    return this.parts[key];
  }
  setAttribute(key, value) {
    this.attrs[key] = value;
  }
  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  prepend(node) {
    this.insertBefore(node, this.children[0]);
  }
  insertBefore(node, before) {
    node.remove();
    const i = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(i, 0, node);
    node.parentElement = this;
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (n) => n !== this,
      );
    this.parentElement = null;
  }
  replaceChildren() {
    for (const node of [...this.children]) node.remove();
  }
  closest() {
    return this;
  }
  getBoundingClientRect() {
    return { width: 400 };
  }
}

test("take audio lanes appear after recording, survive selection, and follow edits without redecoding", async () => {
  const calls = [],
    paints = [];
  const Timeline = vm.runInNewContext(
    await load("../src/layer-timeline.ts", "LayerTimeline"),
    {
      document: { createElement: () => new Element() },
      ResizeObserver: class {
        observe() {}
      },
      window: {
        devicePixelRatio: 2,
        studio: {
          assetWaveform: async (...args) => {
            calls.push(args);
            return { peaks: new Float32Array([1]) };
          },
        },
      },
      layerSpans,
      takeOutputSpans,
      mergeRanges,
      sourceRanges,
      duration: (edits) =>
        edits.segments.reduce((n, s) => n + s.end - s.start, 0) /
        edits.style.speed,
      timelineSlice,
      drawTakeWaveform: (...args) => paints.push(args),
    },
  );
  const root = new Element(),
    timeline = new Timeline(root, () => "icon");
  const asset = {
    name: "Webcam take 1",
    audio: true,
    duration: 4,
    timeMap: [{ start: 0, end: 4, mediaStart: 0, rate: 1 }],
  };
  const project = {
    id: "project",
    assets: { take: asset, silent: { ...asset, audio: false } },
  };
  const layer = {
    id: "layer",
    assetId: "take",
    start: 1,
    end: 5,
    mediaStart: 0,
    visible: true,
    opacity: 1,
    volume: 1,
  };
  const edits = {
    segments: [{ start: 0, end: 8 }],
    style: { speed: 1 },
    layers: [],
  };
  timeline.render(project, edits, "", "video");
  edits.layers.push(layer);
  timeline.render(project, edits, "layer", "video");
  await new Promise(setImmediate);
  const group = root.children[0],
    row = group.children[1],
    canvas = row.querySelector(".lane").children[0].children[0];
  assert.equal(row.hidden, false);
  assert.equal(calls.length, 1);
  assert.equal(paints.length, 1);
  timeline.render(project, edits, "layer", "audio");
  assert.equal(root.children[0], group);
  assert.equal(row.querySelector(".lane").children[0].children[0], canvas);
  assert.equal(paints.length, 1, "selection reuses waveform pixels");
  layer.start = 2;
  layer.end = 6;
  edits.style.speed = 2;
  timeline.render(project, edits, "layer", "audio");
  assert.equal(paints.at(-1)[3], 1, "moved take uses edited output time");
  layer.volume = 0;
  timeline.render(project, edits, "layer", "audio");
  assert.equal(paints.at(-1)[6], 0);
  edits.layers.push({ ...layer, id: "silent", assetId: "silent" });
  timeline.render(project, edits, "silent", "video");
  assert.equal(root.children[0].children[1].hidden, true);
  assert.equal(
    calls.length,
    1,
    "silent camera and timeline edits never decode audio",
  );
  edits.layers = [];
  timeline.render(project, edits, "", "video");
  assert.equal(root.children.length, 0);
});

test("deleting selected take audio mutes only its microphone and supports undo", async () => {
  const CanvasMedia = vm.runInNewContext(
    await load("../src/canvas-media.ts", "CanvasMedia"),
    {},
  );
  const layer = { id: "take", volume: 0.8, start: 1, end: 3 };
  const edits = { layers: [layer] },
    history = [];
  const media = Object.create(CanvasMedia.prototype);
  Object.assign(media, {
    selected: "take",
    selectedPart: "audio",
    hooks: {
      state: () => ({ edits }),
      pause() {},
      changed() {},
      history: () => history.push(structuredClone(edits)),
    },
  });
  assert.equal(media.remove(), true);
  assert.equal(edits.layers.length, 1);
  assert.equal(layer.volume, 0);
  assert.deepEqual([layer.start, layer.end], [1, 3]);
  assert.equal(history[0].layers[0].volume, 0.8);
});
