import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Controller checks use fake devices and clocks. No app, camera or UI E2E run.
const source = stripTypeScriptTypes(
  (await readFile(new URL("../src/webcam-take.ts", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?from "[^"]+";/gm, "")
    .replace("export class WebcamTake", "class WebcamTake"),
  { mode: "transform" },
);
const recorderSource = stripTypeScriptTypes(
  (
    await readFile(new URL("../src/recording.ts", import.meta.url), "utf8")
  ).replace("export function startRecorder", "function startRecorder"),
  { mode: "transform" },
);

test("webcam takes keep the editor visible; screen capture still minimizes it", async () => {
  const main = await readFile(
    new URL("../desktop/main.mjs", import.meta.url),
    "utf8",
  );
  const handler = main.match(
    /handle\("recordingReady", (\(\) => \{[\s\S]*?\n\})\);/,
  )[1];
  for (const kind of ["webcam-take", "screen"]) {
    const calls = [];
    vm.runInNewContext(`(${handler})()`, {
      recording: { kind, previewExcluded: true },
      win: { minimize: () => calls.push("minimize") },
      recordingPreview: { showInactive: () => calls.push("floating preview") },
      refreshRecordingMenu: () => calls.push("menu"),
    });
    assert.deepEqual(
      calls,
      kind === "webcam-take"
        ? ["menu"]
        : ["minimize", "floating preview", "menu"],
    );
  }
});

function setup({ rejectMicrophone = false, rejectAppend = false } = {}) {
  const elements = new Map(),
    tracks = [],
    calls = [],
    frames = new Map();
  let now = 1000,
    frame = 0;
  const state = {
    project: { id: "project", revision: "saved", edits: {} },
    time: 2,
    total: 8,
    playing: false,
  };
  class Element extends EventTarget {
    disabled = false;
    hidden = false;
    open = false;
    options = [];
    value = "";
    add(option) {
      this.options.push(option);
      if (this.options.length === 1) this.value = option.value;
    }
    replaceChildren() {
      this.options = [];
      this.value = "";
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    }
    async play() {}
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  class Stream {
    constructor(tracks) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t.kind === "video");
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t.kind === "audio");
    }
  }
  class Recorder extends EventTarget {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    start() {
      this.state = "recording";
      queueMicrotask(() => this.dispatchEvent(new Event("start")));
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["captured-media"]) });
      this.dispatchEvent(new Event("stop"));
    }
  }
  const studio = {
    beginTake: async (...args) => {
      calls.push(["begin", ...args]);
      return { id: "take" };
    },
    append: async (...args) => {
      // Ensure stop waits for the final asynchronous chunk before finalization.
      await new Promise((resolve) => setImmediate(resolve));
      calls.push(["append", ...args]);
      if (rejectAppend) throw new Error("Disk full");
    },
    finishTake: async (...args) => {
      calls.push(["finish", ...args]);
      return { project: state.project, layerId: "layer" };
    },
    recordingReady: async () => {
      calls.push(["ready"]);
    },
    abort: async (id) => {
      calls.push(["abort", id]);
    },
  };
  const context = {
    loadRecordingPreferences: async () => ({
      camera: null,
      microphone: { deviceId: "mic" },
    }),
    saveRecordingPreferences: async () => {},
    flushRecordingPreferences: async () => {},
    devicePreference: () => ({}),
    populateDevices: (select, devices, kind, preference) => {
      for (const d of devices.filter((d) => d.kind === kind))
        select.add({ value: d.deviceId });
      if (preference) select.value = preference.deviceId;
    },
    console,
    Event,
    Error,
    setTimeout,
    clearTimeout,
    Date: { now: () => now },
    Option: class {
      constructor(label, value) {
        this.label = label;
        this.value = value;
      }
    },
    document: { body: { insertAdjacentHTML() {} }, querySelector: get },
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "videoinput", deviceId: "camera", label: "Camera" },
          { kind: "audioinput", deviceId: "mic", label: "Microphone" },
        ],
        getUserMedia: async (constraints) => {
          if (constraints.audio && rejectMicrophone)
            throw new Error("Microphone denied");
          const track = {
            kind: constraints.video ? "video" : "audio",
            stopped: false,
            stop() {
              this.stopped = true;
            },
          };
          tracks.push(track);
          return new Stream([track]);
        },
      },
    },
    window: { studio },
    MediaStream: Stream,
    MediaRecorder: Recorder,
    requestAnimationFrame: (fn) => {
      frames.set(++frame, fn);
      return frame;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    clock: String,
  };
  vm.createContext(context);
  vm.runInContext(
    `${recorderSource}\n${source}\nglobalThis.Controller = WebcamTake;`,
    context,
  );
  const controller = new context.Controller({
    state: () => state,
    prepare: async () => {
      calls.push(["save"]);
    },
    play: () => {
      state.playing = true;
      calls.push(["play"]);
    },
    pause: () => {
      state.playing = false;
    },
    preview: (stream) => calls.push(["preview", stream]),
    block: (active) => calls.push(["block", active]),
    commit: (...args) => calls.push(["commit", ...args]),
    error: (error) => calls.push(["error", error.message]),
  });
  return {
    controller,
    calls,
    tracks,
    get,
    state,
    start: async () => {
      get("#start-take").onclick();
      await controller.starting;
    },
    tick: (time, ms) => {
      now = ms;
      state.time = time;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((fn) => fn());
    },
  };
}

