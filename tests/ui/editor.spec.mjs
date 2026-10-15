import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { audioEnergy } from "../media-checks.mjs";
import { motionFixture } from "../motion-fixture.mjs";
import { probe } from "../../desktop/media.mjs";
test.describe.configure({ mode: "serial" });
let app, page;
test.beforeAll(async () => {
  const data = path.resolve(".cache/ui-test");
  await fs.rm(data, { recursive: true, force: true });
  await fs.mkdir(data, { recursive: true });
  app = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? { executablePath: process.env.FRAME_EXECUTABLE, args: [] }
      : { args: ["."] }),
    env: { ...process.env, FRAME_DATA_DIR: data },
    timeout: 30000,
  });
  page = await app.firstWindow();
});
test.afterAll(async () => {
  // Always tear down the test-only process, including after a dirty-editor failure.
  await app
    ?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
    )
    .catch(() => {});
  await app?.close().catch(() => {});
});
test("editable timeline, undo, project persistence and separate export choices", async () => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator("h1")).toContainText("Every track, yours");
  await page.locator("#demo").click();
  await expect(page.locator("#project-title")).toHaveText(
    "Two tracks, one story",
    { timeout: 30000 },
  );
  await expect(page.locator("#export")).toBeEnabled();
  await page.waitForFunction(() =>
    document.querySelector("#preview").classList.contains("loaded"),
  );
  // Wait for both actual media tracks to decode through the custom local protocol.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const c = document.querySelector("#preview"),
          ctx = c.getContext("2d");
        const samples = [];
        for (let x = 200; x < 900; x += 37) {
          for (let y = 180; y < 500; y += 29)
            samples.push([...ctx.getImageData(x, y, 1, 1).data].join(","));
        }
        return new Set(samples).size > 15;
      }),
    )
    .toBe(true);
  await page.locator("#scrubber").fill("3");
  await page.locator("#split").click();
  await expect(page.locator("#clip-count")).toHaveText("2 clips");
  await page.locator("#delete").click();
  await expect(page.locator("#clip-count")).toHaveText("1 clip");
  await page.locator("#undo").click();
  await expect(page.locator("#clip-count")).toHaveText("2 clips");
  await page.locator("#tab-clip").click();
  await page.locator("#speed").selectOption("1.5");
  await expect(page.locator("#timecode")).toContainText("00:05.3");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("All changes saved");
  const saved = JSON.parse(
    await fs.readFile(".cache/ui-test/sample.framestudio/project.json"),
  );
  expect(saved.edits.segments).toHaveLength(2);
  expect(saved.edits.style.speed).toBe(1.5);
  await page.locator("#tab-appearance").click();
  await expect
    .poll(() =>
      page
        .locator('#screen-lane .filmstrip [style*="background-image"]')
        .count(),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page
        .locator('#camera-lane .filmstrip [style*="background-image"]')
        .count(),
    )
    .toBeGreaterThan(0);
  await page.locator("#toast").evaluate((el) => el.classList.remove("visible"));
  await page.screenshot({ path: "evidence/editor.png" });
  await page.locator("#export").click();
  await expect(page.locator("#export-fps")).toHaveValue("60");
  await page.locator("[name=mode][value=separate]").check();
  await expect(page.locator("[name=mode][value=separate]")).toBeChecked();
  await expect(page.locator("#export-summary")).toContainText("00:05.3");
  await page.screenshot({ path: "evidence/separate-export.png" });
  await page.locator("#export-dialog .close-dialog").click();
  expect(errors).toEqual([]);
});

