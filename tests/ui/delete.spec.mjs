import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { layersFixture } from "../layers-fixture.mjs";
import { saveProject, probe } from "../../desktop/media.mjs";
import { audioEnergy } from "../media-checks.mjs";

test("Delete and Backspace target selected media, zoom and audio with undo, input guards, persistence and rendered silence", async () => {
  test.setTimeout(90000);
  const root = path.resolve(".cache/delete-ui"),
    evidence = path.resolve("evidence/delete");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(evidence, { recursive: true });
  const { project, directory, image } = await layersFixture(root);
  await fs.copyFile(image, path.join(directory, "logo.png"));
  project.assets = {
    logo: {
      file: "logo.png",
      name: "Logo",
      sourceKind: "image",
      width: 160,
      height: 80,
      duration: 0,
    },
  };
  project.tracks.microphone = { ...project.tracks.screen };
  project.edits.segments = [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ];
  project.edits.layers = [
    {
      id: "logo",
      assetId: "logo",
      start: 0,
      end: 4,
      mediaStart: 0,
      x: 0.5,
      y: 0.5,
      width: 0.4,
      opacity: 1,
      visible: true,
    },
  ];
  project.edits.zooms = [
    {
      id: "zoom",
      mode: "fixed",
      start: 0.5,
      end: 1.5,
      zoom: 2,
      focusX: 0.5,
      focusY: 0.5,
      ease: 0.3,
    },
  ];
  await saveProject(project);
  let app, page;
  const errors = [];
  const launch = async () => {
    app = await electron.launch({
      ...(process.env.FRAME_EXECUTABLE
        ? {
            executablePath: process.env.FRAME_EXECUTABLE,
            args: [`--project=${directory}`],
          }
        : { args: [".", `--project=${directory}`] }),
      env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.bringToFront();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].hide(),
    );
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
  };
  const close = async () => {
    await app
      ?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app?.close().catch(() => {});
  };
  const clips = () => expect(page.locator("#screen-lane .clip")).toHaveCount(2);
  const selectZoom = async () => {
    await page.locator("#zoom-lane [data-zoom-id]").click();
    await expect(page.locator("#delete")).toHaveAttribute(
      "aria-label",
      "Delete selected zoom",
    );
  };
  try {
    await launch();
    await page.locator("#tab-media").click();
    await page.locator("#media-library-tab").click();
    await page.locator("#layer-list .layer-item").click();
    await page.keyboard.press("Delete");
    await expect(page.locator("#layer-list .layer-item")).toHaveCount(0);
    await clips();
    await page.keyboard.press("Backspace");
    await clips();
    await page.locator("#undo").click();
    await page.locator("#media-library-tab").click();
    await page.locator("#layer-list .layer-item").click();
    await page.keyboard.press("Backspace");
    await expect(page.locator("#layer-list .layer-item")).toHaveCount(0);
    await page.locator("#undo").click();
    await selectZoom();
    await page.keyboard.press("Delete");
    await expect(page.locator("#zoom-lane [data-zoom-id]")).toHaveCount(0);
    await expect(page.locator("#layer-list .layer-item")).toHaveCount(1);
    await clips();
    await page.keyboard.press("Delete");
    await clips();
    await page.locator("#undo").click();
    await selectZoom();
    await page.locator("#section-zoom").focus();
    await page.keyboard.press("Backspace");
    await expect(page.locator("#zoom-lane [data-zoom-id]")).toHaveCount(0);
    await page.locator("#undo").click();
    await selectZoom();
    // Delete edits text while a number field, contenteditable, or dialog has focus.
    await page.locator("#zoom-start").focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await expect(page.locator("#zoom-start")).toHaveValue("");
    await expect(page.locator("#zoom-lane [data-zoom-id]")).toHaveCount(1);
    await page.locator("#zoom-start").fill("0.5");
    await page.locator("#zoom-start").blur();
    await page.evaluate(() => {
      const box = document.createElement("div");
      box.id = "typing-test";
      box.contentEditable = "true";
      box.textContent = "Typing";
      document.body.append(box);
      box.focus();
    });
    await page.keyboard.press("Delete");
    await expect(page.locator("#zoom-lane [data-zoom-id]")).toHaveCount(1);
    await page.locator("#typing-test").evaluate((e) => e.remove());
    await page.locator("#export").click();
    await page.keyboard.press("Delete");
    await expect(page.locator("#zoom-lane [data-zoom-id]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await selectZoom();
    await page.evaluate(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Delete",
          repeat: true,
          bubbles: true,
        }),
      ),
    );
    await expect(page.locator("#zoom-lane [data-zoom-id]")).toHaveCount(1);
    // Track real media volume assignments: deletion must affect both sources only in range.
    await page.evaluate(() => {
      window.deleteVolumes = {};
      const original = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        "volume",
      );
      Object.defineProperty(HTMLMediaElement.prototype, "volume", {
        ...original,
        set(value) {
          window.deleteVolumes[new URL(this.src).pathname.split("/").pop()] =
            value;
          original.set.call(this, value);
        },
      });
    });
    await page.locator("#audio-lane .clip").first().click();
    await expect(page.locator("#audio-lane .selected")).toHaveCount(1);
    await expect(page.locator("#screen-lane .selected")).toHaveCount(0);
    await expect(page.locator("#zoom-lane .selected")).toHaveCount(0);
    await page.keyboard.press("Delete");
    await expect(page.locator("#audio-lane .clip")).toHaveCount(1);
    await clips();
    await expect
      .poll(() => page.evaluate(() => window.deleteVolumes))
      .toMatchObject({ screen: 0, microphone: 0 });
    await page.locator("#scrubber").fill("2.5");
    await expect
      .poll(() => page.evaluate(() => window.deleteVolumes))
      .toMatchObject({ screen: 1, microphone: 1 });
    await page.locator("#undo").click();
    await expect(page.locator("#audio-lane .clip")).toHaveCount(2);
    await page.locator("#redo").click();
    await expect(page.locator("#audio-lane .clip")).toHaveCount(1);
    await page.locator("#audio-lane .clip").click();
    await page.keyboard.press("Backspace");
    await expect(page.locator("#audio-lane .clip")).toHaveCount(0);
    await clips();
    await page.keyboard.press("Delete");
    await clips();
    await page.locator("#undo").click();
    await expect(page.locator("#audio-lane .clip")).toHaveCount(1);
    // Clicking a video clip clears the audio target; the toolbar uses the same deletion path.
    await page.locator("#screen-lane .clip").last().click();
    await page.locator("#delete").click();
    await expect(page.locator("#screen-lane .clip")).toHaveCount(1);
    await page.locator("#undo").click();
    await clips();
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    const saved = JSON.parse(
      await fs.readFile(path.join(directory, "project.json")),
    );
    expect(saved.edits.removedAudio).toEqual([{ start: 0, end: 2 }]);
    expect(saved.edits.zooms).toHaveLength(1);
    expect(saved.edits.layers).toHaveLength(1);
    await close();
    await launch();
    await clips();
    await expect(page.locator("#audio-lane .clip")).toHaveCount(1);
    await expect(page.locator("#audio-lane .clip")).toHaveAttribute(
      "data-audio-start",
      "2",
    );
    const output = path.join(root, "exports");
    await fs.mkdir(output);
    await app.evaluate(({ dialog, shell }, output) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [output],
      });
      shell.openPath = async () => "";
    }, output);
    await page.locator("#export").click();
    await page.locator("#export-height").selectOption("720");
    await page.locator("#export-fps").selectOption("30");
    await page.locator("#start-export").click();
    await expect(page.locator("#export-dialog")).not.toBeVisible({
      timeout: 30000,
    });
    const movie = path.join(
      output,
      (await fs.readdir(output))[0],
      "combined.mp4",
    );
    expect((await probe(movie)).duration).toBe(4);
    const removedEnergy = await audioEnergy(movie, 0.5),
      retainedEnergy = await audioEnergy(movie, 2.5);
    expect(removedEnergy).toBeLessThan(0.0001);
    expect(retainedEnergy).toBeGreaterThan(0.02);
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
          selectedTargetDeletion: true,
          deleteAndBackspace: true,
          undoRedo: true,
          inputDialogRepeatGuards: true,
          audioPreservesVideo: true,
          saveColdReopen: true,
          removedEnergy,
          retainedEnergy,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
});
