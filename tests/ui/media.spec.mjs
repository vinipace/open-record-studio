import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { layersFixture } from "../layers-fixture.mjs";

test("direct file selection and selected-media properties survive cancellation, attachment, undo and reopen", async () => {
  const root = path.resolve(".cache/media-ui"),
    evidence = path.resolve("evidence/media");
  await fs.rm(root, { recursive: true, force: true });
  const fixture = await layersFixture(path.join(root, "fixtures"));
  const input = path.join(root, "Presentation.mp4"),
    folder = path.join(root, "Projects");
  await fs.copyFile(path.join(fixture.directory, "screen.mp4"), input);
  await fs.mkdir(folder);
  await fs.mkdir(evidence, { recursive: true });
  const directory = path.join(folder, "Presentation.framestudio"),
    json = path.join(directory, "project.json");
  let app, page;
  const errors = [];
  const launch = async (reopen = false) => {
    const args = reopen ? [`--project=${directory}`] : [];
    app = await electron.launch({
      ...(process.env.FRAME_EXECUTABLE
        ? { executablePath: process.env.FRAME_EXECUTABLE, args }
        : { args: [".", ...args] }),
      env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(page.locator("#project-title")).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].hide(),
    );
  };
  const close = async () => {
    await app
      ?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app?.close().catch(() => {});
  };
  const screenshot = async (name) => {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].showInactive(),
    );
    await page.screenshot({ path: path.join(evidence, name) });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].hide(),
    );
  };
  const dialogs = async (choices) =>
    app.evaluate(({ dialog }, choices) => {
      globalThis.__choices = choices;
      dialog.showSaveDialog = async () => {
        throw new Error("Import must not ask for a project filename");
      };
      dialog.showOpenDialog = async (_window, options) => {
        const next = globalThis.__choices.shift();
        if (!next || !options.title.includes(next.title))
          throw new Error("Unexpected dialog: " + options.title);
        return {
          canceled: !!next.cancel,
          filePaths: next.path ? [next.path] : [],
        };
      };
    }, choices);
  const source = (track) => page.locator(`[data-media-track="${track}"]`);
  const number = async (selector, value) => {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).press("Tab");
  };
  try {
    await launch();
    await expect(page.locator("#timeline-empty")).toBeVisible();
    await expect(page.locator("#import-dialog")).toHaveCount(0);
    await dialogs([{ title: "video or image", cancel: true }]);
    await page.locator("#welcome-import").click();
    await expect
      .poll(() => app.evaluate(() => globalThis.__choices.length))
      .toBe(0);
    await expect(page.locator("#welcome-import")).toBeEnabled();
    await expect(page.locator("#timeline-empty")).toBeVisible();
    await screenshot("empty.png");
    await dialogs([
      { title: "video or image", path: input },
      { title: "all your projects", path: folder },
    ]);
    await page.locator("#welcome-import").click();
    await expect(page.locator("#project-title")).toHaveText("Presentation");
    await expect(page.locator("#tab-media")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(source("screen")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#media-source-name")).toHaveText(
      "Presentation.mp4",
    );
    await expect(page.locator("#screen-track-name")).toHaveText("Media");
    await expect(page.locator("#screen-lane .clip")).toContainText(
      "Presentation.mp4",
    );
    await expect(page.locator("#camera-lane")).toBeHidden();
    const originalPadding = await page.locator("#media-padding").inputValue();
    await page.locator("#media-padding").fill("8");
    await page.locator("#media-padding").blur();
    await page.locator("#undo").click();
    await expect(page.locator("#media-padding")).toHaveValue(originalPadding);
    await page.locator("#redo").click();
    await expect(page.locator("#media-padding")).toHaveValue("8");
    await page.locator("#media-screenFit").selectOption("fill");
    await page.locator("#media-volume").fill("45");
    await number("#media-trim-start", 0.25);
    await number("#media-trim-end", 3.5);
    await page.locator("#media-speed").selectOption("1.25");
    await dialogs([{ title: "video or image", cancel: true }]);
    page.once("dialog", (d) => d.accept());
    await page.locator("#import").click();
    await expect(page.locator("#import")).toBeEnabled();
    await expect(page.locator("#project-title")).toHaveText("Presentation •");
    await expect(page.locator("#media-padding")).toHaveValue("8");
    await dialogs([{ title: "webcam video", cancel: true }]);
    await page.locator("#media-library-tab").click();
    await page.locator("#attach-camera").click();
    await expect(page.locator("#attach-camera")).toBeEnabled();
    await expect(source("camera")).toHaveCount(0);
    // Reject stale metadata updates and remove their staged media copy.
    const before = await fs.readFile(json),
      files = await fs.readdir(directory);
    await dialogs([{ title: "webcam video", path: fixture.video }]);
    const stale = await page.evaluate(async () => {
      const p = (await window.studio.status()).project;
      try {
        await window.studio.attachCamera(p.id, "stale");
        return "";
      } catch (error) {
        return String(error);
      }
    });
    expect(stale).toContain("changed on disk");
    expect(await fs.readFile(json)).toEqual(before);
    expect(await fs.readdir(directory)).toEqual(files);
    await dialogs([{ title: "webcam video", path: fixture.video }]);
    await page.locator("#media-library-tab").click();
    await page.locator("#attach-camera").click();
    await expect(source("camera")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#media-camera-controls")).toBeVisible();
    await expect(page.locator("#media-screen-controls")).toBeHidden();
    await page.locator("#media-cameraFlip").check();
    await page.locator("#media-cameraRoundness").fill("70");
    await page.locator("#media-library-tab").click();
    await source("screen").click();
    await expect(page.locator("#media-padding")).toHaveValue("8");
    await expect(page.locator("#media-trim-start")).toHaveValue("0.25");
    await expect(page.locator("#media-speed")).toHaveValue("1.25");
    // Selection from the timeline and composition opens the same media properties.
    await page.locator("#camera-lane .clip").click();
    await expect(source("camera")).toHaveAttribute("aria-pressed", "true");
    await page.locator("#preview").click({ position: { x: 20, y: 20 } });
    await expect(source("screen")).toHaveAttribute("aria-pressed", "true");
    await dialogs([{ title: "images or videos", path: fixture.image }]);
    await page.locator("#add-layer").click();
    await expect(page.locator("#layer-settings")).toBeVisible();
    await expect(page.locator("#media-source-settings")).toBeHidden();
    await page.locator("#layer-opacity").fill("60");
    await page.locator("#media-library-tab").click();
    await source("screen").click();
    await expect(page.locator("#layer-settings")).toBeHidden();
    await expect(page.locator("#media-source-settings")).toBeVisible();
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    const saved = JSON.parse(await fs.readFile(json));
    expect(saved.edits.style).toMatchObject({
      padding: 0.08,
      screenFit: "fill",
      volume: 0.45,
      speed: 1.25,
      cameraFlip: true,
      cameraRoundness: 0.7,
    });
    expect(saved.edits.segments).toEqual([{ start: 0.25, end: 3.5 }]);
    expect(saved.edits.layers[0].opacity).toBe(0.6);
    expect(saved.tracks.screen).toMatchObject({
      name: "Presentation.mp4",
      sourceKind: "video",
    });
    expect(
      await fs.readFile(path.join(directory, saved.tracks.camera.file)),
    ).toEqual(await fs.readFile(fixture.video));
    expect(
      await fs.readFile(path.join(directory, saved.tracks.screen.file)),
    ).toEqual(await fs.readFile(input));
    await screenshot("selected-video.png");
    await close();
    await launch(true);
    await expect(page.locator("#project-title")).toHaveText("Presentation");
    await page.locator("#tab-media").click();
    await expect(source("screen")).toContainText("Presentation.mp4");
    await expect(page.locator("#media-padding")).toHaveValue("8");
    await page.locator("#media-library-tab").click();
    await source("camera").click();
    await expect(page.locator("#media-cameraFlip")).toBeChecked();
    await expect(page.locator("#media-cameraRoundness")).toHaveValue("70");
    await expect
      .poll(() =>
        page
          .locator("#preview")
          .evaluate(
            (canvas) =>
              canvas
                .getContext("2d")
                .getImageData(canvas.width / 2, canvas.height / 2, 1, 1)
                .data[1],
          ),
      )
      .toBeGreaterThan(240);
    await screenshot("selected-webcam.png");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1024, 700),
    );
    await page.locator("#media-library-tab").click();
    await page.locator("#layer-list .layer-item").click();
    await expect(page.locator("#layer-opacity")).toHaveValue("60");
    await page.locator("#layer-opacity").scrollIntoViewIfNeeded();
    await screenshot("selected-layer-compact.png");
    expect(errors).toEqual([]);
    await fs.writeFile(
      path.join(evidence, "checks.json"),
      JSON.stringify(
        {
          asarSha256: process.env.FRAME_EXECUTABLE
            ? createHash("sha256")
                .update(
                  await fs.readFile(
                    "release/Open Record Studio.app/Contents/Resources/app.asar",
                  ),
                )
                .digest("hex")
            : null,
          directPicker: true,
          importCancellation: true,
          emptyTracksHidden: true,
          selectedMediaProperties: true,
          unsavedEditsPreserved: true,
          webcamAttachment: true,
          staleRevisionRejected: true,
          canvasAndTimelineSelection: true,
          sourceFilesUnchanged: true,
          undoRedo: true,
          coldReopen: true,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
});
