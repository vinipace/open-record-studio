import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const compile = async (file) =>
  stripTypeScriptTypes(
    (await readFile(new URL(`../src/${file}.ts`, import.meta.url), "utf8"))
      .replace(/^import[\s\S]*?from "[^"]+";/gm, "")
      .replaceAll("export ", ""),
    { mode: "transform" },
  );
const source = await compile("timeline-viewport");
const { maxTimelineScale, timelineZoomAt, timelineSlice, timelineTicks } =
  vm.runInNewContext(
    source +
      "\n({ maxTimelineScale, timelineZoomAt, timelineSlice, timelineTicks })",
  );

test("long recordings can reach 240 pixels/second while extreme timelines stay within layout bounds", () => {
  for (const width of [640, 1200, 2500]) {
    for (const duration of [60, 1830.721667, 7200]) {
      const scale = maxTimelineScale(duration, width);
      assert(scale > 6);
      assert((scale * width - 132) / duration >= 239.999);
    }
    assert(maxTimelineScale(86400, width) * width <= 8_000_000);
  }
});

test("pinching keeps the same time under the pointer after horizontal scrolling and at deep zoom", () => {
  const width = 1400,
    duration = 1830;
  for (const scale of [1, 6, 80, 300]) {
    for (const pointer of [130, 400, 900, 1350]) {
      for (const position of [0, 0.2, 0.8, 1]) {
        const scroll = position * width * (scale - 1);
        const time =
          ((scroll + pointer - 112) / (width * scale - 132)) * duration;
        const next = timelineZoomAt(scale, scale * 1.5, scroll, width, pointer);
        const after =
          ((next + pointer - 112) / (width * scale * 1.5 - 132)) * duration;
        assert(Math.abs(time - after) < 1e-9);
        const back = timelineZoomAt(scale * 1.5, scale, next, width, pointer);
        assert(Math.abs(back - scroll) < 1e-7);
      }
    }
  }
  assert.equal(timelineZoomAt(300, 1, 0, width, 800), 0);
  assert.equal(timelineZoomAt(300, 1, 418600, width, 800), 0);
});

test("pinch batches wheel bursts, prevents page zoom, and leaves ordinary scrolling alone", () => {
  const frames = new Map();
  let nextFrame = 0,
    wheel,
    options,
    enabled = true,
    scale = 1;
  const changes = [];
  const attach = vm.runInNewContext(source + "\nattachTimelinePinch", {
    requestAnimationFrame(fn) {
      frames.set(++nextFrame, fn);
      return nextFrame;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  });
  const element = {
    clientWidth: 1000,
    getBoundingClientRect: () => ({ left: 200 }),
    addEventListener(type, fn, config) {
      assert.equal(type, "wheel");
      wheel = fn;
      options = config;
    },
    removeEventListener(type, fn) {
      assert.equal(type, "wheel");
      assert.equal(fn, wheel);
    },
  };
  const cleanup = attach(element, {
    enabled: () => enabled,
    scale: () => scale,
    maximum: () => 400,
    zoom(value, pointer) {
      scale = value;
      changes.push([value, pointer]);
    },
  });
  const dispatch = (overrides = {}) => {
    let prevented = false;
    wheel({
      ctrlKey: false,
      metaKey: false,
      deltaMode: 0,
      deltaY: -5,
      clientX: 600,
      preventDefault() {
        prevented = true;
      },
      ...overrides,
    });
    return prevented;
  };
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn());
  };
  assert.equal(options.passive, false);
  assert.equal(dispatch(), false);
  assert.equal(frames.size, 0);
  for (let i = 0; i < 20; i++) assert.equal(dispatch({ ctrlKey: true }), true);
  assert.equal(changes.length, 0);
  assert.equal(frames.size, 1);
  flush();
  assert(Math.abs(scale - Math.E) < 1e-10);
  assert.equal(changes[0][1], 400);
  for (let i = 0; i < 40; i++) dispatch({ ctrlKey: true, deltaY: -240 });
  flush();
  assert.equal(scale, 400);
  for (let i = 0; i < 40; i++) dispatch({ ctrlKey: true, deltaY: 240 });
  flush();
  assert.equal(scale, 1);
  dispatch({ metaKey: true, deltaMode: 1, deltaY: -1 });
  flush();
  assert(Math.abs(scale - Math.exp(0.16)) < 1e-10);
  enabled = false;
  assert.equal(dispatch({ ctrlKey: true }), false);
  cleanup();
  assert.equal(frames.size, 0);
});