test("focused inspector, live controls, full-frame preview, drag trimming and compact layout", async () => {
  await page.locator("#tab-camera").click();
  await expect(page.locator("#panel-camera")).toBeVisible();
  await expect(page.locator("#panel-appearance")).toBeHidden();
  await page.locator('[data-shape="square"]').click();
  await expect(page.locator('[data-shape="square"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#undo").click();
  await expect(page.locator('[data-shape="circle"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#cameraRoundness")).toHaveValue("1");
  // Multiple live updates form one undoable gesture.
  await page.locator("#cameraRoundness").evaluate((el) => {
    for (const value of ["0.7", "0.4"]) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#cameraRoundness-value")).toHaveText("40%");
  await expect(page.locator('[data-shape][aria-pressed="true"]')).toHaveCount(
    0,
  );
  await page.locator("#undo").click();
  await expect(page.locator("#cameraRoundness")).toHaveValue("1");
  await page.locator("#redo").click();
  await expect(page.locator("#cameraRoundness")).toHaveValue("0.4");
  await page.locator('[data-shape="circle"]').click();
  await expect(page.locator("#cameraRoundness")).toHaveValue("1");
  await page.locator('[data-preview="camera"]').click();
  await expect(page.locator("#preview")).toHaveAttribute("width", "960");
  await page.screenshot({ path: "evidence/webcam-preview.png" });
  await page.locator('[data-preview="combined"]').click();
  await expect(page.locator("#preview")).toHaveAttribute("width", "1280");
  await page.locator("#tab-appearance").click();
  const oldPadding = await page.locator("#padding").inputValue();
  await page.locator("#padding").evaluate((el) => {
    el.value = "0.12";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#padding-value")).toHaveText("12%");
  await page.locator("#padding").evaluate((el) => {
    el.value = "0.15";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#undo").click();
  await expect(page.locator("#padding")).toHaveValue(oldPadding);
  await page.locator("#tab-clip").click();
  await page.locator("#screen-lane .clip").last().click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].hide(),
  );
  const originalEnd = await page.locator("#trim-end").inputValue();
  const handle = page
    .locator("#screen-lane .clip")
    .last()
    .locator('[data-trim="end"]');
  const rect = await handle.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await expect(page.locator("body")).toHaveClass(/trimming/);
  await page.mouse.move(rect.x - 40, rect.y + rect.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(Number(await page.locator("#trim-end").inputValue())).toBeLessThan(
    Number(originalEnd),
  );
  await page.locator("#undo").click();
  await expect(page.locator("#trim-end")).toHaveValue(originalEnd);
  await page.locator("#tab-appearance").click();
  await page.locator("#tab-appearance").press("ArrowDown");
  await expect(page.locator("#tab-camera")).toBeFocused();
  await page.locator("#tab-camera").press("Home");
  await expect(page.locator("#tab-appearance")).toBeFocused();
  // Space must control transport after clicking a clip or scrubbing, and must
  // suppress the focused button's native click (including Split and Play).
  const clipCount = await page.locator("#clip-count").textContent();
  for (const selector of [
    "#screen-lane .clip",
    "#scrubber",
    "#play",
    "#split",
  ]) {
    await page.locator("#scrubber").fill("0.5");
    await page.locator(selector).first().focus();
    await page.keyboard.down("Space");
    await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause");
    await page.keyboard.down("Space"); // OS key repeat must not toggle again.
    await page.keyboard.up("Space");
    await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause");
    await expect
      .poll(() => page.locator("#scrubber").inputValue().then(Number))
      .toBeGreaterThan(0.6);
    await page.keyboard.press("Space");
    await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");
    await expect(page.locator("#clip-count")).toHaveText(clipCount);
  }
  await page.locator("#tab-camera").click();
  const cameraOffset = await page.locator("#cameraOffset").inputValue();
  await page.locator("#cameraOffset").press("Space");
  await expect(page.locator("#cameraOffset")).toHaveValue(cameraOffset);
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");
  await page.locator("#export").click();
  await page.locator("#export-dialog .close-dialog").press("Space");
  await expect(page.locator("#export-dialog")).not.toBeVisible();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");
  await page.locator("#tab-appearance").click();
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("All changes saved");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 700),
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const canvas = await page.locator("#preview").boundingBox();
  const inspector = await page.locator(".inspector").boundingBox();
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(inspector.x);
  for (const id of ["#export", "#play", "#split", "#tab-clip"])
    await expect(page.locator(id)).toBeInViewport();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await page.screenshot({ path: "evidence/editor-compact.png" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 930),
  );
});

test("recording requires native tracking, writes independent camera/microphone streams and exports through the UI", async () => {
  const target = path.resolve(".cache/ui-test/Recording 1.framestudio");
  const exportRoot = path.resolve(".cache/ui-test/exports");
  await fs.mkdir(exportRoot, { recursive: true });
  await app.evaluate(({ dialog, desktopCapturer, nativeImage }, location) => {
    globalThis.__systemVersion = process.getSystemVersion;
    process.getSystemVersion = () => "14.7.0";
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [location.slice(0, location.lastIndexOf("/"))],
    });
    desktopCapturer.getSources = async () => [
      {
        id: "screen:synthetic:0",
        name: "Synthetic test screen",
        display_id: "test",
        thumbnail: nativeImage.createEmpty(),
      },
    ];
  }, target);
  await page.evaluate(() => {
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        kind: "videoinput",
        deviceId: "fake-camera",
        label: "Synthetic webcam",
        groupId: "test",
        toJSON() {},
      },
      {
        kind: "audioinput",
        deviceId: "fake-mic",
        label: "Synthetic microphone",
        groupId: "test",
        toJSON() {},
      },
    ];
    function video(color, height = 360) {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      let x = 0;
      const draw = () => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 640, height);
        ctx.fillStyle = "#fff";
        ctx.fillRect((x += 5) % 600, 140, 40, 80);
      };
      draw();
      const timer = setInterval(draw, 33),
        stream = canvas.captureStream(30);
      stream
        .getVideoTracks()[0]
        .addEventListener("ended", () => clearInterval(timer));
      return stream;
    }
    // A non-16:9 capture must determine the new project's canvas proportions.
    navigator.mediaDevices.getDisplayMedia = async () => video("#7762aa", 400);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints.video) return video("#287869");
      const context = new AudioContext(),
        oscillator = context.createOscillator(),
        destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      return destination.stream;
    };
  });
  await page.locator("#new-recording").click();
  await expect(page.locator("#interaction-access-status")).toContainText(
    "requires macOS 15",
  );
  await expect(page.locator("#start-record")).toBeDisabled();
  await page.locator("#record-dialog .close-dialog").click();
  const nativeFixture = await motionFixture(
    path.resolve(".cache/ui-test/native-fixture"),
    { height: 400 },
  );
  await app.evaluate(
    (_, config) => {
      process.getSystemVersion = globalThis.__systemVersion;
      const child = process.getBuiltinModule("child_process"),
        original = child.spawn;
      child.spawn = (command, args, options) =>
        String(command).endsWith("/frame-capture") && args.includes("--source")
          ? original(
              config.node,
              [config.script, ...args, "--fixture", config.fixture],
              options,
            )
          : original(command, args, options);
      process.getBuiltinModule("module").syncBuiltinESMExports();
    },
    {
      node: process.execPath,
      script: path.resolve("tests/fixtures/capture-process.mjs"),
      fixture: nativeFixture.directory,
    },
  );
  await page.locator("#new-recording").click();
  await expect(page.locator("[data-source]")).toHaveCount(1);
  await expect(page.locator("#record-cursor")).toHaveCount(0);
  await page.locator("#record-camera").selectOption("fake-camera");
  await page.locator("#record-microphone").selectOption("fake-mic");
  await page.locator("#start-record").click();
  await expect(page.locator("#recording-banner")).toBeVisible();
  // Native capture confirms exclusion before showing the floating webcam.
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(2);
  await page.waitForTimeout(2600);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show(),
  );
  await page.locator("#stop-record").click();
  await expect(page.locator("#project-title")).toHaveText("Recording 1", {
    timeout: 20000,
  });
  const project = JSON.parse(
    await fs.readFile(path.join(target, "project.json")),
  );
  expect(Object.keys(project.tracks).sort()).toEqual([
    "camera",
    "microphone",
    "screen",
  ]);
  expect(project.duration).toBeGreaterThan(1.5);
  expect(project.cursor.clean).toBe(true);
  expect(project.edits.style.aspectRatio).toBe("source");
  await page.locator('[data-preview="combined"]').click();
  await expect(page.locator("#preview")).toHaveAttribute("width", "1152");
  await expect(page.locator("#preview")).toHaveAttribute("height", "720");
  await expect(page.locator("#canvas-size")).toHaveText("1728 × 1080");
  await page.locator("#tab-motion").click();
  await expect(page.locator("#showCursor")).toBeEnabled();
  await expect(page.locator("#cursor-settings")).toHaveAttribute(
    "title",
    /Editable pointer/,
  );
  for (const key of ["screen", "camera"]) {
    const meta = await probe(path.join(target, project.tracks[key].file));
    expect(meta.video).toBe(true);
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(key === "screen" ? 400 : 360);
  }
  // Verify the remuxed recording really plays back in the packaged renderer.
  await page.locator('[data-preview="camera"]').click();
  await page.locator("#scrubber").fill("0.5");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const [r, g, b] = document
          .querySelector("#preview")
          .getContext("2d")
          .getImageData(100, 100, 1, 1).data;
        return r < 70 && g > 85 && b > 75;
      }),
    )
    .toBe(true);
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#scrubber").inputValue().then(Number))
    .toBeGreaterThan(0.8);
  await page.locator("#play").click();
  await app.evaluate(({ dialog, shell }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
    shell.openPath = async () => "";
  }, exportRoot);
  await page.locator("#export").click();
  await expect(page.locator("#export-fps")).toHaveValue("60");
  await page.locator("[name=mode][value=both]").check();
  await page.locator("#export-height").selectOption("720");
  await expect(page.locator("#export-dimensions")).toContainText("1152 × 720");
  await page.locator("#start-export").click();
  await expect(page.locator("#export-dialog")).not.toBeVisible({
    timeout: 20000,
  });
  const dirs = await fs.readdir(exportRoot);
  expect(dirs).toHaveLength(1);
  const screen = await probe(path.join(exportRoot, dirs[0], "screen.mp4")),
    camera = await probe(path.join(exportRoot, dirs[0], "camera.mp4")),
    combined = await probe(path.join(exportRoot, dirs[0], "combined.mp4"));
  expect([combined.width, combined.height]).toEqual([1152, 720]);
  expect([screen.width, screen.height]).toEqual([1152, 720]);
  expect([camera.width, camera.height]).toEqual([1280, 720]);
  expect(Math.abs(screen.duration - camera.duration)).toBeLessThan(0.04);
  expect(screen.audio).toBe(true);
  expect(camera.audio).toBe(false);
  expect(
    await audioEnergy(path.join(exportRoot, dirs[0], "screen.mp4")),
  ).toBeGreaterThan(0.005);
});

