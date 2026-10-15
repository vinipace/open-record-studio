import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { defaults, validateEdits } from "../desktop/media.mjs";
import { automaticZooms } from "../desktop/interactions.mjs";
import { sourceRanges } from "../desktop/motion.mjs";

const compile = async (file) =>
  stripTypeScriptTypes(
    (await readFile(new URL(`../src/${file}.ts`, import.meta.url), "utf8"))
      .replace(/^import[\s\S]*?from "[^"]+";/gm, "")
      .replace(/export /g, ""),
    { mode: "transform" },
  );
const context = vm.createContext({});
vm.runInContext(
  (await compile("timeline")) + (await compile("zoom-gesture")),
  context,
);
const {
  duration,
  sourceBoundary,
  outputTime,
  removeTimelineRange,
  moveZoomRange,
  zoomDragRange,
} = context;
const json = (value) => JSON.parse(JSON.stringify(value));
const zoom = (id, start, end) => ({
  id,
  start,
  end,
  zoom: 2,
  focusX: 0.5,
  focusY: 0.5,
  ease: 0.6,
});
const edits = (segments = [{ start: 0, end: 20 }], speed = 1, zooms = []) => ({
  segments,
  style: { ...defaults, speed },
  zooms,
});

test("automatic zooms keep event provenance through validation and serialization; legacy automatic IDs remain recognizable", () => {
  const zooms = automaticZooms(
    {
      events: [
        { type: "click", t: 1, end: 1, x: 0.2, y: 0.2 },
        { type: "typing", t: 1.2, end: 2, x: 0.2, y: 0.2 },
        { type: "selection", t: 6, end: 7, x: 0.8, y: 0.8 },
        { type: "click", t: 12, end: 12, x: 0.2, y: 0.2 },
      ],
    },
    20,
    { clean: true },
    { click: true },
  );
  assert.deepEqual(
    zooms.map((z) => z.trigger),
    ["typing", "selection", "click"],
  );
  assert(zooms.every((z) => z.ease === 0.6));
  const saved = validateEdits(edits(undefined, 1, zooms), 20);
  assert.deepEqual(validateEdits(json(saved), 20).zooms, saved.zooms);
  assert.equal(
    validateEdits(edits(undefined, 1, [zoom("auto-1", 2, 4)]), 20).zooms[0]
      .trigger,
    "event",
  );
  assert.equal(
    validateEdits(edits(undefined, 1, [zoom("manual", 2, 4)]), 20).zooms[0]
      .trigger,
    undefined,
  );
  assert.throws(
    () =>
      validateEdits(
        edits(undefined, 1, [{ ...zooms[0], trigger: "unknown" }]),
        20,
      ),
    /trigger/,
  );
});

test("moving a zoom preserves visible duration through cuts, speed, and neighboring zoom limits", () => {
  const moving = zoom("moving", 1, 3);
  const state = edits(
    [
      { start: 0, end: 4 },
      { start: 10, end: 18 },
    ],
    2,
    [zoom("left", 0, 1), moving, zoom("right", 15, 18)],
  );
  const moved = moveZoomRange(state, moving, 1);
  assert.deepEqual(json(moved), { start: 3, end: 11 });
  assert.equal(
    outputTime(state, moved.end) - outputTime(state, moved.start),
    1,
  );
  assert.deepEqual(json(moveZoomRange(state, moving, 100)), {
    start: 13,
    end: 15,
  });
  assert.deepEqual(json(moveZoomRange(state, moving, -100)), {
    start: 1,
    end: 3,
  });
  const exactCut = moveZoomRange(state, moving, 0.5);
  assert.equal(
    exactCut.end,
    4,
    "an out-point at a cut stays before discarded footage",
  );
  assert.equal(sourceBoundary(state, 2), 10);
  assert.equal(sourceBoundary(state, 2, true), 4);
  assert.deepEqual(
    json(state.zooms[1]),
    moving,
    "drag calculation leaves original and metadata intact",
  );
});

test("drag creation still respects source gaps and does not cross another zoom", () => {
  const state = edits(
    [
      { start: 0, end: 4 },
      { start: 10, end: 18 },
    ],
    2,
    [zoom("existing", 12, 14)],
  );
  assert.deepEqual(json(zoomDragRange(state, 0.5, 2)), { start: 1, end: 4 });
  assert.deepEqual(json(zoomDragRange(state, 0.5, 5)), { start: 1, end: 12 });
  assert.equal(zoomDragRange(state, 3.5, 0), null);
});

