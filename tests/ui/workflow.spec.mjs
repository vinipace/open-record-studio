import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { audioEnergy } from "../media-checks.mjs";
import { binary, probe, run } from "../../desktop/media.mjs";

const root = path.resolve(".cache/e2e-workflow");
const evidence = path.resolve("evidence/e2e");
let ffmpeg, screenFile, cameraFile, application, page, errors, dataDirectory;
const reports = [];
test.describe.configure({ mode: "serial" });
test.setTimeout(120000);

async function launch() {
  application = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? { executablePath: process.env.FRAME_EXECUTABLE, args: [] }
      : { args: ["."] }),
    env: { ...process.env, FRAME_DATA_DIR: dataDirectory },
  });
  page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("#project-title")).toHaveText("Untitled recording");
}
async function close() {
  if (!application) return;
  await application
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
    )
    .catch(() => {});
  await application.close().catch(() => {});
  application = null;
}
async function dialogs(choices) {
  await application.evaluate(({ dialog, shell }, queue) => {
    globalThis.__testDialogQueue = queue;
    globalThis.__testRevealed = [];
    const next = (kind) => {
      const choice = globalThis.__testDialogQueue.shift();
      if (!choice || choice.kind !== kind)
        throw new Error(`Unexpected ${kind} dialog in E2E`);
      return choice.cancel
        ? { canceled: true, filePaths: [] }
        : kind === "save"
          ? { canceled: false, filePath: choice.path }
          : { canceled: false, filePaths: [choice.path] };
    };
    dialog.showOpenDialog = async () => next("open");
    dialog.showSaveDialog = async () => next("save");
    shell.openPath = async (location) => {
      globalThis.__testRevealed.push(location);
      return "";
    };
  }, choices);
}
async function importMedia(name, withCamera = true) {
  const destination = path.join(root, `${name}.framestudio`);
  const namedMedia = path.join(root, `${name}.mp4`);
  await fs.copyFile(screenFile, namedMedia);
  await dialogs([
    { kind: "open", path: namedMedia },
    { kind: "open", path: root },
    ...(withCamera ? [{ kind: "open", path: cameraFile }] : []),
  ]);
  await page.locator("#import").click();
  await expect(page.locator("#project-title")).toHaveText(name);
  if (withCamera) {
    await page.locator("#media-library-tab").click();
    await page.locator("#attach-camera").click();
    await expect(page.locator("#media-camera-controls")).toBeVisible();
  }
  await page.locator("#tab-appearance").click();
  return destination;
}
async function numberInput(selector, value) {
  await page.locator(selector).fill(String(value));
  await page.locator(selector).press("Tab");
}
async function pixel(file, time, x = 0.5, y = 0.5) {
  const data = await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `crop=2:2:trunc(iw*${x}/2)*2:trunc(ih*${y}/2)*2,scale=1:1`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const chunks = [];
    child.stdout.on("data", (b) => chunks.push(b));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("Frame decode failed")),
    );
  });
  expect(data.length).toBe(3);
  return [...data];
}
const digest = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
async function inspectExport(directory, expected) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, "export.json")),
  );
  const results = {};
  for (const name of manifest.files) {
    const file = path.join(directory, name),
      meta = await probe(file);
    expect(Math.abs(meta.duration - expected.duration)).toBeLessThan(0.06);
    expect(meta.height).toBe(expected.height);
    expect(meta.width).toBe(
      name === "camera.mp4"
        ? (expected.height * 4) / 3
        : Math.round((expected.height * 16) / 9 / 2) * 2,
    );
    expect(meta.audio).toBe(
      expected.audio && (name !== "camera.mp4" || expected.cameraAudio),
    );
    const streams = JSON.parse(
      await run(await binary("ffprobe"), [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        file,
      ]),
    ).streams;
    expect(streams.find((s) => s.codec_type === "video").r_frame_rate).toBe(
      `${expected.fps}/1`,
    );
    // Decode every frame and audio packet, failing on corrupt/truncated streams.
    await run(ffmpeg, [
      "-v",
      "error",
      "-xerror",
      "-i",
      file,
      "-f",
      "null",
      "-",
    ]);
    if (meta.audio) expect(await audioEnergy(file)).toBeGreaterThan(0.005);
    results[name] = meta;
  }
  return { manifest, results };
}
async function exportUI({
  mode = "both",
  height = 1080,
  fps = 60,
  audio = true,
  cameraAudio = false,
  name,
}) {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  await dialogs([{ kind: "open", path: directory }]);
  await page.locator("#export").click();
  await page.locator(`[name=mode][value=${mode}]`).check();
  await page.locator("#export-height").selectOption(String(height));
  await page.locator("#export-fps").selectOption(String(fps));
  await page.locator("#export-audio").setChecked(audio);
  await page.locator("#start-export").click();
  await expect(page.locator("#export-dialog")).not.toBeVisible({
    timeout: 60000,
  });
  const children = await fs.readdir(directory);
  expect(children).toHaveLength(1);
  const final = path.join(directory, children[0]);
  expect(await application.evaluate(() => globalThis.__testRevealed)).toEqual([
    final,
  ]);
  return final;
}

