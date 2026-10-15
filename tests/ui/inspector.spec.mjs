import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { layersFixture } from "../layers-fixture.mjs";
import { saveProject } from "../../desktop/media.mjs";

test("inspector keeps properties accessible, browses long media lists with one scroll surface, and supports keyboard navigation", async () => {
  const root = path.resolve(".cache/inspector-ui"),
    evidence = path.resolve("evidence/inspector");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(evidence, { recursive: true });
  const { project, directory, image } = await layersFixture(root);
  await fs.copyFile(image, path.join(directory, "logo.png"));
  project.tracks.microphone = { ...project.tracks.screen };
  project.assets = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      "asset-" + i,
      {
        file: "logo.png",
        name:
          i === 0
            ? "Product walkthrough — a deliberately long overlay filename.png"
            : `Product image ${i + 1}.png`,
        sourceKind: "image",
        width: 160,
        height: 80,
        duration: 0,
      },
    ]),
  );
  project.edits.layers = Array.from({ length: 12 }, (_, i) => ({
    id: "layer-" + i,
    assetId: "asset-" + i,
    start: 0,
    end: 4,
    mediaStart: 0,
    x: 0.5,
    y: 0.5,
    width: 0.1,
    opacity: 1,
    visible: false,
  }));
  await saveProject(project);
  const app = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? {
          executablePath: process.env.FRAME_EXECUTABLE,
          args: [`--project=${directory}`],
        }
      : { args: [".", `--project=${directory}`] }),
    env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator("#project-title")).toHaveText("Layers");
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(1440, 930);
      win.hide();
    });
    const screenshot = async (name) => {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].showInactive(),
      );
      await page
        .locator(".inspector")
        .screenshot({ path: path.join(evidence, name) });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].hide(),
      );
    };
    await page.locator("#tab-media").click();
    await expect(page.locator("#media-properties-view")).toBeVisible();
    await expect(page.locator("#media-library-view")).toBeHidden();
    await expect(page.locator("#media-count")).toHaveText("15");
    await expect(page.locator("#media-padding")).toBeInViewport();
    expect(
      await page
        .locator("#media-padding")
        .evaluate((el) => el.style.getPropertyValue("--fill")),
    ).toBe("0%");
    expect(
      await page
        .locator("#media-volume")
        .evaluate((el) => el.style.getPropertyValue("--fill")),
    ).toBe("100%");
    await screenshot("screen-properties.png");
    await page.locator("#media-properties-tab").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#media-library-tab")).toBeFocused();
    await expect(page.locator("#media-library-view")).toBeVisible();
    await expect(page.locator("#media-properties-view")).toBeHidden();
    const scrollSurfaces = () =>
      page
        .locator(".inspector")
        .evaluate((inspector) =>
          [...inspector.querySelectorAll("div")]
            .filter(
              (el) =>
                el.clientHeight > 0 &&
                el.scrollHeight > el.clientHeight + 1 &&
                /auto|scroll/.test(getComputedStyle(el).overflowY),
            )
            .map((el) => el.id),
        );
    expect(await scrollSurfaces()).toEqual(["settings"]);
    await screenshot("media-library.png");
    await page.locator('[data-media-track="camera"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#media-source-name")).toBeFocused();
    await expect(page.locator("#media-cameraRoundness")).toBeInViewport();
    await page.locator("#media-cameraRoundness").fill("65");
    await page.locator("#media-cameraRoundness").blur();
    await page.locator("#undo").click();
    await expect(page.locator("#media-cameraRoundness")).toHaveValue("100");
    await page.locator("#redo").click();
    await expect(page.locator("#media-cameraRoundness")).toHaveValue("65");
    await screenshot("camera-properties.png");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1024, 700),
    );
    await page.locator("#media-library-tab").click();
    await page.locator('#layer-list [data-layer="layer-0"]').click();
    await expect(page.locator("#layer-name")).toBeFocused();
    await expect(page.locator("#layer-name")).toHaveText(
      project.assets["asset-0"].name,
    );
    await expect(page.locator("#layer-width")).toBeInViewport();
    await expect(page.locator("#add-layer")).toBeInViewport();
    expect(await page.locator("#settings").evaluate((el) => el.scrollTop)).toBe(
      0,
    );
    expect(
      await page
        .locator("#settings")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await screenshot("overlay-compact.png");
    await page.locator("#tab-camera").click();
    await page.locator("#cameraOffset").scrollIntoViewIfNeeded();
    const scroll = await page
      .locator("#settings")
      .evaluate((el) => el.scrollTop);
    expect(scroll).toBeGreaterThan(20);
    await page.locator("#tab-audio").click();
    await page.locator("#tab-camera").click();
    expect(
      Math.abs(
        (await page.locator("#settings").evaluate((el) => el.scrollTop)) -
          scroll,
      ),
    ).toBeLessThan(2);
    await page.locator("#tab-camera").press("ArrowRight");
    await expect(page.locator("#tab-audio")).toBeFocused();
    for (const id of [
      "appearance",
      "camera",
      "audio",
      "motion",
      "clip",
      "media",
    ])
      await expect(page.locator("#tab-" + id + " span")).toBeInViewport();
    await page.locator("#tab-media").click();
    await page.locator("#media-library-tab").click();
    await page.locator('[data-media-track="microphone"]').click();
    await expect(page.locator("#media-microphoneVolume")).toBeInViewport();
    await expect(page.locator("#media-screen-controls")).toBeHidden();
    await screenshot("audio-properties.png");
    expect(errors).toEqual([]);
    await fs.writeFile(
      path.join(evidence, "checks.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          labeledNavigation: true,
          propertiesFirst: true,
          oneScrollSurface: true,
          longNames: true,
          fifteenMediaItems: true,
          compactControlsVisible: true,
          keyboardSelection: true,
          perPanelScrollRestored: true,
          undoRedo: true,
          errors,
          asarSha256: process.env.FRAME_EXECUTABLE
            ? createHash("sha256")
                .update(
                  await fs.readFile(
                    "release/Open Record Studio.app/Contents/Resources/app.asar",
                  ),
                )
                .digest("hex")
            : null,
        },
        null,
        2,
      ),
    );
  } finally {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((win) => win.destroy()),
      )
      .catch(() => {});
    await app.close().catch(() => {});
  }
});
