import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const source = stripTypeScriptTypes(
  (await fs.readFile(new URL("../src/cut-media.ts", import.meta.url), "utf8"))
    .replace(/^import[^;]+;/gm, "")
    .replace("export class CutMedia", "class CutMedia"),
  { mode: "transform" },
);
function setup() {
  let now = 1000,
    copies = 0;
  const all = [];
  const gains = new Map();
  class Video extends EventTarget {
    tagName = "VIDEO";
    src = "test.mp4";
    crossOrigin = "anonymous";
    readyState = 4;
    duration = 20;
    seeking = false;
    paused = false;
    muted = false;
    volume = 0.7;
    playbackRate = 1;
    current = 1;
    videoWidth = 1920;
    videoHeight = 1080;
    seeks = [];
    plays = 0;
    get currentTime() {
      return this.current;
    }
    set currentTime(value) {
      this.current = value;
      this.seeks.push(value);
      this.seeking = true;
      this.readyState = 1;
    }
    pause() {
      this.paused = true;
    }
    play() {
      this.paused = false;
      this.plays++;
      return Promise.resolve();
    }
    load() {}
    removeAttribute() {
      this.src = "";
    }
    finishSeek() {
      this.seeking = false;
      this.readyState = 4;
      this.dispatchEvent(new Event("seeked"));
    }
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => copies++ }),
  };
  const active = new Video();
  all.push(active);
  const c = vm.createContext({
    MediaAudio: class {
      constructor(el) {
        this.el = el;
        el.volume = 1;
        el.muted = false;
      }
      set(value) {
        gains.set(this.el, value);
      }
      dispose() {
        gains.delete(this.el);
      }
    },
    resumeMediaAudio() {},
    HTMLVideoElement: Video,
    performance: { now: () => now },
    document: {
      createElement: (tag) => {
        if (tag === "canvas") return canvas;
        const video = new Video();
        all.push(video);
        return video;
      },
    },
  });
  vm.runInContext(source + "\nglobalThis.CutMedia=CutMedia", c);
  const bank = new c.CutMedia(active);
  bank.setVolume(0.7);
  return {
    bank,
    active,
    all,
    gains,
    canvas,
    copies: () => copies,
    advance: (ms) => (now += ms),
  };
}

test("a prepared cut swaps live audio/video without seeking or restarting the incoming decoder", () => {
  const h = setup();
  h.bank.prepare("cut-1", 6, 2, 1);
  const next = h.all[1];
  assert.equal(h.gains.get(next), 0, "preroll is silent at the mixer");
  assert.equal(next.volume, 1, "keep its native audio sink running");
  assert.equal(h.gains.get(h.active), 0.7);
  assert.deepEqual(h.active.seeks, []);
  assert.deepEqual(next.seeks, [4]);
  next.finishSeek();
  next.current = 5.99;
  const plays = next.plays;
  assert(h.bank.handoff("cut-1", 6, 1));
  assert.equal(h.bank.element, next);
  assert.equal(h.gains.get(next), 0.7);
  assert.equal(next.volume, 1, "handoff does not change media element volume");
  assert.equal(next.paused, false);
  assert.equal(next.plays, plays);
  assert.deepEqual(
    next.seeks,
    [4],
    "handoff does not flush the prepared decoder",
  );
  assert.equal(h.active.paused, true);
  assert.equal(h.gains.get(h.active), 0);
  h.bank.prepare("cut-2", 10, 2, 1);
  assert.equal(
    h.all.length,
    2,
    "reuse the two decoders instead of leaking one per cut",
  );
});

test("buffered cuts require the matching ready decoder and cancellation stops all preroll", () => {
  const h = setup();
  h.bank.prepare("next", 6, 8, 1);
  assert.equal(h.all.length, 1, "no extra decoder for a distant cut");
  h.bank.prepare("next", 6, 2, 1);
  assert.equal(
    h.bank.handoff("next", 6, 1),
    false,
    "do not hand off while seeking",
  );
  const next = h.all[1];
  next.finishSeek();
  next.current = 6;
  assert.equal(h.bank.handoff("outdated", 6, 1), false);
  h.bank.cancel();
  assert.equal(next.paused, true);
  assert.equal(h.bank.handoff("next", 6, 1), false);
  assert.equal(h.bank.element, h.active);
  h.bank.reset();
  assert.equal(next.src, "");
});