test.beforeAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(evidence, { recursive: true });
  ffmpeg = await binary("ffmpeg");
  screenFile = path.join(root, "Screen #1's take.mp4");
  cameraFile = path.join(root, "Camera #1's take.mp4");
  const base = ["-v", "error", "-nostdin", "-n"];
  await run(ffmpeg, [
    ...base,
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:duration=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=6",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    screenFile,
  ]);
  await run(ffmpeg, [
    ...base,
    "-f",
    "lavfi",
    "-i",
    "color=yellow:s=320x240:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=magenta:s=320x240:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=cyan:s=320x240:r=30:d=2",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0,drawbox=x=0:y=0:w=16:h=240:color=white:t=fill[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    cameraFile,
  ]);
});
test.beforeEach(async ({}, info) => {
  errors = [];
  dataDirectory = path.join(root, `profile-${info.testId}`);
  await fs.mkdir(dataDirectory, { recursive: true });
  await launch();
});
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed())
    await page
      .screenshot({
        path: path.join(
          evidence,
          `${info.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 90)}.png`,
        ),
      })
      .catch(() => {});
  await close();
  reports.push({
    test: info.title,
    status: info.status,
    rendererErrors: errors,
  });
});
test.afterAll(async () => {
  await fs.writeFile(
    path.join(evidence, "workflow-results.json"),
    JSON.stringify(
      {
        packaged: Boolean(process.env.FRAME_EXECUTABLE),
        reports,
        nativeDialogs:
          "Only file choices and reveal are substituted; UI, IPC, imports, persistence, and FFmpeg are real",
        hardwareCaptureVerified: false,
      },
      null,
      2,
    ),
  );
});