test("range removal splits retained clips and ripples all source-anchored tracks at any playback speed", () => {
  const state = edits(
    [
      { start: 0, end: 4 },
      { start: 10, end: 18 },
    ],
    2,
    [zoom("inside", 3, 4), zoom("after", 16, 18)],
  );
  state.layers = [
    { id: "take", start: 1, end: 17, mediaStart: 0, assetId: "camera", x: 0.5 },
    { id: "removed", start: 3, end: 4, mediaStart: 0 },
  ];
  state.removedAudio = [{ start: 16, end: 17 }];
  const before = json(state);
  const result = removeTimelineRange(state, { start: 1.5, end: 4 });
  assert.deepEqual(json(result.segments), [
    { start: 0, end: 3 },
    { start: 14, end: 18 },
  ]);
  assert.equal(duration(result), duration(state) - 2.5);
  assert.deepEqual(json(result.zooms.map((z) => z.id)), ["after"]);
  assert.deepEqual(result.layers, [state.layers[0]]);
  assert.deepEqual(result.removedAudio, state.removedAudio);
  assert.equal(
    sourceRanges(result, 16, 18)[0].start,
    2.5,
    "zoom, camera and audio retain the same source time after ripple",
  );
  assert.deepEqual(
    json(state),
    before,
    "undo snapshot and original media stay unchanged",
  );
  assert.deepEqual(
    json(removeTimelineRange(state, { start: 4, end: 1.5 })),
    json(result),
  );
});

test("range removal handles exact boundaries, short remainders and project limits", () => {
  const state = edits();
  assert.deepEqual(
    json(removeTimelineRange(state, { start: 2, end: 5 }).segments),
    [
      { start: 0, end: 2 },
      { start: 5, end: 20 },
    ],
  );
  assert.deepEqual(
    json(removeTimelineRange(state, { start: 0.01, end: 2 }).segments),
    [{ start: 2, end: 20 }],
  );
  assert.deepEqual(
    json(removeTimelineRange(state, { start: 18, end: 20 }).segments),
    [{ start: 0, end: 18 }],
  );
  assert.equal(removeTimelineRange(state, { start: 5, end: 5 }), state);
  assert.throws(
    () => removeTimelineRange(state, { start: 0, end: 20 }),
    /Keep at least/,
  );
  const split = edits([
    { start: 0, end: 2 },
    { start: 4, end: 6 },
  ]);
  assert.deepEqual(
    json(removeTimelineRange(split, { start: 2, end: 4 }).segments),
    [{ start: 0, end: 2 }],
  );
  const many = edits(
    Array.from({ length: 100 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 })),
  );
  assert.throws(
    () => removeTimelineRange(many, { start: 0.2, end: 0.4 }),
    /100/,
  );
  validateEdits(removeTimelineRange(state, { start: 2, end: 5 }), 20);
});

const dragSource = await compile("timeline-drag");
const mainSource = await readFile(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);
test("the range Delete handler creates one undo step and restores every track on undo/redo", () => {
  const original = edits(undefined, 1, [
    zoom("auto-1", 2, 4),
    zoom("manual", 9, 12),
  ]);
  original.layers = [
    { id: "take", start: 2, end: 4 },
    { id: "image", start: 1, end: 20 },
  ];
  original.removedAudio = [{ start: 10, end: 11 }];
  const c = vm.createContext({
    edits: structuredClone(original),
    selectedRange: { start: 1, end: 5 },
    selectionKind: "range",
    playhead: 8,
    selected: 0,
    busy: false,
    recordId: "",
    history: [],
    future: [],
    cancelTimelineGesture: null,
    structuredClone,
    normalizeSelection() {},
    pause() {},
    changed() {},
    syncMedia() {},
    removeTimelineRange,
    duration,
    error(e) {
      throw e;
    },
  });
  const functions = ["recordHistory", "removeSelected", "undo", "redo"]
    .map(
      (name) =>
        mainSource.match(
          new RegExp(`^function ${name}\\([\\s\\S]*?^}`, "m"),
        )[0],
    )
    .join("\n");
  vm.runInContext(
    stripTypeScriptTypes(functions, { mode: "transform" }) +
      `
    function selectItem(kind) { selectionKind = kind; selectedRange = null; }
  `,
    c,
  );
  c.removeSelected();
  assert.equal(c.history.length, 1);
  assert.equal(c.playhead, 1);
  assert.equal(c.selectedRange, null);
  const removed = json(c.edits);
  assert.equal(duration(c.edits), 16);
  assert.equal(c.edits.zooms.length, 1);
  assert.equal(c.edits.layers.length, 1);
  c.undo();
  assert.deepEqual(json(c.edits), original);
  assert.equal(c.history.length, 0);
  c.redo();
  assert.deepEqual(json(c.edits), removed);
  assert.equal(c.history.length, 1);
});

