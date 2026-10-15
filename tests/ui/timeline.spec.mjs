import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaults, binary, run, probe } from "../../desktop/media.mjs";

const baseline = process.env.FRAME_PERF_BASELINE === "1";
test("dense timeline keeps clips stable and batches dragging, scrubbing and playback", async () => {
  const root = path.resolve(".cache/timeline-ui");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=60",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=60",
    "-c:a",
    "aac",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "60",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "screen.mp4"),
  ]);
  const meta = await probe(path.join(root, "screen.mp4"));
  const edits = {
    style: { ...defaults },
    segments: Array.from({ length: 100 }, (_, i) => ({
      start: i * 0.6,
      end: i * 0.6 + 0.5,
    })),
    zooms: Array.from({ length: 80 }, (_, i) => ({
      id: `zoom-${i}`,
      start: i * 0.75,
      end: i * 0.75 + 0.7,
      zoom: 1.8,
      focusX: 0.5,
      focusY: 0.5,
      ease: 0.25,
    })),
  };
  await fs.writeFile(
    path.join(root, "project.json"),
    JSON.stringify({
      version: 1,
      kind: "frame-studio",
      name: "Timeline performance",
      duration: 60,
      tracks: {
        screen: { ...meta, file: "screen.mp4", offset: 0 },
        camera: { ...meta, file: "screen.mp4", offset: 0 },
      },
      edits,
    }),
  );
  const app = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? {
          executablePath: process.env.FRAME_EXECUTABLE,
          args: [`--project=${root}`],
        }
      : { args: [".", `--project=${root}`] }),
    env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("#clip-count")).toHaveText("100 clips");
    await expect(
      page.locator('#audio-lane .clip[data-waveform="ready"]'),
    ).toHaveCount(100);
    for (const track of ["screen", "camera"])
      await expect
        .poll(() =>
          page
            .locator(`#${track}-lane .filmstrip [style*=background-image]`)
            .count(),
        )
        .toBeGreaterThan(0);
    const session = await app.context().newCDPSession(page);
    await session.send("Performance.enable");
    const metrics = async () =>
      Object.fromEntries(
        (await session.send("Performance.getMetrics")).metrics.map((m) => [
          m.name,
          m.value,
        ]),
      );
    const before = await metrics();
    const selection = await page.evaluate(async () => {
      const original = document.querySelector("#screen-lane .clip");
      const times = [],
        mutations = [];
      const observer = new MutationObserver((records) =>
        mutations.push(...records.filter((r) => r.type === "childList")),
      );
      observer.observe(document.querySelector(".timeline"), {
        childList: true,
        subtree: true,
      });
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        document.querySelectorAll("#screen-lane .clip")[i].click();
        times.push(performance.now() - start);
        await new Promise(requestAnimationFrame);
      }
      observer.disconnect();
      return {
        times,
        mutations: mutations.length,
        stableClip: document.querySelector("#screen-lane .clip") === original,
      };
    });
    await page.locator("#timeline-scale").fill(Math.log2(3).toFixed(2));
    await page.locator("#tab-clip").click();
    const drag = await page.evaluate(async () => {
      const clip = document.querySelectorAll("#screen-lane .clip")[29],
        handle = clip.querySelector('[data-trim="end"]');
      const rect = handle.getBoundingClientRect(),
        origin = rect.x + rect.width / 2;
      const times = [],
        mutations = [];
      const observer = new MutationObserver((records) =>
        mutations.push(...records.filter((r) => r.type === "childList")),
      );
      observer.observe(document.querySelector(".timeline"), {
        childList: true,
        subtree: true,
      });
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: origin,
          clientY: rect.y + 4,
        }),
      );
      for (let frame = 0; frame < 30; frame++) {
        const start = performance.now();
        for (let i = 0; i < 8; i++)
          window.dispatchEvent(
            new PointerEvent("pointermove", {
              clientX: origin - (frame + (i + 1) / 8) / 3,
            }),
          );
        times.push(performance.now() - start);
        await new Promise(requestAnimationFrame);
      }
      const stableDuringDrag =
        document.querySelectorAll("#screen-lane .clip")[29] === clip;
      window.dispatchEvent(
        new PointerEvent("pointerup", { clientX: origin - 10 }),
      );
      await new Promise(requestAnimationFrame);
      observer.disconnect();
      return {
        times,
        mutations: mutations.length,
        stableDuringDrag,
        stableAfterDrag:
          document.querySelectorAll("#screen-lane .clip")[29] === clip,
        // Duration labels legitimately replace text as trimming crosses frame boundaries.
        // Count element churn separately to detect rebuilding clips or thumbnails.
        elementMutations: mutations.filter((record) =>
          [...record.addedNodes, ...record.removedNodes].some(
            (node) => node.nodeType === Node.ELEMENT_NODE,
          ),
        ).length,
        trimEnd: Number(document.querySelector("#trim-end").value),
      };
    });
    expect(drag.trimEnd).toBeLessThan(edits.segments[29].end);
    await page.locator("#undo").click();
    await expect(page.locator("#trim-end")).toHaveValue(
      edits.segments[29].end.toFixed(2),
    );
    // Continuous reverse scrubbing must paint intermediate decoded frames, not
    // just move the playhead and leave the canvas frozen until pointer release.
    const scrub = await page.evaluate(async () => {
      const input = document.querySelector("#scrubber"),
        canvas = document.querySelector("#preview");
      const draw = CanvasRenderingContext2D.prototype.drawImage,
        samples = [],
        times = [];
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        draw.apply(this, args);
        if (
          this.canvas === canvas &&
          args[0] instanceof HTMLVideoElement &&
          args.length === 9 &&
          args[3] / args[4] > 1.5
        )
          samples.push(args[0].currentTime);
      };
      try {
        for (let frame = 0; frame < 90; frame++) {
          const start = performance.now();
          for (let i = 0; i < 6; i++) {
            input.value = String(5 + 15 * (1 + Math.sin((frame * 6 + i) / 90)));
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          times.push(performance.now() - start);
          await new Promise(requestAnimationFrame);
        }
        return {
          times,
          paintedFrames: samples.length,
          distinctDecodedFrames: new Set(samples.map((t) => t.toFixed(2))).size,
        };
      } finally {
        CanvasRenderingContext2D.prototype.drawImage = draw;
      }
    });
    const after = await metrics();
    // Confirm the last scrub request wins, including after direction changes.
    await page.evaluate(() => {
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      window.timelineDraw = draw;
      window.timelineLastSource = null;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        draw.apply(this, args);
        if (
          this.canvas.id === "preview" &&
          args.length === 9 &&
          args[3] / args[4] > 1.5
        )
          window.timelineLastSource = args[0].currentTime;
      };
    });
    await page.locator("#scrubber").fill("10.37");
    await expect
      .poll(() =>
        page.evaluate(() =>
          Math.abs((window.timelineLastSource ?? -100) - 12.37),
        ),
      )
      .toBeLessThan(0.01);
    await page.evaluate(() => {
      CanvasRenderingContext2D.prototype.drawImage = window.timelineDraw;
    });
    await page.locator("#scrubber").press("ArrowRight");
    await expect(page.locator("#scrubber")).toHaveValue("10.38");
    await page.locator("#scrubber").press("ArrowLeft");
    await expect(page.locator("#scrubber")).toHaveValue("10.37");
    // Drag a fragmented zoom, release before the next animation frame, then
    // undo once. The final queued value must be applied and saved accurately.
    await page.locator("#tab-motion").click();
    await page.locator("#zoom-selector").selectOption("zoom-1");
    const zoomDrag = await page.evaluate(() => {
      const handle = document.querySelector(
        '#zoom-lane [data-zoom-id="zoom-1"] [data-zoom-trim="end"]:not([hidden])',
      );
      const node = handle.parentElement,
        r = handle.getBoundingClientRect(),
        x = r.x + r.width / 2;
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: x }),
      );
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: x - 6 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: x - 6 }));
      return {
        stable: node.isConnected,
        end: Number(document.querySelector("#zoom-end").value),
      };
    });
    expect(zoomDrag.end).toBeLessThan(edits.zooms[1].end);
    if (!baseline) expect(zoomDrag.stable).toBe(true);
    await page.locator("#undo").click();
    await expect(page.locator("#zoom-end")).toHaveValue(
      edits.zooms[1].end.toFixed(2),
    );
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    expect(
      JSON.parse(await fs.readFile(path.join(root, "project.json"))).edits,
    ).toEqual(edits);
    await page.locator("#scrubber").fill("1");
    const playbackBefore = await metrics();
    const traceEvents = [];
    if (process.env.FRAME_TIMELINE_TRACE) {
      session.on("Tracing.dataCollected", ({ value }) =>
        traceEvents.push(...value),
      );
      await session.send("Tracing.start", {
        categories:
          "devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking",
        options: "record-as-much-as-possible",
      });
    }
    await page.locator("#play").click();
    const playback = await page.evaluate(async () => {
      const intervals = [];
      let last = performance.now();
      for (let i = 0; i < 120; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        intervals.push(now - last);
        last = now;
      }
      const play = document.querySelector("#play");
      if (play.getAttribute("aria-label") === "Pause") play.click();
      const head = document.querySelector("#playhead").getBoundingClientRect(),
        lane = document.querySelector("#screen-lane").getBoundingClientRect();
      const time = Number(document.querySelector("#scrubber").value);
      return {
        intervals,
        time,
        alignmentError: Math.abs(
          head.left - (lane.left + (lane.width * time) / 50),
        ),
      };
    });
    const playbackAfter = await metrics();
    if (process.env.FRAME_TIMELINE_TRACE) {
      const done = new Promise((resolve) =>
        session.once("Tracing.tracingComplete", resolve),
      );
      await session.send("Tracing.end");
      await done;
      await fs.mkdir("evidence/timeline", { recursive: true });
      await fs.writeFile(
        "evidence/timeline/chromium-trace.json",
        JSON.stringify(traceEvents),
      );
    }
    const p95 = (times) =>
      [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)];
    const report = {
      packaged: Boolean(process.env.FRAME_EXECUTABLE),
      asarSha256: process.env.FRAME_EXECUTABLE
        ? createHash("sha256")
            .update(
              await fs.readFile(
                path.resolve(
                  path.dirname(process.env.FRAME_EXECUTABLE),
                  "../Resources/app.asar",
                ),
              ),
            )
            .digest("hex")
        : null,
      clips: 100,
      zooms: 80,
      thumbnailTracks: 2,
      selection: {
        p95HandlerMs: p95(selection.times),
        timelineChildMutations: selection.mutations,
        stableClip: selection.stableClip,
      },
      drag: {
        p95BurstHandlerMs: p95(drag.times),
        eventsPerFrame: 8,
        timelineChildMutations: drag.mutations,
        stableDuringDrag: drag.stableDuringDrag,
        stableAfterDrag: drag.stableAfterDrag,
        timelineElementMutations: drag.elementMutations,
      },
      scrub: {
        p95BurstHandlerMs: p95(scrub.times),
        eventsPerFrame: 6,
        paintedFrames: scrub.paintedFrames,
        distinctDecodedFrames: scrub.distinctDecodedFrames,
      },
      playback: {
        p95FrameIntervalMs: p95(playback.intervals),
        frames: playback.intervals.length,
        layoutCount: playbackAfter.LayoutCount - playbackBefore.LayoutCount,
        playheadAlignmentErrorPx: playback.alignmentError,
      },
      chromium: Object.fromEntries(
        [
          "LayoutCount",
          "RecalcStyleCount",
          "LayoutDuration",
          "RecalcStyleDuration",
          "ScriptDuration",
        ].map((k) => [k, after[k] - before[k]]),
      ),
    };
    await fs.mkdir("evidence/timeline", { recursive: true });
    await fs.writeFile(
      `evidence/timeline/${baseline ? "before" : "after"}.json`,
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    if (!baseline) {
      expect(selection.stableClip).toBe(true);
      expect(drag.stableDuringDrag && drag.stableAfterDrag).toBe(true);
      expect(report.selection.p95HandlerMs).toBeLessThan(8);
      expect(report.drag.p95BurstHandlerMs).toBeLessThan(8);
      expect(report.scrub.p95BurstHandlerMs).toBeLessThan(8);
      expect(scrub.distinctDecodedFrames).toBeGreaterThan(15);
      expect(report.selection.timelineChildMutations).toBe(0);
      expect(report.drag.timelineElementMutations).toBe(0);
      expect(report.playback.p95FrameIntervalMs).toBeLessThan(45);
      expect(report.playback.layoutCount).toBeLessThan(45);
      expect(playback.alignmentError).toBeLessThan(1);
      expect(playback.time).toBeGreaterThan(1.5);
    }
  } finally {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app.close().catch(() => {});
  }
});
