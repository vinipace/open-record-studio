import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { layersFixture } from "../layers-fixture.mjs";
import { probe } from "../../desktop/media.mjs";
import { observeAudioMixer } from "./helpers.mjs";

test("add multiple canvas media, arrange, trim, undo, play, save/reopen and export", async () => {
  test.setTimeout(120000);
  const root = path.resolve(".cache/layers-ui"),
    evidence = path.resolve("evidence/layers");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(evidence, { recursive: true });
  const { directory, image, video } = await layersFixture(root);
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
  const sample = (x, y) =>
    page
      .locator("#preview")
      .evaluate(
        (c, [x, y]) =>
          [
            ...c
              .getContext("2d")
              .getImageData(
                Math.floor(c.width * x),
                Math.floor(c.height * y),
                1,
                1,
              ).data,
          ].slice(0, 3),
        [x, y],
      );
  const field = async (name, value) => {
    const input = page.locator(`#layer-${name}`);
    await input.fill(String(value));
    await input.dispatchEvent("change");
    await input.blur();
  };
  try {
    await launch();
    await observeAudioMixer(page);
    // Preserve an unsaved canvas change while importing into the existing project.
    await page.locator('[data-ratio="1:1"]').click();
    await app.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = async (_w, opts) => {
          if (!opts.properties.includes("multiSelections"))
            throw new Error("Expected multi-file media picker");
          return { canceled: false, filePaths: files };
        };
      },
      [image, video],
    );
    await page.evaluate(() => {
      window.layerVideos = [];
      const original = document.createElement.bind(document);
      document.createElement = (...args) => {
        const el = original(...args);
        if (args[0] === "video") window.layerVideos.push(el);
        return el;
      };
    });
    await page.locator("#add-media").click();
    await expect(page.locator("#layer-list .layer-item")).toHaveCount(2);
    await expect(page.locator("#project-title")).toHaveText("Layers •");
    await expect
      .poll(async () => (await sample(0.5, 0.5))[2])
      .toBeGreaterThan(240);
    await expect
      .poll(() => page.evaluate(() => window.layerVideos.length))
      .toBe(1);
    expect(
      await page.evaluate(() =>
        window.layerVideos.every(
          (v) =>
            v.paused &&
            window.audioMixers.some(
              (m) => m.element === v && m.gain.value === 0,
            ),
        ),
      ),
    ).toBe(true);
    await page.locator("#layer-back").click();
    await expect
      .poll(async () => (await sample(0.5, 0.5))[0])
      .toBeGreaterThan(240);
    await page.locator("#undo").click();
    await expect
      .poll(async () => (await sample(0.5, 0.5))[2])
      .toBeGreaterThan(240);
    await field("x", 65);
    await field("width", 20);
    await field("start", 1);
    await field("end", 3);
    await expect(page.locator("#layer-end")).toHaveValue("3");
    await expect
      .poll(async () => (await sample(0.65, 0.5))[1])
      .toBeGreaterThan(240);
    await page.locator("#scrubber").fill("1.5");
    await expect
      .poll(async () => (await sample(0.65, 0.5))[2])
      .toBeGreaterThan(240);
    await expect
      .poll(() =>
        page.evaluate(() => Math.abs(window.layerVideos[0].currentTime - 0.5)),
      )
      .toBeLessThan(0.06);
    // Drag and corner resize are separate undoable gestures.
    const box = await page.locator("#preview").boundingBox();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.6, {
      steps: 8,
    });
    await page.mouse.up();
    await expect
      .poll(async () => Number(await page.locator("#layer-x").inputValue()))
      .toBeGreaterThan(74);
    await page.locator("#undo").click();
    await expect(page.locator("#layer-x")).toHaveValue("65");
    const corner = await page.locator(".canvas-layer-outline i").boundingBox();
    await page.mouse.move(
      corner.x + corner.width / 2,
      corner.y + corner.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(corner.x + 30, corner.y + 20, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => Number(await page.locator("#layer-width").inputValue()))
      .toBeGreaterThan(25);
    await page.locator("#undo").click();
    await expect(page.locator("#layer-width")).toHaveValue("20");
    // Trim using the layer's own timeline handles, not the screen clip handles.
    const handle = page
      .locator('.layer-clip.selected [data-layer-trim="end"]')
      .last();
    await handle.scrollIntoViewIfNeeded();
    const h = await handle.boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x - 45, h.y + h.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => Number(await page.locator("#layer-end").inputValue()))
      .toBeLessThan(2.9);
    await page.locator("#undo").click();
    await expect(page.locator("#layer-end")).toHaveValue("3");
    await page.locator("#remove-layer").click();
    await expect(page.locator("#layer-list .layer-item")).toHaveCount(1);
    await page.locator("#undo").click();
    await expect(page.locator("#layer-list .layer-item")).toHaveCount(2);
    // Follow the existing clock, then stop decoding once the layer has ended.
    await page.locator("#scrubber").fill("1.2");
    await page.locator("#play").click();
    await expect
      .poll(() =>
        page.evaluate(() => window.layerVideos.some((v) => !v.paused)),
      )
      .toBe(true);
    await expect
      .poll(() => page.locator("#scrubber").inputValue(), { timeout: 5000 })
      .not.toBe("1.2");
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Number(document.querySelector("#scrubber").value),
          ),
        { timeout: 6000 },
      )
      .toBeGreaterThan(3.2);
    expect(
      await page.evaluate(() => window.layerVideos.every((v) => v.paused)),
    ).toBe(true);
    await page.locator("#play").click();
    await page.locator("#scrubber").fill("1.5");
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    const saved = JSON.parse(
      await fs.readFile(path.join(directory, "project.json")),
    );
    expect(saved.edits.layers).toHaveLength(2);
    expect(Object.keys(saved.assets)).toHaveLength(2);
    expect(saved.edits.style.aspectRatio).toBe("1:1");
    expect(saved.edits.layers[1]).toMatchObject({
      start: 1,
      end: 3,
      x: 0.65,
      y: 0.5,
      width: 0.2,
    });
    expect(
      await fs.readFile(
        path.join(directory, saved.assets[saved.edits.layers[0].assetId].file),
      ),
    ).toEqual(await fs.readFile(image));
    await page.locator("#media-library-tab").click();
    await page.locator("#layer-list .layer-item").first().click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].showInactive(),
    );
    await page.screenshot({ path: path.join(evidence, "editor.png") });
    await close();
    await launch();
    await page.locator("#tab-media").click();
    await expect(page.locator("#layer-list .layer-item")).toHaveCount(2);
    await expect
      .poll(async () => (await sample(0.5, 0.5))[0])
      .toBeGreaterThan(240);
    await expect
      .poll(async () => (await sample(0.65, 0.5))[1])
      .toBeGreaterThan(240);
    await page.locator("#scrubber").fill("1.5");
    await expect
      .poll(async () => (await sample(0.65, 0.5))[2])
      .toBeGreaterThan(240);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1024, 700),
    );
    await page.locator("#media-library-tab").click();
    await page.locator("#layer-list .layer-item").first().click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].showInactive(),
    );
    await page.screenshot({ path: path.join(evidence, "compact.png") });
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
      timeout: 60000,
    });
    const folder = (await fs.readdir(output))[0];
    const exported = await probe(path.join(output, folder, "combined.mp4"));
    expect([exported.width, exported.height]).toEqual([720, 720]);
    expect(exported.audio).toBe(true);
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
          multipleMediaImport: true,
          preservedUnsavedEdits: true,
          transparentImages: true,
          dragResizeTrimUndo: true,
          inactiveVideoPaused: true,
          saveColdReopen: true,
          export: exported,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
});