function dragHarness() {
  class Target {
    listeners = new Map();
    scrollLeft = 100;
    captured = null;
    addEventListener(type, fn) {
      const list = this.listeners.get(type) || new Set();
      list.add(fn);
      this.listeners.set(type, list);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    emit(type, value = {}) {
      for (const fn of [...(this.listeners.get(type) || [])]) fn(value);
    }
    getBoundingClientRect() {
      return { left: 0, right: 500, width: 500 };
    }
    setPointerCapture(id) {
      this.captured = id;
    }
    hasPointerCapture(id) {
      return this.captured === id;
    }
    releasePointerCapture() {
      this.captured = null;
      this.emit("lostpointercapture");
    }
  }
  const window = new Target(),
    owner = new Target(),
    scroll = new Target();
  const frames = new Map(),
    updates = [],
    finishes = [];
  let id = 0;
  const sandbox = vm.createContext({
    window,
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => {
      frames.set(++id, fn);
      return id;
    },
    cancelAnimationFrame: (key) => frames.delete(key),
  });
  vm.runInContext(dragSource, sandbox);
  sandbox.timelineDrag(
    { pointerId: 1, clientX: 100 },
    owner,
    owner,
    scroll,
    10,
    (...args) => updates.push(args),
    (...args) => finishes.push(args),
  );
  return {
    window,
    owner,
    scroll,
    updates,
    finishes,
    frames,
    step() {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach((fn) => fn(16));
    },
    clean() {
      assert.equal(owner.captured, null);
      assert.equal(frames.size, 0);
      for (const t of [window, owner, scroll])
        for (const set of t.listeners.values()) assert.equal(set.size, 0);
    },
  };
}
test("timeline drag batches pointer updates, includes scrolling and flushes final position exactly once", () => {
  const h = dragHarness();
  h.window.emit("pointermove", { pointerId: 2, buttons: 1, clientX: 300 });
  assert.equal(h.frames.size, 0);
  h.window.emit("pointermove", { pointerId: 1, buttons: 1, clientX: 160 });
  h.window.emit("pointermove", { pointerId: 1, buttons: 1, clientX: 200 });
  assert.equal(h.frames.size, 1);
  h.step();
  assert.deepEqual(h.updates, [[2, 4]]);
  h.scroll.scrollLeft = 150;
  h.scroll.emit("scroll");
  h.step();
  assert.deepEqual(h.updates.at(-1), [2, 5]);
  h.window.emit("pointerup", { pointerId: 1, clientX: 250 });
  assert.deepEqual(h.updates.at(-1), [2, 6]);
  assert.deepEqual(h.finishes, [[true, true]]);
  h.clean();
});
test("timeline drag cancellation rolls back on Escape, blur, lost capture and pointer cancellation", () => {
  for (const cancel of [
    "Escape",
    "blur",
    "lostpointercapture",
    "pointercancel",
  ]) {
    const h = dragHarness();
    h.window.emit("pointermove", { pointerId: 1, buttons: 1, clientX: 200 });
    h.step();
    if (cancel === "Escape")
      h.window.emit("keydown", {
        key: "Escape",
        preventDefault() {},
        stopImmediatePropagation() {},
      });
    else (cancel === "lostpointercapture" ? h.owner : h.window).emit(cancel);
    assert.deepEqual(h.finishes, [[false, true]], cancel);
    h.clean();
  }
  const click = dragHarness();
  click.window.emit("pointerup", { pointerId: 1, clientX: 102 });
  assert.deepEqual(click.finishes, [[true, false]]);
  assert.equal(click.updates.length, 0);
  click.clean();
});
