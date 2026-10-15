// Focused, read-only trace of the real editor's playback loop and audio output.
// Uses a separate Electron profile and never saves the source project.
import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const directory = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const from = Number(process.argv[4] || 0);
const seconds = Number(process.env.FRAME_PROFILE_SECONDS || 5);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "frame-cut-editor-"));
const original = await fs.readFile(path.join(directory, "project.json"));
const app = await electron.launch({
  ...(process.env.FRAME_EXECUTABLE
    ? {
        executablePath: process.env.FRAME_EXECUTABLE,
        args: [`--project=${directory}`],
      }
    : { args: [".", `--project=${directory}`] }),
  env: { ...process.env, FRAME_DATA_DIR: profile },
});
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.hide()),
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(
    () => !document.querySelector("#scrubber").disabled,
  );
  await page.evaluate(() => {
    const trace = (window.cutTrace = {
      events: [],
      frames: [],
      samples: [],
      draws: [],
      elements: [],
      audio: [],
    });
    const ids = new WeakMap(),
      active = {};
    let id = 0,
      start = 0;
    const meters = [];
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args) {
      const result = connect.apply(this, args);
      if (args[0] instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 256;
        connect.call(this, analyser);
        meters.push({ node: analyser, data: new Float32Array(256) });
      }
      return result;
    };
    const register = (el) => {
      if (ids.has(el)) return ids.get(el);
      const i = ++id;
      ids.set(el, i);
      trace.elements.push({ id: i, src: el.src, tag: el.tagName });
      for (const name of [
        "seeking",
        "seeked",
        "waiting",
        "playing",
        "pause",
        "volumechange",
        "ratechange",
        "ended",
      ])
        el.addEventListener(name, () => {
          trace.events.push({
            id: i,
            src: el.src,
            name,
            at: performance.now(),
            time: el.currentTime,
            rate: el.playbackRate,
            volume: el.volume,
            muted: el.muted,
            ready: el.readyState,
          });
        });
      if (el instanceof HTMLVideoElement) {
        const frame = (now, meta) => {
          trace.frames.push({
            id: i,
            src: el.src,
            at: now,
            time: meta.mediaTime,
            active: active[el.src] === el,
          });
          el.requestVideoFrameCallback(frame);
        };
        el.requestVideoFrameCallback(frame);
      }
      return i;
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.id === "preview" && args[0] instanceof HTMLVideoElement) {
        const el = args[0];
        register(el);
        active[el.src] = el;
        if (start)
          trace.draws.push({
            id: ids.get(el),
            src: el.src,
            at: performance.now(),
            time: el.currentTime,
            ready: el.readyState,
            seeking: el.seeking,
          });
      }
      return draw.apply(this, args);
    };
    for (const key of ["play", "pause"]) {
      const fn = HTMLMediaElement.prototype[key];
      HTMLMediaElement.prototype[key] = function (...args) {
        register(this);
        return fn.apply(this, args);
      };
    }
    window.beginCutTrace = () => {
      trace.events = [];
      trace.frames = [];
      trace.samples = [];
      trace.draws = [];
      start = trace.start = performance.now();
      const sample = () => {
        trace.samples.push({
          at: performance.now(),
          time: Number(document.querySelector("#scrubber").value),
          label: document.querySelector("#play").getAttribute("aria-label"),
        });
        for (const [i, meter] of meters.entries()) {
          meter.node.getFloatTimeDomainData(meter.data);
          trace.audio.push({
            id: i,
            at: performance.now(),
            rms: Math.sqrt(
              meter.data.reduce((sum, x) => sum + x * x, 0) / meter.data.length,
            ),
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    };
  });
  await page
    .locator("#scrubber")
    .fill(String(Number((from + 0.01).toFixed(2))));
  await page.locator("#scrubber").fill(String(from));
  if (process.argv.includes("--enhance")) {
    await page.locator("#tab-audio").click();
    await page.locator("#enhanceAudio").check();
    await page.waitForFunction(
      () => !document.querySelector("#play").disabled,
      null,
      { timeout: 120000 },
    );
    assert.equal(
      await page.locator("#enhance-audio-status").isVisible(),
      false,
    );
  }
  await page.waitForTimeout(600);
  await page.evaluate(() => window.beginCutTrace());
  await page.locator("#play").click();
  await page.waitForTimeout(seconds * 1000);
  const trace = await page.evaluate(() => window.cutTrace);
  const cut =
    (JSON.parse(original).edits.segments[0].end -
      JSON.parse(original).edits.segments[0].start) /
    JSON.parse(original).edits.style.speed;
  const boundary = trace.samples.find((s) => s.time >= cut)?.at;
  const frameGaps = {};
  for (const kind of ["screen", "camera"]) {
    const f = trace.frames.filter(
      (f) => f.active && f.src.endsWith("/" + kind),
    );
    const gaps = f.slice(1).map((p, i) => ({ at: p.at, ms: p.at - f[i].at }));
    frameGaps[kind] = {
      frames: f.length,
      max: Math.max(0, ...gaps.map((g) => g.ms)),
      cut: Math.max(
        0,
        ...gaps
          .filter((g) => g.at > boundary - 100 && g.at < boundary + 1200)
          .map((g) => g.ms),
      ),
    };
  }
  let same = 0,
    maxStall = 0,
    previous = -1;
  for (const sample of trace.samples) {
    if (sample.time === previous) {
      if (same === 0) same = sample.at;
      maxStall = Math.max(maxStall, sample.at - same);
    } else same = 0;
    previous = sample.time;
  }
  const audioAfterCut = trace.audio.filter(
    (s) => s.at > boundary && s.at < boundary + 1000,
  );
  const summary = {
    from,
    seconds,
    boundary: boundary - trace.start,
    frameGaps,
    maxStall,
    output: trace.samples.at(-1)?.time,
    audioPeakRmsAfterCut: Math.max(0, ...audioAfterCut.map((s) => s.rms)),
    errors,
  };
  if (process.argv.includes("--enhance")) {
    assert(
      trace.events.some(
        (e) => e.src.includes("/enhanced/") && e.name === "playing",
      ),
      "Enhanced audio decoder must actually play",
    );
    await page.locator("#enhanceAudio").uncheck();
    assert.equal(await page.locator("#play").isDisabled(), false);
    // Undo/redo restores the option and reuses the prepared source cache.
    await page.locator("#undo").click();
    await page.waitForFunction(() => !document.querySelector("#play").disabled);
    assert.equal(await page.locator("#enhanceAudio").isChecked(), true);
    await page.locator("#redo").click();
    assert.equal(await page.locator("#enhanceAudio").isChecked(), false);
    summary.enhanceAudio = true;
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        projectSha256: createHash("sha256").update(original).digest("hex"),
        summary,
        trace,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(summary));
  if (process.argv.includes("--assert")) {
    assert.equal(errors.length, 0, "No renderer errors");
    assert(Number.isFinite(boundary), "Playback must cross the cut");
    assert(maxStall < 80, `Timeline froze for ${maxStall} ms`);
    assert(
      frameGaps.screen.cut < 100,
      "Screen decoder must keep presenting frames",
    );
    assert(
      summary.audioPeakRmsAfterCut > 0.0001,
      "Incoming audio must reach the output mixer",
    );
  }
} finally {
  await app
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
    )
    .catch(() => {});
  await app.close().catch(() => {});
  await fs.rm(profile, { recursive: true, force: true });
  if (
    !(await fs.readFile(path.join(directory, "project.json"))).equals(original)
  )
    throw new Error("Source project changed");
}
