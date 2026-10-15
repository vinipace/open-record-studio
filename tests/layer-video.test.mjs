import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = stripTypeScriptTypes(
  (await readFile(new URL("../src/layer-video.ts", import.meta.url), "utf8"))
    .replace(/^import[^;]+;/gm, "")
    .replace("export class LayerVideo", "class LayerVideo"),
  { mode: "transform" },
);
const cutSource = stripTypeScriptTypes(
  (await readFile(new URL("../src/cut-media.ts", import.meta.url), "utf8"))
    .replace(/^import[^;]+;/gm, "")
    .replace("export class CutMedia", "class CutMedia"),
  { mode: "transform" },
);
function setup() {
  let now = 1000,
    current = 0,
    copyCount = 0,
    callback = 0;
  const seeks = [],
    callbacks = new Map();
  const video = Object.assign(new EventTarget(), {
    readyState: 4,
    duration: 20,
    seeking: false,
    paused: true,
    videoWidth: 1920,
    videoHeight: 1080,
    playbackRate: 1,
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    requestVideoFrameCallback(fn) {
      callbacks.set(++callback, fn);
      return callback;
    },
    cancelVideoFrameCallback(id) {
      callbacks.delete(id);
    },
  });
  Object.defineProperty(video, "currentTime", {
    get: () => current,
    set: (time) => {
      current = time;
      seeks.push(time);
      video.seeking = true;
      video.readyState = 1;
    },
  });
  const frame = {
    width: 300,
    height: 150,
    getContext: () => ({ drawImage: () => copyCount++ }),
  };
  const context = vm.createContext({
    HTMLVideoElement: class {},
    document: { createElement: () => frame },
    performance: { now: () => now },
  });
  vm.runInContext(
    cutSource + source + "\nglobalThis.LayerVideo = LayerVideo;",
    context,
  );
  const decoder = new context.LayerVideo(video, () => {});
  return {
    decoder,
    video,
    frame,
    seeks,
    callbacks,
    copies: () => copyCount,
    time: (ms, media) => {
      now = ms;
      current = media;
    },
    presented: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((fn) => fn());
    },
    seeked: () => {
      video.seeking = false;
      video.readyState = 4;
      video.dispatchEvent(new Event("seeked"));
    },
  };
}

test("a late audio/video follower catches up without seeking every frame", () => {
  const s = setup();
  let media = 2 - 0.12;
  for (let i = 0; i < 240; i++) {
    s.time(1000 + (i * 1000) / 120, media);
    s.decoder.sync(2 + i / 120, 1, true);
    media += s.video.playbackRate / 120;
  }
  assert.equal(s.seeks.length, 0);
  assert.ok(Math.abs(media - 4) < 0.06);
  assert.ok(s.video.playbackRate <= 1.05);
});

test("the last decoded frame stays visible throughout seeking and buffering", () => {
  const s = setup();
  s.presented();
  assert.equal(s.copies(), 1);
  assert.equal(s.frame.width, 1280);
  assert.equal(s.frame.height, 720);
  s.decoder.sync(3, 1, true, true);
  for (let i = 0; i < 30; i++) {
    s.presented();
    assert.equal(s.decoder.image(), s.frame);
  }
  assert.equal(
    s.copies(),
    1,
    "do not copy unavailable frames or repeat cached draws",
  );
  s.seeked();
  assert.equal(s.copies(), 2);
  assert.equal(s.decoder.image(), s.frame);
});

test("scrubbing queues only the latest target and cuts can seek immediately", () => {
  const s = setup();
  s.decoder.sync(2, 1, false);
  s.decoder.sync(4, 1, false);
  s.decoder.sync(6, 1, false);
  assert.deepEqual(s.seeks, [2]);
  s.seeked();
  assert.deepEqual(s.seeks, [2, 6]);
  s.seeked();
  s.decoder.sync(10, 2, true, true);
  assert.deepEqual(s.seeks, [2, 6, 10]);
  assert.equal(s.video.playbackRate, 2);
  s.decoder.dispose();
  assert.equal(s.callbacks.size, 0);
  assert.equal(s.frame.width, 0);
});

test("buffering recovery is bounded instead of becoming a seek loop", () => {
  const s = setup();
  s.decoder.sync(2, 1, true);
  assert.deepEqual(s.seeks, [2]);
  s.seeked();
  for (let i = 0; i < 60; i++) {
    s.time(1000 + (i * 1000) / 120, 2);
    s.decoder.sync(2 + i / 120, 1, true);
  }
  assert.equal(s.seeks.length, 1);
});
