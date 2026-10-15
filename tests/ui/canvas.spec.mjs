import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { binary, run, probe } from "../../desktop/media.mjs";

test("image as screen, social templates, fit/fill, undo, cold reopen and decoded portrait exports", async () => {
  test.setTimeout(120000);
  const root = path.resolve(".cache/canvas-ui");
  const evidence = path.resolve("evidence/canvas");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(evidence, { recursive: true });
  const ffmpeg = await binary("ffmpeg");
  const input = path.join(root, "Social image.png"),
    camera = path.join(root, "camera.mp4");
  // Distinct colors detect missing frames, fit vs crop, and webcam layout.
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=lime:s=640x400",
    "-vf",
    "drawbox=x=0:y=0:w=120:h=ih:c=blue:t=fill,drawbox=x=520:y=0:w=120:h=ih:c=yellow:t=fill",
    "-frames:v",
    "1",
    input,
  ]);
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x240:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    camera,
  ]);
  const directory = path.join(root, "Social image.framestudio"),
    exports = path.join(root, "exports");
  await fs.mkdir(exports);
  let app, page;
  const errors = [];
  const launch = async (project = false) => {
    app = await electron.launch({
      ...(process.env.FRAME_EXECUTABLE
        ? {
            executablePath: process.env.FRAME_EXECUTABLE,
            args: project ? [`--project=${directory}`] : [],
          }
        : { args: [".", ...(project ? [`--project=${directory}`] : [])] }),
      env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
  };
  const close = async () => {
    await app
      ?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app?.close().catch(() => {});
  };
  const sample = (x, y) =>
    page
      .locator("#preview")
      .evaluate(
        (canvas, [x, y]) =>
          [
            ...canvas
              .getContext("2d")
              .getImageData(canvas.width * x, canvas.height * y, 1, 1).data,
          ].slice(0, 3),
        [x, y],
      );
  try {
    await launch();
    await app.evaluate(
      ({ dialog, desktopCapturer }, { input, camera, directory }) => {
        const files = [
          input,
          directory.slice(0, directory.lastIndexOf("/")),
          camera,
        ];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [files.shift()],
        });

        desktopCapturer.getSources = async () => {
          throw new Error("Media import must not capture the desktop");
        };
      },
      { input, camera, directory },
    );
    await page.locator("#welcome-import").click();
    await expect(page.locator("#project-title")).toHaveText("Social image", {
      timeout: 30000,
    });
    await page.locator("#media-trim-end").fill("2");
    await page.locator("#media-trim-end").press("Tab");
    await page.locator("#media-library-tab").click();
    await page.locator("#attach-camera").click();
    await expect(page.locator("#media-camera-controls")).toBeVisible();
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    await page.locator("#tab-appearance").click();
    await expect
      .poll(async () => (await sample(0.5, 0.5))[1])
      .toBeGreaterThan(240);
    await expect(page.locator('[data-ratio="source"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#canvas-size")).toHaveText("1728 × 1080");
    await expect(page.locator("#preview")).toHaveAttribute("width", "1152");
    await expect(page.locator("#preview")).toHaveAttribute("height", "720");
    const imported = JSON.parse(
      await fs.readFile(path.join(directory, "project.json")),
    );
    expect(imported.edits.style.aspectRatio).toBe("source");
    await page.screenshot({ path: path.join(evidence, "source-default.png") });
    await page.locator("#canvasTemplate").selectOption("tiktok");
    await expect(page.locator("#canvas-size")).toHaveText("1080 × 1920");
    await expect
      .poll(async () => (await sample(0.5, 0.15))[1])
      .toBeLessThan(150);
    await page.locator("#screenFit").selectOption("fill");
    await expect
      .poll(async () => (await sample(0.5, 0.15))[1])
      .toBeGreaterThan(240);
    await page.locator("#canvasTemplate").selectOption("instagram-portrait");
    await page.locator('[data-ratio="1:1"]').click();
    await expect(page.locator("#canvasTemplate")).toHaveValue("custom");
    await page.locator("#undo").click();
    await expect(page.locator("#canvasTemplate")).toHaveValue(
      "instagram-portrait",
    );
    await page.locator("#canvasTemplate").selectOption("instagram-reels");
    await page.locator("#scrubber").fill("1");
    await page.locator("#split").click();
    await expect(page.locator("#clip-count")).toHaveText("2 clips");
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    const p = JSON.parse(
      await fs.readFile(path.join(directory, "project.json")),
    );
    expect(p.edits.style.aspectRatio).toBe("9:16");
    expect(p.tracks.screen.sourceKind).toBe("image");
    expect(p.duration).toBe(10);
    expect(p.edits.segments).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
    expect(
      await fs.readFile(path.join(directory, "screen-original.png")),
    ).toEqual(await fs.readFile(input));
    await close();
    await launch(true);
    await expect(page.locator("#canvasTemplate")).toHaveValue(
      "instagram-reels",
    );
    await expect(page.locator("#clip-count")).toHaveText("2 clips");
    await expect
      .poll(async () => (await sample(0.5, 0.15))[1])
      .toBeGreaterThan(240);
    const points = [
      [0.5, 0.15],
      [0.02, 0.5],
      [0.855, 0.919],
    ];
    const previewColors = await Promise.all(
      points.map(([x, y]) => sample(x, y)),
    );
    expect(previewColors[2][0]).toBeGreaterThan(240);
    await page.screenshot({ path: path.join(evidence, "portrait-editor.png") });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1024, 700),
    );
    await expect
      .poll(async () =>
        page.locator("#preview").evaluate((el) => {
          const box = el.getBoundingClientRect(),
            area = el.parentElement.getBoundingClientRect();
          return (
            box.width > 50 &&
            box.height > 50 &&
            box.left >= area.left &&
            box.right <= area.right + 1 &&
            box.top >= area.top &&
            box.bottom <= area.bottom + 1 &&
            Math.abs(box.width / box.height - 9 / 16) < 0.01
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: path.join(evidence, "portrait-compact.png"),
    });
    await app.evaluate(({ dialog, shell }, exports) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [exports],
      });
      shell.openPath = async () => "";
    }, exports);
    await page.locator("#export").click();
    await page.locator('[name=mode][value="both"]').check();
    await page.locator("#export-height").selectOption("720");
    await page.locator("#export-fps").selectOption("30");
    await expect(page.locator("#export-dimensions")).toContainText(
      "720 × 1280",
    );
    await page.locator("#start-export").click();
    await expect(page.locator("#export-dialog")).not.toBeVisible({
      timeout: 60000,
    });
    const output = path.join(exports, (await fs.readdir(exports))[0]);
    const results = {};
    for (const name of ["combined", "screen", "camera"]) {
      const file = path.join(output, `${name}.mp4`),
        meta = await probe(file);
      expect([meta.width, meta.height]).toEqual(
        name === "combined"
          ? [720, 1280]
          : name === "screen"
            ? [1152, 720]
            : [960, 720],
      );
      expect(Math.abs(meta.duration - 2)).toBeLessThan(0.05);
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
      results[name] = meta;
    }
    const { stdout } = await promisify(execFile)(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        path.join(output, "combined.mp4"),
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
    );
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i],
        offset = (Math.floor(1280 * y) * 720 + Math.floor(720 * x)) * 3;
      for (let c = 0; c < 3; c++)
        expect(Math.abs(stdout[offset + c] - previewColors[i][c])).toBeLessThan(
          12,
        );
    }
    const portraitFile = path.join(root, "Portrait video.mp4"),
      portraitProject = path.join(root, "Portrait video.framestudio");
    await run(ffmpeg, [
      "-v",
      "error",
      "-display_rotation",
      "90",
      "-i",
      path.join(directory, "screen.mp4"),
      "-c",
      "copy",
      portraitFile,
    ]);
    await app.evaluate(
      ({ dialog }, { portraitFile, portraitProject }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [portraitFile],
        });
      },
      { portraitFile, portraitProject },
    );
    await page.locator("#import").click();
    await expect(page.locator("#project-title")).toHaveText("Portrait video");
    await page.locator("#tab-appearance").click();
    await expect(page.locator("#canvas-size")).toHaveText("1080 × 1728");
    await expect
      .poll(() => page.locator("#preview").evaluate((c) => c.width / c.height))
      .toBe(5 / 8);
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    const rotated = JSON.parse(
      await fs.readFile(path.join(portraitProject, "project.json")),
    );
    expect([rotated.tracks.screen.width, rotated.tracks.screen.height]).toEqual(
      [400, 640],
    );
    expect(await fs.readFile(path.join(portraitProject, "screen.mp4"))).toEqual(
      await fs.readFile(portraitFile),
    );
    expect(errors).toEqual([]);
    await fs.writeFile(
      path.join(evidence, "checks.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          packaged: !!process.env.FRAME_EXECUTABLE,
          asarSha256: process.env.FRAME_EXECUTABLE
            ? createHash("sha256")
                .update(
                  await fs.readFile(
                    path.resolve(
                      process.env.FRAME_EXECUTABLE,
                      "../../Resources/app.asar",
                    ),
                  ),
                )
                .digest("hex")
            : null,
          imageImport: true,
          rotatedVideoImport: true,
          newProjectSourceRatio: true,
          persistedTemplates: true,
          compactPortraitFits: true,
          decodedExports: results,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
});