test("existing webcam startup gaps hold frame zero in both previews and preserve manual offsets", async () => {
  const target = path.resolve(".cache/ui-test/Recording 1.framestudio");
  const file = path.join(target, "project.json");
  const project = JSON.parse(await fs.readFile(file, "utf8"));
  project.tracks.camera.offset = 0.28970703125;
  await fs.writeFile(file, JSON.stringify(project));
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, target);
  await page.locator("#open").click();
  const sample = (composition = false) =>
    page.evaluate((composition) => {
      const canvas = document.querySelector("#preview");
      const x = composition ? Math.round(canvas.width * 0.855) : 100;
      const y = composition
        ? Math.round(canvas.height - canvas.width * 0.145)
        : 100;
      const [r, g, b] = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
      return {
        camera: r < 70 && g > 85 && b > 75,
        black: Math.max(r, g, b) < 15,
      };
    }, composition);
  for (const mode of ["camera", "combined"]) {
    await page.locator(`[data-preview="${mode}"]`).click();
    for (const time of [0, 0.1, 0.28, 0.3, 0.6, 0]) {
      await page.locator("#scrubber").fill(String(time));
      await expect
        .poll(async () => (await sample(mode === "combined")).camera)
        .toBe(true);
    }
  }
  await page.locator('[data-preview="camera"]').click();
  await page.locator("#tab-camera").click();
  await page.locator("#cameraOffset").fill("0.2");
  await page.locator("#cameraOffset").press("Tab");
  await page.locator("#scrubber").fill("0.1");
  await expect.poll(async () => (await sample()).black).toBe(true);
  await page.locator("#scrubber").fill("0.25");
  await expect.poll(async () => (await sample()).camera).toBe(true);
  await page.locator("#cameraOffset").fill("-0.15");
  await page.locator("#cameraOffset").press("Tab");
  await page.locator("#scrubber").fill("0");
  await expect.poll(async () => (await sample()).camera).toBe(true);
  // Playing through the held frame must resume the camera and advance the clock.
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#scrubber").inputValue().then(Number))
    .toBeGreaterThan(0.5);
  await page.locator("#play").click();
  await expect.poll(async () => (await sample()).camera).toBe(true);
});