test("visible slices bound waveform memory and thumbnail work independently of recording length", () => {
  const width = 1830 * 240;
  for (const left of [0, 512, 200000, width - 1100]) {
    const slice = timelineSlice(0, width, { left, width: 1100 });
    assert(slice.width <= 1100 + 2048);
    assert(slice.offset <= left);
    assert(slice.offset + slice.width >= Math.min(width, left + 1100));
    assert(Math.abs(slice.from * width - slice.offset) < 1e-8);
    const count = Math.ceil(width / 100);
    assert(Math.ceil(slice.to * count) - Math.floor(slice.from * count) < 34);
  }
  const first = timelineSlice(0, width, { left: 200000, width: 1100 });
  const next = timelineSlice(0, width, { left: 200001, width: 1100 });
  assert.deepEqual(first, next, "one-pixel scrolling reuses painted pixels");
  assert.equal(timelineSlice(0, 100, { left: 10000, width: 1100 }).width, 0);
  assert.equal(timelineSlice(10000, 100, { left: 0, width: 1100 }).width, 0);
});

test("ruler maintains useful density, precise timestamps and bounded labels at every zoom", () => {
  const total = 1830;
  for (const scale of [1, 6, 60, 400]) {
    const width = 1200 * scale - 132;
    const left = width * 0.7;
    const { ticks, spacing } = timelineTicks(total, width, {
      left,
      width: 1068,
    });
    assert(ticks.length >= 4 && ticks.length <= 14);
    assert(spacing >= 99 && spacing <= 251);
    assert(
      ticks.every(
        (tick) =>
          tick.left >= left - spacing && tick.left <= left + 1068 + spacing,
      ),
    );
    if (scale === 400) assert(ticks.some((tick) => tick.label.includes(".")));
  }
  const end = timelineTicks(60, 14400, { left: 14200, width: 200 });
  assert.equal(end.ticks.at(-1).label, "01:00.0");
});

test("windowed waveforms preserve source offset and cut timing at deep zoom", async () => {
  const marks = [];
  const draw = vm.runInNewContext(
    (await compile("waveform")) + "\ndrawWaveform",
    {
      window: { devicePixelRatio: 2 },
    },
  );
  const peaks = new Float32Array(200000);
  peaks.fill(0.9, 100020, 100040);
  const waveform = { peaks, step: 0.01, maximum: 0.9, duration: 2000 };
  // A retained clip starts at source 900s, plays at 2x, microphone begins 5s late.
  const slice = timelineSlice(300, 500 * 240, { left: 12800, width: 1100 });
  const from = 900 + 1000 * slice.from,
    to = 900 + 1000 * slice.to;
  const canvas = {
    getContext: () => ({ scale() {}, fillRect: (...args) => marks.push(args) }),
  };
  draw(
    canvas,
    { microphone: waveform },
    { tracks: { microphone: { offset: 5 } } },
    { style: { microphoneVolume: 1 } },
    from,
    to,
    slice.width,
  );
  assert(canvas.width <= 6300);
  assert(marks.length > 1);
  for (const [x, , barWidth] of marks.slice(1)) {
    const time = from + ((to - from) * (x + barWidth / 2)) / slice.width;
    assert(time > 1005.15 && time < 1005.45, `misaligned transient at ${time}`);
  }
});