test("an unprepared seek keeps its previous decoded frame and only queues the latest scrub position", () => {
  const h = setup();
  h.bank.seek(3);
  assert.equal(h.bank.image(), h.canvas);
  assert.equal(h.canvas.width, 1280);
  assert.equal(h.copies(), 1);
  h.bank.seek(4);
  h.bank.seek(9);
  assert.deepEqual(h.active.seeks, [3]);
  h.active.finishSeek();
  assert.deepEqual(h.active.seeks, [3, 9]);
  h.active.finishSeek();
  assert.equal(h.bank.image(), h.active);
});

test("follower clock corrections adjust rate without repeated GOP seeks", () => {
  const h = setup();
  for (let i = 0; i < 240; i++) {
    const desired = 1.12 + i / 120;
    h.bank.follow(desired, 1);
    h.active.current += h.active.playbackRate / 120;
    h.advance(1000 / 120);
  }
  assert.equal(h.active.seeks.length, 0);
  assert(Math.abs(h.active.current - 3.12) < 0.04);
  assert(h.active.playbackRate >= 0.92 && h.active.playbackRate <= 1.08);
});

test("preroll uses playback speed and waits at source start without repeatedly seeking", () => {
  const h = setup();
  h.bank.prepare("fast", 2, 2, 2);
  const next = h.all[1];
  next.finishSeek();
  assert.equal(next.paused, true);
  h.bank.prepare("fast", 2, 1, 2);
  assert.equal(next.paused, false);
  for (let i = 0; i < 40; i++) {
    h.bank.prepare("fast", 2, 1 - i / 60, 2);
    next.current += next.playbackRate / 60;
  }
  assert.deepEqual(next.seeks, [0]);
  assert.deepEqual(h.active.seeks, []);
});

test("editor synchronization prepares matching keys, switches its media clock and skips contiguous splits", async () => {
  const main = await fs.readFile(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const sync = stripTypeScriptTypes(
    main.match(/^function syncMedia\([\s\S]*?^}/m)[0],
    { mode: "transform" },
  );
  const timeline = stripTypeScriptTypes(
    (await fs.readFile(new URL("../src/timeline.ts", import.meta.url), "utf8"))
      .replace(/^import[^;]+;/gm, "")
      .replace(/export /g, ""),
    { mode: "transform" },
  );
  const calls = [],
    media = {},
    banks = {};
  for (const key of ["screen", "camera", "microphone"]) {
    const el = {
      currentTime: 1.5,
      playbackRate: 1,
      volume: 1,
      paused: false,
      pause() {
        this.paused = true;
      },
    };
    media[key] = el;
    banks[key] = {
      element: el,
      prepare: (...args) => calls.push([key, "prepare", ...args]),
      cancel() {},
      setVolume() {},
      follow() {},
      handoff(id, t) {
        calls.push([key, "handoff", id]);
        this.element = { ...el, currentTime: t };
        return true;
      },
    };
  }
  const c = vm.createContext({
    project: {
      tracks: Object.fromEntries(
        Object.keys(media).map((key) => [
          key,
          { offset: 0, duration: 10, audio: key === "microphone" },
        ]),
      ),
    },
    edits: {
      segments: [
        { start: 0, end: 2 },
        { start: 5, end: 10 },
      ],
      style: { speed: 1, volume: 1, microphoneVolume: 1, cameraOffset: 0 },
    },
    playing: true,
    playhead: 1.5,
    playbackSegment: 0,
    playbackMaster: "microphone",
    playbackBase: 0,
    playbackSourceBase: 0,
    playbackStarted: 0,
    seekRequested: false,
    media,
    cutMedia: banks,
    enhancedAudio: { has: () => false, sync() {} },
    previewMode: "combined",
    performance: { now: () => 1000 },
    audioRemovedAt: () => false,
    canvasMedia: { sync() {} },
    requestSeek() {
      throw new Error("Unexpected active seek");
    },
  });
  vm.runInContext(timeline + sync, c);
  c.syncMedia();
  assert.deepEqual(
    calls.map((call) => call.slice(1)),
    Array(3).fill(["prepare", "1:5:1:0", 5, 0.5, 1]),
  );
  calls.length = 0;
  c.playhead = 2.01;
  c.syncMedia();
  assert.deepEqual(
    calls.map((call) => call.slice(1)),
    Array(3).fill(["handoff", "1:5:1:0"]),
  );
  assert.equal(c.media.microphone, banks.microphone.element);
  assert.equal(c.playbackBase, 2.01);
  assert.equal(c.playbackSourceBase, 5.01);
  calls.length = 0;
  c.edits.segments[1].start = 2;
  c.playbackSegment = 0;
  c.syncMedia();
  assert.deepEqual(
    calls,
    [],
    "a plain split does not seek, preroll or switch decoders",
  );
});