test("import, edit, save, cold reopen, export both and verify decoded video", async () => {
  const sourceHashes = await Promise.all([
    digest(screenFile),
    digest(cameraFile),
  ]);
  const directory = await importMedia("Edited demo #1");
  const permissions = await page.evaluate(() => window.studio.status());
  await fs.writeFile(
    path.join(evidence, "media-permissions.json"),
    JSON.stringify(
      {
        screen: permissions.screenPermission,
        camera: permissions.cameraPermission,
        microphone: permissions.microphonePermission,
      },
      null,
      2,
    ),
  );
  await page.locator("#scrubber").fill("1.5");
  await page.locator("#split").click();
  await page.locator("#tab-clip").click();
  await numberInput("#trim-start", 3);
  await numberInput("#trim-end", 5);
  await page.locator("#screen-lane .clip").first().click();
  await numberInput("#media-trim-start", 0.5);
  await page.locator("#media-speed").selectOption("1.5");
  await page.locator("#tab-camera").click();
  await numberInput("#cameraOffset", 1);
  await page.locator('[data-shape="square"]').click();
  await expect(page.locator("#cameraRoundness")).toHaveValue("0");
  await page.locator("#cameraRoundness").fill("0.5");
  await page.locator('[data-corner="top-right"]').click();
  await page.locator("#tab-appearance").click();
  await page.locator('[data-color="#465e8b"]').click();
  await page.locator("#padding").fill("0.1");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("All changes saved");
  const saved = JSON.parse(
    await fs.readFile(path.join(directory, "project.json")),
  );
  expect(saved.edits.segments).toEqual([
    { start: 0.5, end: 1.5 },
    { start: 3, end: 5 },
  ]);
  expect(saved.edits.style.speed).toBe(1.5);
  expect(saved.edits.style.cameraOffset).toBe(1);
  expect(saved.edits.style.cameraRoundness).toBe(0.5);
  expect(await digest(path.join(directory, "screen.mp4"))).toBe(
    sourceHashes[0],
  );
  expect(await digest(path.join(directory, saved.tracks.camera.file))).toBe(
    sourceHashes[1],
  );
  await close();
  await launch();
  await dialogs([{ kind: "open", path: directory }]);
  await page.locator("#open").click();
  await expect(page.locator("#project-title")).toHaveText("Edited demo #1");
  await expect(page.locator("#clip-count")).toHaveText("2 clips");
  await expect(page.locator("#timecode")).toContainText("00:02.0");
  await expect(page.locator("#padding-value")).toHaveText("10%");
  const reopened = await page.evaluate(
    async () => (await window.studio.status()).project.edits,
  );
  expect(reopened).toEqual(saved.edits);
  await page.locator("#tab-camera").click();
  await expect(page.locator("#cameraRoundness")).toHaveValue("0.5");
  await expect(page.locator("#cameraRoundness-value")).toHaveText("50%");
  // Sample painted pixels: a rounded corner exposes the backdrop, while a
  // point between the square and circular boundaries still contains webcam.
  await page.locator("#scrubber").fill("0.5");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.querySelector("#preview"),
          ctx = canvas.getContext("2d");
        const size = canvas.width * 0.22,
          gap = canvas.width * 0.035;
        const sample = (fraction) => [
          ...ctx.getImageData(
            Math.floor(canvas.width - gap - size + size * fraction),
            Math.floor(gap + size * fraction),
            1,
            1,
          ).data,
        ];
        const corner = sample(0.02),
          rounded = sample(0.12);
        return (
          [70, 94, 139].every((v, i) => Math.abs(corner[i] - v) < 8) &&
          rounded[0] > 220 &&
          rounded[1] > 220 &&
          rounded[2] < 25
        );
      }),
    )
    .toBe(true);
  await page.screenshot({ path: path.join(evidence, "webcam-roundness.png") });
  await page.locator('[data-preview="camera"]').click();
  await page.locator("#scrubber").fill("0.5");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const [r, g, b] = document
          .querySelector("#preview")
          .getContext("2d")
          .getImageData(480, 360, 1, 1).data;
        return r > 220 && g > 220 && b < 25;
      }),
    )
    .toBe(true);
  const final = await exportUI({ name: "both-output" });
  const inspection = await inspectExport(final, {
    duration: 2,
    height: 1080,
    fps: 60,
    audio: true,
    cameraAudio: false,
  });
  expect(inspection.manifest.files.sort()).toEqual([
    "camera.mp4",
    "combined.mp4",
    "screen.mp4",
  ]);
  expect(inspection.manifest.edits).toEqual(saved.edits);
  const camera = path.join(final, "camera.mp4");
  expect(Math.max(...(await pixel(camera, 0.1)))).toBeLessThan(15);
  const yellow = await pixel(camera, 0.5),
    magenta = await pixel(camera, 1.2),
    edge = await pixel(camera, 0.5, 0.02, 0.5);
  expect(yellow[0]).toBeGreaterThan(220);
  expect(yellow[1]).toBeGreaterThan(220);
  expect(yellow[2]).toBeLessThan(25);
  expect(magenta[0]).toBeGreaterThan(220);
  expect(magenta[2]).toBeGreaterThan(220);
  expect(magenta[1]).toBeLessThan(25);
  expect(Math.min(...edge)).toBeGreaterThan(225);
  const matte = await pixel(path.join(final, "combined.mp4"), 0.5, 0.01, 0.01);
  [70, 94, 139].forEach((value, i) =>
    expect(Math.abs(matte[i] - value)).toBeLessThan(8),
  );
  const separate = await exportUI({
    name: "separate-audio-output",
    mode: "separate",
    height: 720,
    fps: 30,
    cameraAudio: false,
  });
  await inspectExport(separate, {
    duration: 2,
    height: 720,
    fps: 30,
    audio: true,
    cameraAudio: false,
  });
  expect(await Promise.all([digest(screenFile), digest(cameraFile)])).toEqual(
    sourceHashes,
  );
  expect(errors).toEqual([]);
  await fs.writeFile(
    path.join(evidence, "export-inspection.json"),
    JSON.stringify(
      {
        both: final,
        separate,
        inspection,
        pixels: { yellow, magenta, edge, matte },
        sourceHashes,
      },
      null,
      2,
    ),
  );
});

test("screen-only import, export destination cancel, interrupted render and retry", async () => {
  await importMedia("Screen only", false);
  await expect(page.locator('[data-preview="camera"]')).toBeDisabled();
  await page.locator("#tab-clip").click();
  await page.locator("#speed").selectOption("0.5");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("All changes saved");
  await dialogs([{ kind: "open", cancel: true }]);
  await page.locator("#export").click();
  await expect(page.locator("[name=mode][value=separate]")).toBeDisabled();
  await page.locator("#start-export").click();
  await expect(page.locator("#start-export")).toBeEnabled();
  await expect(page.locator("[name=mode][value=separate]")).toBeDisabled();
  const output = path.join(root, "cancelled-output");
  await fs.mkdir(output);
  await dialogs([{ kind: "open", path: output }]);
  await page.locator("#export-height").selectOption("2160");
  await page.locator("#export-fps").selectOption("60");
  await page.locator("#start-export").click();
  await expect
    .poll(
      () =>
        page
          .locator("#export-progress .progress-track div")
          .evaluate((e) => parseFloat(e.style.width) || 0),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);
  await page.locator("#cancel-export").click();
  await expect(page.locator("#start-export")).toBeEnabled();
  await expect.poll(() => fs.readdir(output)).toEqual([]);
  await expect(page.locator("[name=mode][value=separate]")).toBeDisabled();
  await page.locator("#export-dialog .close-dialog").click();
  const final = await exportUI({
    name: "retry-output",
    mode: "combined",
    height: 720,
    fps: 30,
    audio: false,
  });
  await inspectExport(final, {
    duration: 12,
    height: 720,
    fps: 30,
    audio: false,
    cameraAudio: false,
  });
  expect(errors).toEqual([]);
});