// Exercise the real retained view without launching or recording in the app.
class Element {
  children = [];
  dataset = {};
  style = {
    setProperty(key, value) {
      this[key] = value;
    },
  };
  attrs = {};
  parts = {};
  classList = { toggle() {} };
  set innerHTML(value) {
    this.replaceChildren();
    if (value.includes('class="filmstrip"')) {
      this.parts = Object.fromEntries(
        [
          "small",
          ".filmstrip",
          ".clip-label > span",
          '[data-trim="start"]',
          '[data-trim="end"]',
        ].map((key) => [key, new Element()]),
      );
      this.append(...Object.values(this.parts));
    }
  }
  querySelector(key) {
    return this.parts[key] || null;
  }
  setAttribute(key, value) {
    this.attrs[key] = value;
  }
  getAttribute(key) {
    return this.attrs[key];
  }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      node.remove();
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (node) => node !== this,
      );
    this.parentElement = null;
  }
  replaceChildren() {
    for (const node of [...this.children]) node.remove();
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
}

test("the actual timeline view keeps thumbnail nodes and peak canvases bounded while zooming and scrolling a long clip", async () => {
  const roots = Object.fromEntries(
    ["screen", "camera", "audio"].map((key) => [`#${key}-lane`, new Element()]),
  );
  roots["#ticks"] = new Element();
  const paints = [];
  const View = vm.runInNewContext(
    (await compile("timeline-view")) + "\nTimelineView",
    {
      document: {
        querySelector: (key) => roots[key],
        createElement: () => new Element(),
      },
      window: { devicePixelRatio: 2 },
      timelineSlice,
      timelineTicks,
      audibleRanges: (_edits, segment) => [segment],
      clock: (time) => String(time),
      frameAt: (_frames, time) => `frame-${time.toFixed(2)}`,
      drawWaveform: (...args) => paints.push(args),
    },
  );
  const view = new View(() => "icon");
  view.renderZooms = () => {};
  const track = { duration: 3600, offset: 0, audio: true };
  const project = {
    id: "long",
    tracks: {
      screen: track,
      camera: track,
      microphone: { ...track, offset: 0.5 },
    },
  };
  const edits = {
    segments: [{ start: 0, end: 3600 }],
    style: { speed: 1, volume: 1, microphoneVolume: 1, cameraOffset: 0 },
  };
  const filmstrips = { screen: {}, camera: {} },
    waveform = { status: "ready", tracks: {} };
  const render = (left, scale = 240) =>
    view.render(
      project,
      edits,
      0,
      "",
      filmstrips,
      3600,
      false,
      waveform,
      3600 * scale,
      null,
      { left, width: 1100 },
    );
  render(200000);
  const clip = roots["#screen-lane"].children[0];
  const strip = clip.querySelector(".filmstrip");
  const canvas = roots["#audio-lane"].children[0].children[0];
  assert(strip.children.length > 10 && strip.children.length < 34);
  assert(roots["#ticks"].children.length < 15);
  assert(paints.at(-1)[6] <= 3148, "canvas only paints viewport and overscan");
  assert(paints.at(-1)[4] < 200000 / 240);
  assert(paints.at(-1)[5] > 201100 / 240);
  const thumbs = [...strip.children],
    firstPaintCount = paints.length;
  render(200001);
  assert.equal(paints.length, firstPaintCount);
  assert.deepEqual(strip.children, thumbs);
  render(280000);
  assert.equal(roots["#screen-lane"].children[0], clip);
  assert.equal(roots["#audio-lane"].children[0].children[0], canvas);
  assert(strip.children.length < 34);
  assert(
    paints.at(-1)[4] > 1100,
    "scrolled waveform reads the correct source time",
  );
  render(500000, 1200);
  assert(
    strip.children.length < 34,
    "even a 4-million-pixel lane stays bounded",
  );
  assert(paints.at(-1)[6] <= 3148);
  // At fit, the complete clip is visible again using the same retained nodes.
  render(0, 0.3);
  assert.equal(roots["#screen-lane"].children[0], clip);
  assert.equal(paints.at(-1)[4], 0);
  assert.equal(paints.at(-1)[5], 3600);
});
