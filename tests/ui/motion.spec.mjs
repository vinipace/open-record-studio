import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { motionFixture, edits, cursor } from "../motion-fixture.mjs";
import { cropAt, cursorAt, sourceAt } from "../../desktop/motion.mjs";
test.describe.configure({ mode: "serial" });
let app, page, root;
test.beforeAll(async () => {
  root = path.resolve(".cache/motion-ui");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await motionFixture(path.join(root, "project.framestudio"));
  app = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? {
          executablePath: process.env.FRAME_EXECUTABLE,
          args: [`--project=${root}/project.framestudio`],
        }
      : { args: [".", `--project=${root}/project.framestudio`] }),
    env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
  });
  page = await app.firstWindow();
  await expect(page.locator("#project-title")).toHaveText("Motion validation");
});
test.afterAll(async () => {
  await app
    ?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
    )
    .catch(() => {});
  await app?.close().catch(() => {});
});
const pixel = (x, y) =>
  page.evaluate(
    ({ x, y }) => [
      ...document
        .querySelector("#preview")
        .getContext("2d")
        .getImageData(x, y, 1, 1).data,
    ],
    { x, y },
  );
test("rapid scrubbing settles on the requested frame, zoom and cursor match the preview, and playback stays smooth", async () => {
  await page.locator("[data-preview=screen]").click();
  // Rapid direction changes must keep the most recent request instead of
  // interrupting each decoder seek and leaving an old frame on the canvas.
  for (const t of [1.9, 0.15, 2.1, 0.8, 1.25])
    await page.locator("#scrubber").fill(String(t));
  const source = sourceAt(edits, 1.25),
    crop = cropAt(edits, 1.25);
  await expect
    .poll(async () => Math.abs((await pixel(192, 576))[2] - (48 + source * 30)))
    .toBeLessThan(4);
  const colors = await pixel(192, 576);
  expect(Math.abs(colors[0] - (crop.x + 0.15 * crop.size) * 255)).toBeLessThan(
    4,
  );
  expect(Math.abs(colors[1] - (crop.y + 0.8 * crop.size) * 255)).toBeLessThan(
    4,
  );
  const p = cursorAt(cursor, source, edits.style),
    cx = ((p.x - crop.x) / crop.size) * 1280,
    cy = ((p.y - crop.y) / crop.size) * 720;
  const white = await page.evaluate(
    ({ cx, cy }) => {
      const ctx = document.querySelector("#preview").getContext("2d");
      let minX = Infinity,
        minY = Infinity;
      const x = Math.floor(cx - 10),
        y = Math.floor(cy - 10),
        data = ctx.getImageData(x, y, 130, 130).data;
      for (let yy = 0; yy < 130; yy++)
        for (let xx = 0; xx < 130; xx++) {
          const k = (yy * 130 + xx) * 4;
          if (data[k] > 215 && data[k + 1] > 215 && data[k + 2] > 215) {
            minX = Math.min(minX, x + xx);
            minY = Math.min(minY, y + yy);
          }
        }
      return { minX, minY };
    },
    { cx, cy },
  );
  expect(Math.abs(white.minX - cx)).toBeLessThan(7);
  expect(Math.abs(white.minY - cy)).toBeLessThan(12);
  await page.locator("#tab-motion").click();
  await page.locator("#showCursor").uncheck();
  await expect
    .poll(
      async () =>
        await page.evaluate(
          ({ cx, cy }) => {
            const d = document
              .querySelector("#preview")
              .getContext("2d")
              .getImageData(
                Math.round(cx + 10),
                Math.round(cy + 20),
                1,
                1,
              ).data;
            return d[2] < 200;
          },
          { cx, cy },
        ),
    )
    .toBe(true);
  await page.locator("#undo").click();
  await expect(page.locator("#showCursor")).toBeChecked();
  await page.locator("#back").click();
  for (const track of ["screen", "camera"])
    await expect
      .poll(() =>
        page
          .locator(`#${track}-lane .filmstrip [style*=background-image]`)
          .count(),
      )
      .toBeGreaterThan(0);
  await page.locator("[data-preview=combined]").click();
  await page.evaluate(() => {
    window.motionStats = { frames: [], mutations: 0, heads: [], paints: [] };
    // Observe actual Canvas viewports, not just requestAnimationFrame cadence.
    const canvas = document.querySelector("#preview");
    document.querySelector("#scrubber").step = "0.000001";
    window.originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      window.originalDrawImage.apply(this, args);
      if (
        this.canvas !== canvas ||
        args.length !== 9 ||
        !(args[0] instanceof HTMLVideoElement)
      )
        return;
      if (args[3] / args[4] > 1.5) {
        window.motionStats.paints.push({
          wall: performance.now(),
          time: Number(document.querySelector("#scrubber").value),
          x: args[1] / args[0].videoWidth,
          y: args[2] / args[0].videoHeight,
          size: args[3] / args[0].videoWidth,
        });
      } else window.motionCamera = args[0];
    };
    let last = performance.now();
    window.motionObserver = new MutationObserver(
      (m) =>
        (window.motionStats.mutations += m.filter(
          (x) => x.type === "childList",
        ).length),
    );
    window.motionObserver.observe(document.querySelector("#screen-lane"), {
      childList: true,
      subtree: true,
    });
    window.motionCollect = true;
    function tick(t) {
      if (!window.motionCollect) return;
      window.motionStats.frames.push(t - last);
      last = t;
      const head = Number(document.querySelector("#scrubber").value);
      window.motionStats.heads.push(head);
      if (
        !window.motionStats.stall &&
        window.motionCamera &&
        head > 0.48 &&
        head < 0.7
      ) {
        const start = performance.now(),
          nativeSeeking = Object.getOwnPropertyDescriptor(
            HTMLMediaElement.prototype,
            "seeking",
          ).get;
        window.motionStats.stall = { start, end: start + 180, time: head };
        // A follower decoder can seek late without restarting the screen/audio clock.
        Object.defineProperty(window.motionCamera, "seeking", {
          configurable: true,
          get() {
            return performance.now() < start + 180 || nativeSeeking.call(this);
          },
        });
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  await page.locator("#play").click();
  await page.waitForFunction(
    () => Number(document.querySelector("#scrubber").value) > 1.7,
  );
  const stats = await page.evaluate(() => {
    // Stop atomically: a slow test runner must not click Play after natural
    // completion and accidentally measure a second playback from zero.
    const play = document.querySelector("#play");
    if (play.getAttribute("aria-label") === "Pause") play.click();
    window.motionCollect = false;
    window.motionObserver.disconnect();
    CanvasRenderingContext2D.prototype.drawImage = window.originalDrawImage;
    delete window.motionCamera.seeking;
    document.querySelector("#scrubber").step = "0.01";
    return window.motionStats;
  });
  await fs.mkdir("evidence/motion", { recursive: true });
  await fs.writeFile(
    "evidence/motion/preview-trace.json",
    JSON.stringify(stats),
  );
  const intervals = stats.frames.slice(5).sort((a, b) => a - b),
    p95 = intervals[Math.floor(intervals.length * 0.95)];
  expect(stats.mutations).toBe(0);
  expect(p95).toBeLessThan(45);
  expect(stats.heads.every((p, i) => i === 0 || p >= stats.heads[i - 1])).toBe(
    true,
  );
  expect(stats.paints.length).toBeGreaterThan(60);
  let maxViewportError = 0,
    maxViewportStep = 0;
  for (const [i, frame] of stats.paints.entries()) {
    const crop = cropAt(edits, frame.time);
    for (const key of ["x", "y", "size"]) {
      maxViewportError = Math.max(
        maxViewportError,
        Math.abs(frame[key] - crop[key]),
      );
      if (i)
        maxViewportStep = Math.max(
          maxViewportStep,
          Math.abs(frame[key] - stats.paints[i - 1][key]),
        );
    }
  }
  expect(maxViewportError).toBeLessThan(0.00001);
  expect(maxViewportStep).toBeLessThan(0.08);
  expect(stats.stall).toBeDefined();
  const resumed = stats.paints.find((p) => p.wall >= stats.stall.end);
  expect(resumed.time - stats.stall.time).toBeGreaterThan(0.12);
  expect(resumed.time - stats.stall.time).toBeLessThan(0.25);
  await fs.mkdir("evidence/motion", { recursive: true });
  await fs.writeFile(
    "evidence/motion/playback-check.json",
    JSON.stringify(
      {
        p95FrameIntervalMs: p95,
        observedFrames: stats.frames.length,
        paintedFrames: stats.paints.length,
        maxViewportError,
        maxViewportStep,
        simulatedWebcamSeekMs: 180,
        outputClockAdvanceAfterSeek: resumed.time - stats.stall.time,
        timelineDOMRebuilds: stats.mutations,
        hardwareCapture: false,
      },
      null,
      2,
    ),
  );
});
test("zoom editing, timeline magnification, pointer scrubbing and drag trims survive undo and save/reopen", async () => {
  await page.locator("#back").click();
  await page.locator("#zoom-lane [data-zoom-id]").first().click();
  await expect(page.locator("#section-zoom")).toHaveValue("2.4");
  await page.locator("#section-zoom").fill("2.1");
  await page.locator("#section-zoom").dispatchEvent("change");
  await page.locator("#undo").click();
  await expect(page.locator("#section-zoom")).toHaveValue("2.4");
  // Maintain the same clip DOM during a trim; each drag is one undo entry.
  await page.locator("#tab-clip").click();
  await page.locator("#screen-lane .clip").last().click();
  const old = await page.locator("#trim-end").inputValue();
  await page
    .locator("#screen-lane .clip")
    .last()
    .evaluate((el) => (window.originalClipNode = el));
  const trim = await page
    .locator("#screen-lane .clip")
    .last()
    .locator("[data-trim=end]")
    .boundingBox();
  await page.mouse.move(trim.x + trim.width / 2, trim.y + trim.height / 2);
  await page.mouse.down();
  await page.mouse.move(trim.x - 55, trim.y + trim.height / 2, { steps: 15 });
  expect(
    await page.evaluate(
      () =>
        document.querySelector("#screen-lane .clip:last-child") ===
        window.originalClipNode,
    ),
  ).toBe(true);
  await page.mouse.up();
  expect(Number(await page.locator("#trim-end").inputValue())).toBeLessThan(
    Number(old),
  );
  await page.locator("#undo").click();
  await expect(page.locator("#trim-end")).toHaveValue(old);
  await page.locator("#timeline-scale").fill(Math.log2(3).toFixed(2));
  expect(
    await page
      .locator(".timeline-scroll")
      .evaluate((el) => el.scrollWidth > el.clientWidth * 2.8),
  ).toBe(true);
  await page.locator(".timeline-scroll").evaluate((el) => (el.scrollLeft = 0));
  const ruler = await page.locator("#screen-lane").boundingBox(),
    scrubber = await page.locator("#scrubber").boundingBox();
  // A screen-relative pointer position maps into the magnified timeline.
  await page.mouse.move(ruler.x + 180, scrubber.y + 15);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 250, scrubber.y + 15, { steps: 8 });
  await page.mouse.up();
  expect(
    Math.abs(
      Number(await page.locator("#scrubber").inputValue()) -
        (250 / ruler.width) * (3.5 / 1.5),
    ),
  ).toBeLessThan(0.02);
  await page.locator("#timeline-scale").fill("0");
  await page.locator("#tab-motion").click();
  await page.locator("#scrubber").fill("0");
  await page.locator("#add-zoom").click();
  await expect(
    page.locator("#zoom-selector option:not([disabled])"),
  ).toHaveCount(2);
  await expect(page.locator("#section-ease")).toHaveValue("0.6");
  await page.locator("#section-ease").fill("0.2");
  await page.locator("#section-ease").dispatchEvent("change");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("All changes saved");
  const saved = JSON.parse(
    await fs.readFile(path.join(root, "project.framestudio/project.json")),
  );
  expect(saved.edits.zooms).toHaveLength(2);
  expect(saved.edits.zooms[0].ease).toBe(0.2);
  expect(saved.cursor.samples.length).toBe(481);
  await page.screenshot({ path: "evidence/motion/editor-motion.png" });
  await app.evaluate(
    ({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    },
    path.join(root, "project.framestudio"),
  );
  await page.locator("#open").click();
  await expect(
    page.locator("#zoom-selector option:not([disabled])"),
  ).toHaveCount(2);
  await page.locator("#zoom-selector").selectOption({ index: 1 });
  await expect(page.locator("#section-ease")).toHaveValue("0.2");
});

test("automatic cursor capture supports editing after recording, persistence and real packaged rendering", async () => {
  test.setTimeout(120000);
  const target = path.join(root, "Recording 1.framestudio"),
    exports = path.join(root, "native-exports");
  await fs.mkdir(exports, { recursive: true });
  await app.evaluate(
    async ({ dialog, desktopCapturer, nativeImage, shell, Tray }, options) => {
      const setMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (menu) {
        globalThis.__recordingMenu = menu;
        return setMenu.call(this, menu);
      };
      const child = process.getBuiltinModule("child_process"),
        module = process.getBuiltinModule("module");
      const original = child.spawn;
      child.spawn = (command, args, config) =>
        String(command).endsWith("/frame-capture") && args.includes("--source")
          ? original(
              options.node,
              [
                options.script,
                ...args,
                "--fixture",
                options.fixture,
                ...(globalThis.__omitCaptureExclusions
                  ? ["--omit-exclusions"]
                  : []),
              ],
              config,
            )
          : original(command, args, config);
      module.syncBuiltinESMExports();
      dialog.showOpenDialog = async (_window, choice) => ({
        canceled: false,
        filePaths: [
          choice.title.includes("all your projects")
            ? options.target.slice(0, options.target.lastIndexOf("/"))
            : options.exports,
        ],
      });
      shell.openPath = async () => "";
      desktopCapturer.getSources = async () => [
        {
          id: "screen:0:0",
          display_id: "1",
          name: "Generated native protocol fixture",
          thumbnail: nativeImage.createEmpty(),
        },
      ];
    },
    {
      node: process.execPath,
      script: path.resolve("tests/fixtures/capture-process.mjs"),
      fixture: path.join(root, "project.framestudio"),
      target,
      exports,
    },
  );
  await page.evaluate(() => {
    window.__cameraOpens = 0;
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        kind: "videoinput",
        deviceId: "warmup-camera",
        label: "Startup camera fixture",
        groupId: "test",
        toJSON() {},
      },
    ];
    navigator.mediaDevices.getUserMedia = async () => {
      window.__cameraOpens++;
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      const draw = () => {
        ctx.fillStyle = "#e02020";
        ctx.fillRect(0, 0, 320, 240);
      };
      draw();
      const stream = canvas.captureStream(30),
        timer = setInterval(draw, 33);
      window.__cameraStream = stream;
      stream
        .getVideoTracks()[0]
        .addEventListener("ended", () => clearInterval(timer));
      return stream;
    };
  });
  await page.locator("#new-recording").click();
  await expect(page.locator("[data-source]")).toHaveCount(1);
  await expect(page.locator("#record-cursor")).toHaveCount(0);
  await page.locator("#record-camera").selectOption("warmup-camera");
  await page.screenshot({ path: "evidence/motion/recording-picker.png" });
  const previewOpened = app.waitForEvent("window");
  await page.locator("#start-record").click();
  const webcamPreview = await previewOpened;
  await expect(page.locator("#recording-banner")).toBeVisible();
  await expect(webcamPreview.locator("#recording-webcam")).toBeVisible();
  await expect
    .poll(() =>
      webcamPreview.evaluate(() => {
        const video = document.querySelector("video");
        return (
          video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0
        );
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => window.__cameraOpens)).toBe(1);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const preview = BrowserWindow.getAllWindows().find((w) =>
          w.getTitle().includes("Webcam preview"),
        );
        const editor = BrowserWindow.getAllWindows().find((w) => w !== preview);
        return {
          minimized: editor?.isMinimized(),
          visible: preview?.isVisible(),
          floating: preview?.isAlwaysOnTop(),
        };
      }),
    )
    .toEqual({ minimized: true, visible: true, floating: true });
  // The idle window is only the camera, with transparent squircle corners.
  await webcamPreview.mouse.move(-12, -12);
  await expect(webcamPreview.locator("header.controls")).toHaveCSS(
    "opacity",
    "0",
  );
  await expect(webcamPreview.locator("footer.controls")).toHaveCSS(
    "opacity",
    "0",
  );
  const shape = await webcamPreview.evaluate(() => {
    const video = document.querySelector("video").getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      video: {
        x: video.x,
        y: video.y,
        width: video.width,
        height: video.height,
      },
      squircle: getComputedStyle(document.querySelector(".camera")).cornerShape,
    };
  });
  expect(shape).toEqual({
    width: 248,
    height: 248,
    video: { x: 0, y: 0, width: 248, height: 248 },
    squircle: expect.stringMatching(/^(squircle|superellipse\(2\))$/),
  });
  await fs.mkdir("evidence/webcam-preview", { recursive: true });
  const idleImage = await webcamPreview.screenshot({
    path: "evidence/webcam-preview/squircle-idle.png",
    omitBackground: true,
  });
  const alpha = await app.evaluate(({ nativeImage }, png) => {
    const image = nativeImage.createFromBuffer(Buffer.from(png, "base64"));
    const { width, height } = image.getSize();
    const pixels = image.toBitmap();
    const at = (x, y) => pixels[(y * width + x) * 4 + 3];
    return {
      corners: [
        at(0, 0),
        at(width - 1, 0),
        at(0, height - 1),
        at(width - 1, height - 1),
      ],
      center: at(Math.floor(width / 2), Math.floor(height / 2)),
    };
  }, idleImage.toString("base64"));
  expect(alpha).toEqual({ corners: [0, 0, 0, 0], center: 255 });
  // Isolate browser drag gestures from physical pointer/focus changes on the
  // shared desktop. Native bounds are still resized and inspected below.
  await app.evaluate(({ BrowserWindow }) => {
    const preview = BrowserWindow.getAllWindows().find((w) =>
      w.getTitle().includes("Webcam preview"),
    );
    preview.webContents.setBackgroundThrottling(false);
    preview.hide();
  });
  const bounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle().includes("Webcam preview"))
        .getBounds(),
    );
  const centered = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.getTitle().includes("Webcam preview"),
    );
    const area = screen.getDisplayMatching(w.getBounds()).workArea;
    const rect = {
      x: Math.round(area.x + (area.width - 248) / 2),
      y: Math.round(area.y + (area.height - 248) / 2),
      width: 248,
      height: 248,
    };
    w.setBounds(rect);
    return rect;
  });
  await expect
    .poll(() =>
      webcamPreview.evaluate(() => ({
        x: screenX,
        y: screenY,
        width: innerWidth,
        height: innerHeight,
      })),
    )
    .toEqual(centered);
  const resized = [];
  const dragCorner = async (corner, delta, cancel = false) => {
    const before = await bounds();
    // Native setBounds and Chromium's screen coordinates settle asynchronously.
    // A real pointer waits for that visible move; CDP needs the same boundary.
    await expect
      .poll(() =>
        webcamPreview.evaluate(() => ({
          x: screenX,
          y: screenY,
          width: innerWidth,
          height: innerHeight,
        })),
      )
      .toEqual(before);
    const sx = corner.endsWith("w") ? -1 : 1;
    const sy = corner.startsWith("n") ? -1 : 1;
    const x = before.width * (sx < 0 ? 0.11 : 0.89);
    const y = before.height * (sy < 0 ? 0.11 : 0.89);
    await webcamPreview.mouse.move(x, y);
    await expect
      .poll(() =>
        webcamPreview.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x, y)?.closest("[data-resize]")?.dataset
              .resize,
          [x, y],
        ),
      )
      .toBe(corner);
    await webcamPreview.mouse.down();
    await expect(webcamPreview.locator("body")).toHaveClass("resizing");
    // Keep the synthetic pointer in screen coordinates while the native window
    // moves. One jump outside the old window can be dropped by macOS before
    // Chromium has delivered the first resize frame.
    for (let step = 1; step <= 4; step++) {
      const current = await bounds(),
        amount = (delta * step) / 4;
      await webcamPreview.mouse.move(
        before.x + x + sx * amount - current.x,
        before.y + y + sy * amount - current.y,
      );
      await expect
        .poll(async () => (await bounds()).width)
        .toBe(Math.max(192, before.width + amount));
      const actual = await bounds();
      await expect
        .poll(() =>
          webcamPreview.evaluate(() => ({
            x: screenX,
            y: screenY,
            width: innerWidth,
            height: innerHeight,
          })),
        )
        .toEqual(actual);
    }
    const during = await bounds();
    expect(during.width).toBe(during.height);
    expect(sx < 0 ? during.x + during.width : during.x).toBe(
      sx < 0 ? before.x + before.width : before.x,
    );
    expect(sy < 0 ? during.y + during.height : during.y).toBe(
      sy < 0 ? before.y + before.height : before.y,
    );
    // The real pointer stays in screen coordinates as the north/west edges move.
    if (before.x !== during.x || before.y !== during.y)
      await webcamPreview.mouse.move(
        before.x + x + sx * delta - during.x,
        before.y + y + sy * delta - during.y,
      );
    if (cancel) await webcamPreview.keyboard.press("Escape");
    await webcamPreview.mouse.up();
    await expect.poll(bounds).toEqual(cancel ? before : during);
    resized.push({ corner, cancel, size: during.width });
  };
  for (const corner of ["nw", "ne", "sw", "se"]) {
    await dragCorner(corner, 32);
    await dragCorner(corner, -32);
  }
  await dragCorner("nw", 32, true);
  await dragCorner("se", -80);
  await dragCorner("se", 56);
  expect(await bounds()).toEqual(centered);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle().includes("Webcam preview"))
      .showInactive(),
  );
  await webcamPreview.locator(".camera").hover();
  await expect(webcamPreview.locator("header.controls")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(webcamPreview.locator("footer.controls")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(webcamPreview.locator("#flip-preview")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await webcamPreview.locator("#flip-preview").click();
  await expect(webcamPreview.locator("video")).toHaveCSS("transform", "none");
  await webcamPreview.locator("#flip-preview").click();
  await expect(webcamPreview.locator("video")).toHaveCSS(
    "transform",
    "matrix(-1, 0, 0, 1, 0, 0)",
  );
  await webcamPreview.screenshot({
    path: "evidence/motion/recording-webcam.png",
  });
  await webcamPreview.screenshot({
    path: "evidence/webcam-preview/squircle-hover.png",
    omitBackground: true,
  });
  await webcamPreview.mouse.move(-12, -12);
  await expect(webcamPreview.locator("footer.controls")).toHaveCSS(
    "opacity",
    "0",
  );
  // Keyboard access reveals controls too; a prior pointer click must not keep
  // them pinned open after leaving the camera.
  await webcamPreview.keyboard.press("Tab");
  await expect(webcamPreview.locator("button:focus-visible")).toHaveCount(1);
  await expect(webcamPreview.locator("header.controls")).toHaveCSS(
    "opacity",
    "1",
  );
  await webcamPreview
    .locator("button:focus-visible")
    .evaluate((el) => el.blur());
  await expect(webcamPreview.locator("header.controls")).toHaveCSS(
    "opacity",
    "0",
  );
  await webcamPreview.locator(".camera").hover();
  await webcamPreview.locator("#hide-preview").click();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle().includes("Webcam preview"))
          ?.isVisible(),
      ),
    )
    .toBe(false);
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.__recordingMenu.items.map((item) => item.label),
      ),
    )
    .toContain("Show webcam preview");
  await app.evaluate(() =>
    globalThis.__recordingMenu.items
      .find((item) => item.label === "Show webcam preview")
      .click(),
  );
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle().includes("Webcam preview"))
          ?.isVisible(),
      ),
    )
    .toBe(true);
  await webcamPreview.mouse.move(-12, -12);
  await expect(webcamPreview.locator("header.controls")).toHaveCSS(
    "opacity",
    "0",
  );
  expect(await page.evaluate(() => window.__cameraOpens)).toBe(1);
  // Stopping from the floating view must finalize the same camera track.
  await webcamPreview.locator(".camera").hover();
  await webcamPreview.locator("#stop-preview").click();
  await expect(page.locator("#project-title")).toHaveText("Recording 1");
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  const project = JSON.parse(
    await fs.readFile(path.join(target, "project.json")),
  );
  expect(project.tracks.screen.file).toBe("screen.mp4");
  expect(project.edits.style.aspectRatio).toBe("source");
  expect(project.tracks.camera.offset).toBeLessThan(-0.25);
  await fs.writeFile(
    "evidence/webcam-preview/appearance.json",
    JSON.stringify(
      {
        asarSha256: process.env.FRAME_EXECUTABLE
          ? createHash("sha256")
              .update(
                await fs.readFile(
                  path.resolve(
                    "release/Open Record Studio.app/Contents/Resources/app.asar",
                  ),
                ),
              )
              .digest("hex")
          : null,
        shape,
        alpha,
        resized,
        floatingMirrorToggle: true,
        hoverRevealsControls: true,
        pointerLeaveHidesControls: true,
        keyboardAccess: true,
        hideRestoreAndStop: true,
        sharedCameraStream: true,
      },
      null,
      2,
    ),
  );
  // The real browser recorder is already producing frames when native capture starts.
  await page.locator('[data-preview="camera"]').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const [r, g, b] = document
          .querySelector("#preview")
          .getContext("2d")
          .getImageData(100, 100, 1, 1).data;
        return r > 150 && g < 70 && b < 70;
      }),
    )
    .toBe(true);
  await page.locator('[data-preview="combined"]').click();
  expect(project.cursor.clean).toBe(true);
  expect(project.cursor.samples.length).toBe(481);
  await page.locator("#tab-motion").click();
  await expect(page.locator("#showCursor")).toBeEnabled();
  await expect(page.locator("#showCursor")).toBeChecked();
  await page.locator("#cursorSize").fill("1.8");
  await page.locator("#cursorSmoothing").fill("0.1");
  await page.locator("#cursorClicks").uncheck();
  await page.locator("#showCursor").uncheck();
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("All changes saved");
  const saved = JSON.parse(
    await fs.readFile(path.join(target, "project.json")),
  );
  expect(saved.edits.style).toMatchObject({
    showCursor: false,
    cursorSize: 1.8,
    cursorSmoothing: 0.1,
    cursorClicks: false,
  });
  expect(saved.cursor).toEqual(project.cursor);
  // Reopen with the same source data, then make the pointer visible for export.
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, target);
  await page.locator("#scrubber").fill("1");
  await page.locator("#open").click();
  await expect(page.locator("#scrubber")).toHaveValue("0");
  await expect(page.locator("#showCursor")).not.toBeChecked();
  await expect(page.locator("#cursorSize")).toHaveValue("1.8");
  await expect(page.locator("#cursorSmoothing")).toHaveValue("0.1");
  await expect(page.locator("#cursorClicks")).not.toBeChecked();
  await page.locator("#showCursor").check();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, exports);
  await page.locator("#scrubber").fill("0.5");
  await page.locator("#add-zoom").click();
  await page.screenshot({ path: "evidence/motion/cursor-editor.png" });
  await page.locator("#export").click();
  await page.locator("#export-height").selectOption("720");
  await page.locator("#export-fps").selectOption("60");
  await page.locator("#start-export").click();
  await expect(page.locator("#export-dialog")).not.toBeVisible({
    timeout: 30000,
  });
  const folders = await fs.readdir(exports);
  expect(folders).toHaveLength(1);
  const output = path.join(exports, folders[0], "combined.mp4");
  const { probe, run, binary } = await import("../../desktop/media.mjs");
  expect((await probe(output)).duration).toBeCloseTo(4, 1);
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-xerror",
    "-i",
    output,
    "-f",
    "null",
    "-",
  ]);
  await fs.copyFile(output, "evidence/motion/native-protocol-export.mp4");
  // A helper that cannot confirm exclusion must never reveal the preview.
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("All changes saved");
  const failedTarget = path.join(root, "Recording 2.framestudio");
  await app.evaluate(() => {
    globalThis.__omitCaptureExclusions = true;
  });
  await page.locator("#new-recording").click();
  await page.locator("#record-camera").selectOption("warmup-camera");
  const failedPreviewOpened = app.waitForEvent("window");
  await page.locator("#start-record").click();
  const failedPreview = await failedPreviewOpened;
  await expect(page.locator("#toast")).toContainText("could not be excluded");
  await expect(page.locator("#recording-banner")).toBeHidden();
  await expect(page.locator("#start-record")).toBeEnabled();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    )
    .toBe(1);
  expect(failedPreview.isClosed()).toBe(true);
  expect(
    await page.evaluate(() =>
      window.__cameraStream
        .getTracks()
        .every((track) => track.readyState === "ended"),
    ),
  ).toBe(true);
  expect(
    JSON.parse(await fs.readFile(path.join(failedTarget, "recovery.json")))
      .interrupted,
  ).toBe(true);
});
