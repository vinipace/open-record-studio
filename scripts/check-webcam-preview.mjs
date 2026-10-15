// Explicit live check: covers one display with generated artwork while the
// packaged app records it. Camera frames are synthetic; ScreenCaptureKit is real.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startCapture } from "../desktop/native-capture.mjs";
import { binary, probe, run } from "../desktop/media.mjs";
const exec = promisify(execFile);
const root = path.resolve(
  "evidence/webcam-preview",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await fs.mkdir(root, { recursive: true });
const bundle = path.resolve("release/Open Record Studio.app");
const helper = path.join(bundle, "Contents/Resources/frame-capture");
const fixtureApp = path.join(root, "Preview Test Surface.app");
await fs.mkdir(path.join(fixtureApp, "Contents/MacOS"), { recursive: true });
await fs.writeFile(
  path.join(fixtureApp, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.framestudio.previewsurface</string><key>CFBundleName</key><string>Preview Test Surface</string><key>CFBundleExecutable</key><string>surface</string><key>LSUIElement</key><true/></dict></plist>`,
);
execFileSync("/usr/bin/xcrun", [
  "swiftc",
  "tests/fixtures/PreviewSurface.swift",
  "-o",
  path.join(fixtureApp, "Contents/MacOS/surface"),
]);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", fixtureApp]);
let app, surface, control;
const report = {
  date: new Date().toISOString(),
  generatedCamera: true,
  realScreenCaptureKit: true,
  asarSha256: createHash("sha256")
    .update(await fs.readFile(path.join(bundle, "Contents/Resources/app.asar")))
    .digest("hex"),
  helperSha256: createHash("sha256")
    .update(await fs.readFile(helper))
    .digest("hex"),
};
try {
  app = await electron.launch({
    executablePath: path.join(bundle, "Contents/MacOS/Electron"),
    args: [],
    env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
  });
  const page = await app.firstWindow();
  const target = path.join(root, "Recording 1.framestudio");
  const exports = path.join(root, "exports");
  await fs.mkdir(exports);
  const display = await app.evaluate(
    ({ screen }) => screen.getPrimaryDisplay().id,
  );
  await app.evaluate(
    (
      { dialog, desktopCapturer, nativeImage, shell, Tray },
      { target, exports, display },
    ) => {
      dialog.showOpenDialog = async (_window, choice) => ({
        canceled: false,
        filePaths: [
          choice.title.includes("all your projects")
            ? target.slice(0, target.lastIndexOf("/"))
            : exports,
        ],
      });
      desktopCapturer.getSources = async () => [
        {
          id: "screen:0:0",
          display_id: String(display),
          name: "Generated preview test display",
          thumbnail: nativeImage.createEmpty(),
        },
      ];
      shell.openPath = async () => "";
      const original = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (menu) {
        globalThis.__recordingMenu = menu;
        return original.call(this, menu);
      };
    },
    { target, exports, display },
  );
  await page.evaluate(() => {
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        kind: "videoinput",
        deviceId: "generated",
        label: "Generated test camera",
      },
    ];
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      let n = 0;
      const draw = () => {
        ctx.fillStyle = "#ed2040";
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "white";
        ctx.fillRect((n++ * 4) % 620, 15, 20, 10);
      };
      draw();
      const stream = canvas.captureStream(30);
      const timer = setInterval(draw, 33);
      const stop = stream
        .getVideoTracks()[0]
        .stop.bind(stream.getVideoTracks()[0]);
      stream.getVideoTracks()[0].stop = () => {
        clearInterval(timer);
        stop();
      };
      return stream;
    };
  });
  await page.locator("#welcome-record").click();
  await page.locator("#record-camera").selectOption("generated");
  // Place the opaque surface before screen capture starts.
  surface = spawn(
    path.join(fixtureApp, "Contents/MacOS/surface"),
    [String(display)],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Generated display surface did not start")),
      10000,
    );
    surface.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    surface.once("error", reject);
  });
  await delay(500);
  const opened = app.waitForEvent("window");
  await page.locator("#start-record").click();
  const preview = await opened;
  await expect(page.locator("#recording-banner")).toBeVisible({
    timeout: 25000,
  });
  await expect
    .poll(() =>
      preview.evaluate(() => document.querySelector("video")?.currentTime > 0),
    )
    .toBe(true);
  const previewBounds = await app.evaluate(({ BrowserWindow }) => {
    const preview = BrowserWindow.getAllWindows().find((w) =>
      w.getTitle().includes("Webcam preview"),
    );
    // Only the generated test cover uses this high level. Raise the real preview
    // above it to prove it is visible while excluded from the production capture.
    preview.setAlwaysOnTop(true, "screen-saver", 1);
    // Prove the capture filter works without relying on OS content protection.
    preview.setContentProtection(false);
    preview.showInactive();
    return preview.getBounds();
  });
  await preview.screenshot({ path: path.join(root, "floating-preview.png") });
  console.log(JSON.stringify({ event: "recording", root, previewBounds }));
  // An unfiltered control capture must see the red preview; the app capture must not.
  control = startCapture(helper, {
    source: `screen:${display}`,
    output: path.join(root, "unfiltered-control.mp4"),
  });
  await control.ready;
  await delay(1200);
  await preview.locator(".camera").hover();
  await preview.locator("#hide-preview").click();
  await delay(250);
  await app.evaluate(({ BrowserWindow, screen }) => {
    const preview = BrowserWindow.getAllWindows().find((w) =>
      w.getTitle().includes("Webcam preview"),
    );
    const area = screen.getPrimaryDisplay().workArea;
    preview.setPosition(area.x + 24, area.y + area.height - 270);
    globalThis.__recordingMenu.items
      .find((item) => item.label === "Show webcam preview")
      .click();
  });
  await delay(1000);
  await control.stop();
  control = null;
  await preview.locator(".camera").hover();
  await preview.locator("#stop-preview").click();
  await expect(page.locator("#project-title")).toHaveText("Recording 1", {
    timeout: 20000,
  });
  surface.stdin.end();
  surface = null;
  await page.locator("#tab-motion").click();
  await page.locator("#showCursor").uncheck();
  await page.locator("#export").click();
  await page.locator('[name="mode"][value="separate"]').check();
  await page.locator("#export-height").selectOption("720");
  await page.locator("#export-fps").selectOption("30");
  await page.locator("#start-export").click();
  await expect(page.locator("#export-dialog")).not.toBeVisible({
    timeout: 30000,
  });
  const output = path.join(exports, (await fs.readdir(exports))[0]);
  const ffmpeg = await binary("ffmpeg");
  const inspect = async (file) => {
    const { stdout } = await exec(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        "fps=5,scale=640:-2",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 },
    );
    let red = 0,
      black = 0;
    for (let i = 0; i < stdout.length; i += 3) {
      if (stdout[i] > 160 && stdout[i + 1] < 100 && stdout[i + 2] < 130) red++;
      if (Math.max(stdout[i], stdout[i + 1], stdout[i + 2]) < 12) black++;
    }
    const meta = await probe(file);
    return {
      redPixels: red,
      blackPixels: black,
      pixels: stdout.length / 3,
      duration: meta.duration,
    };
  };
  report.control = await inspect(path.join(root, "unfiltered-control.mp4"));
  report.screen = await inspect(path.join(target, "screen.mp4"));
  report.screenExport = await inspect(path.join(output, "screen.mp4"));
  report.cameraExport = await inspect(path.join(output, "camera.mp4"));
  expect(report.control.redPixels).toBeGreaterThan(5000);
  expect(report.screen.redPixels).toBe(0);
  expect(report.screenExport.redPixels).toBe(0);
  expect(report.screen.blackPixels / report.screen.pixels).toBeLessThan(0.002);
  expect(
    report.screenExport.blackPixels / report.screenExport.pixels,
  ).toBeLessThan(0.002);
  expect(
    report.cameraExport.redPixels / report.cameraExport.pixels,
  ).toBeGreaterThan(0.8);
  for (const file of [
    path.join(target, "screen.mp4"),
    path.join(output, "screen.mp4"),
    path.join(output, "camera.mp4"),
  ])
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
  await run(ffmpeg, [
    "-v",
    "error",
    "-ss",
    "1",
    "-i",
    path.join(target, "screen.mp4"),
    "-frames:v",
    "1",
    path.join(root, "clean-screen.png"),
  ]);
  report.passed = true;
  report.output = output;
  console.log(JSON.stringify(report));
} catch (error) {
  report.passed = false;
  report.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  control?.abort();
  surface?.stdin.end();
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => {
          if (!w.isDestroyed()) w.destroy();
        }),
      )
      .catch(() => {});
    await app.close().catch(() => {});
  }
  await fs.writeFile(
    path.join(root, "validation.json"),
    JSON.stringify(report, null, 2),
  );
  if (report.passed)
    await fs.writeFile(
      "evidence/webcam-preview/latest.json",
      JSON.stringify({ ...report, root }, null, 2),
    );
}
