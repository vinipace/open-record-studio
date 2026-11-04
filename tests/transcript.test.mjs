import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { binary, run, probe, defaults } from "../desktop/media.mjs";
import { transcribeProject } from "../desktop/transcript.mjs";

const source = stripTypeScriptTypes(
  (await fs.readFile(new URL("../src/transcript.ts", import.meta.url), "utf8"))
    .replace(/^import.*;$/gm, "")
    .replace("export class Transcript", "class Transcript"),
  { mode: "transform" },
);
function controller() {
  const copied = [],
    cancelled = [];
  let resolve, progress;
  const api = {
    onTranscriptProgress: (fn) => {
      progress = fn;
    },
    transcribe: () =>
      new Promise((done) => {
        resolve = done;
      }),
    copyTranscript: async (text) => {
      copied.push(text);
    },
    cancelTranscription: async (...args) => {
      cancelled.push(args);
    },
  };
  const value = vm.runInNewContext(`${source}; new Transcript(() => {}, api)`, {
    api,
    crypto,
    structuredClone,
  });
  return {
    value,
    copied,
    cancelled,
    finish: (text) => resolve(text),
    progress: (message) => progress(message),
  };
}
test("copy transcript copies completed text and leaves the clipboard alone for silence", async () => {
  const { value, copied, finish } = controller();
  let pending = value.copy({ id: "a" }, {});
  assert.equal(value.pending, true);
  finish("Olá, mundo.");
  await pending;
  assert.deepEqual(copied, ["Olá, mundo."]);
  assert.equal(value.message, "Transcript copied.");
  pending = value.copy({ id: "a" }, {});
  finish(" ");
  await pending;
  assert.equal(copied.length, 1);
  assert.match(value.message, /No speech/);
  assert.equal(value.pending, false);
});
test("cancel and project edits discard late results and stale progress", async () => {
  for (const action of ["cancel", "edit", "record"]) {
    const { value, copied, cancelled, finish, progress } = controller();
    value.configure({ id: "a" }, {});
    const pending = value.copy({ id: "a" }, {});
    if (action === "cancel") value.cancel();
    else value.configure({ id: "a" }, { changed: true }, action === "record");
    progress({ requestId: cancelled[0][1], message: "Stale progress" });
    finish("Old transcript");
    await pending;
    assert.equal(copied.length, 0);
    assert.equal(cancelled.length, 1);
    assert.equal(value.pending, false);
    assert.notEqual(value.message, "Stale progress");
  }
});

test("transcription extracts cuts at natural speed, honors muted audio, caches, and cleans up cancellation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-transcript-"));
  try {
    await run(await binary("ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      path.join(root, "audio.wav"),
    ]);
    const project = {
      directory: root,
      duration: 4,
      tracks: {
        screen: {
          ...(await probe(path.join(root, "audio.wav"))),
          file: "audio.wav",
          offset: 0,
          width: 640,
          height: 360,
        },
      },
    };
    const edits = {
      segments: [
        { start: 0, end: 1 },
        { start: 2, end: 4 },
      ],
      removedAudio: [{ start: 0, end: 1 }],
      style: { ...defaults, speed: 2, enhanceAudio: true },
    };
    let calls = 0;
    const transcribe = async (input, output) => {
      calls++;
      const meta = await probe(input);
      assert.ok(
        Math.abs(meta.duration - 3) < 0.01,
        "cut audio is transcribed at natural speed",
      );
      const data = await fs.readFile(input);
      const offset = data.indexOf(Buffer.from("data")) + 8;
      const peak = (start, end) => {
        let peak = 0;
        for (let i = start * 16000; i < end * 16000; i++)
          peak = Math.max(peak, Math.abs(data.readInt16LE(offset + i * 2)));
        return peak;
      };
      assert.equal(peak(0.1, 0.8), 0, "removed audio stays silent");
      assert.ok(peak(1.1, 1.8) > 100, "remaining audio is audible");
      await fs.writeFile(output, JSON.stringify({ text: "Test transcript" }));
    };
    const options = { root: path.join(root, "cache"), transcribe };
    assert.equal(
      await transcribeProject(project, edits, options),
      "Test transcript",
    );
    assert.equal(
      await transcribeProject(project, edits, options),
      "Test transcript",
    );
    assert.equal(calls, 1, "unchanged edit reuses cached transcript");
    await transcribeProject(
      project,
      { ...edits, style: { ...edits.style, volume: 0.5 } },
      options,
    );
    assert.equal(calls, 2, "audio edits invalidate cache");
    const controller = new AbortController();
    await assert.rejects(
      transcribeProject(project, edits, {
        root: path.join(root, "cancel"),
        signal: controller.signal,
        transcribe: async () => {
          controller.abort();
          controller.signal.throwIfAborted();
        },
      }),
      { name: "AbortError" },
    );
    assert.ok(
      !(await fs.readdir(path.join(root, "cancel"))).some((name) =>
        name.startsWith(".transcribe-"),
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