test("GIF export switches format settings, renders the edited composition and restores MP4 choices", async () => {
  await dialogs([
    { kind: "open", path: path.join(root, "Edited demo #1.framestudio") },
  ]);
  await page.locator("#open").click();
  await expect(page.locator("#project-title")).toHaveText("Edited demo #1");
  const output = path.join(root, "gif-output");
  await fs.mkdir(output);
  await dialogs([{ kind: "open", path: output }]);
  await page.locator("#export").click();
  const mp4Height = await page.locator("#export-height").inputValue();
  const mp4Fps = await page.locator("#export-fps").inputValue();
  await page.locator("#export-format").selectOption("gif");
  await expect(page.locator("#export-height")).toHaveValue("480");
  await expect(page.locator("#export-fps")).toHaveValue("20");
  await expect(page.locator("#export-audio-row")).toBeHidden();
  await expect(page.locator("#export-camera-audio")).toHaveCount(0);
  await expect(page.locator("#export-summary")).toContainText("Animated GIF");
  await page.locator("[name=mode][value=both]").check();
  await page.locator("#export-height").selectOption("360");
  await page.screenshot({ path: path.join(evidence, "gif-export.png") });
  await page.locator("#start-export").click();
  await expect(page.locator("#export-dialog")).not.toBeVisible({
    timeout: 30000,
  });
  const folders = await fs.readdir(output);
  expect(folders).toHaveLength(1);
  const final = path.join(output, folders[0]);
  const manifest = JSON.parse(
    await fs.readFile(path.join(final, "export.json")),
  );
  expect(manifest.files.sort()).toEqual([
    "camera.gif",
    "combined.gif",
    "screen.gif",
  ]);
  expect(manifest.options.format).toBe("gif");
  expect(manifest.options.audio).toBe(false);
  for (const name of manifest.files) {
    const file = path.join(final, name),
      meta = await probe(file);
    expect(meta.audio).toBe(false);
    expect(meta.height).toBe(360);
    expect(Math.abs(meta.duration - 2)).toBeLessThan(0.06);
    await run(ffmpeg, [
      "-v",
      "error",
      "-xerror",
      "-i",
      file,
      "-f",
      "null",
      "-",
    ]);
  }
  const yellow = await pixel(path.join(final, "camera.gif"), 0.5);
  const magenta = await pixel(path.join(final, "camera.gif"), 1.2);
  expect(yellow[0]).toBeGreaterThan(220);
  expect(yellow[1]).toBeGreaterThan(220);
  expect(yellow[2]).toBeLessThan(25);
  expect(magenta[0]).toBeGreaterThan(220);
  expect(magenta[2]).toBeGreaterThan(220);
  expect(magenta[1]).toBeLessThan(25);
  await fs.copyFile(
    path.join(final, "combined.gif"),
    path.join(evidence, "combined.gif"),
  );
  await page.locator("#export").click();
  await page.locator("#export-format").selectOption("mp4");
  await expect(page.locator("#export-height")).toHaveValue(mp4Height);
  await expect(page.locator("#export-fps")).toHaveValue(mp4Fps);
  await expect(page.locator("#export-audio-row")).toBeVisible();
  await page.locator("#export-format").selectOption("gif");
  await expect(page.locator("#export-height")).toHaveValue("360");
  await page.locator("#export-format").selectOption("mp4");
  await page.locator("#export-dialog .close-dialog").click();
  expect(errors).toEqual([]);
});

test("failed source refresh cannot start a stale recording", async () => {
  await application.evaluate(({ desktopCapturer, nativeImage }) => {
    desktopCapturer.getSources = async () => [
      {
        id: "screen:test:0",
        name: "Test source",
        display_id: "test",
        thumbnail: nativeImage.createEmpty(),
      },
    ];
  });
  await page.locator("#new-recording").click();
  await expect(page.locator("#start-record")).toBeEnabled();
  await page.locator("#record-dialog .close-dialog").click();
  await application.evaluate(({ desktopCapturer }) => {
    desktopCapturer.getSources = async () => {
      throw new Error("Capture permission unavailable in test");
    };
  });
  await page.locator("#new-recording").click();
  await expect(page.locator("#source-list")).toContainText(
    "Screen sources unavailable",
  );
  await expect(page.locator("#start-record")).toBeDisabled();
  expect(errors).toEqual([]);
});