test("recording plays the existing video and waits for the final chunk before inserting at the playhead", async () => {
  const s = setup();
  await s.controller.open();
  await s.start();
  assert.equal(s.controller.active, true);
  assert.deepEqual(
    s.calls.map((c) => c[0]),
    ["block", "save", "begin", "preview", "ready", "play"],
  );
  s.tick(2.2, 1500);
  s.tick(2.8, 2100);
  await s.controller.stop();
  const names = s.calls.map((c) => c[0]);
  assert.ok(names.indexOf("append") < names.indexOf("finish"));
  const finish = s.calls.find((c) => c[0] === "finish");
  assert.equal(finish[2][0].output, 2);
  assert.ok(Math.abs(finish[2][0].media - 0.3) < 0.001);
  assert.equal(s.calls.find((c) => c[0] === "commit")[3], 2);
  assert.equal(s.controller.active, false);
  assert.equal(s.state.playing, false);
  assert.ok(s.tracks.every((t) => t.stopped));
  assert.ok(!names.includes("abort"));
  const previews = s.calls.filter((c) => c[0] === "preview");
  assert.equal(previews[0][1].getVideoTracks().length, 1);
  assert.equal(previews.at(-1)[1], null);
});

test("a microphone permission failure releases devices and allows retry with microphone off", async () => {
  const s = setup({ rejectMicrophone: true });
  await s.controller.open();
  await s.start();
  assert.equal(s.controller.active, false);
  assert.equal(s.get("#take-error").textContent, "Microphone denied");
  assert.equal(s.get("#start-take").disabled, false);
  assert.ok(s.tracks[0].stopped);
  s.get("#take-microphone").value = "";
  await s.start();
  assert.equal(s.controller.active, true);
  s.tick(2.2, 1300);
  s.tick(2.5, 1600);
  await s.controller.stop();
  assert.ok(s.calls.some((c) => c[0] === "commit"));
  assert.ok(s.tracks.every((t) => t.stopped));
});

test("a failed media write prevents insertion and releases the recording session", async () => {
  const s = setup({ rejectAppend: true });
  await s.controller.open();
  await s.start();
  s.tick(2.2, 1300);
  s.tick(2.5, 1600);
  await s.controller.stop();
  assert.ok(!s.calls.some((c) => c[0] === "finish" || c[0] === "commit"));
  assert.ok(s.calls.some((c) => c[0] === "error" && c[1] === "Disk full"));
  assert.ok(s.calls.some((c) => c[0] === "abort"));
  assert.equal(s.controller.active, false);
  assert.ok(s.tracks.every((t) => t.stopped));
});
