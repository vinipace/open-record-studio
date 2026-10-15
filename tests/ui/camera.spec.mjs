import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { motionFixture } from "../motion-fixture.mjs";

test("camera flip updates both previews, preserves the screen, and survives undo and cold reopen", async () => {
  const root = path.resolve(".cache/camera-ui");
  await fs.rm(root, { recursive: true, force: true });
  const directory = path.join(root, "project.framestudio");
  const fixture = await motionFixture(directory);
  fixture.edits.segments = [{ start: 0, end: 2 }];
  fixture.edits.zooms = [];
  Object.assign(fixture.edits.style, {
    speed: 1,
    showCursor: false,
    cameraSize: 0.5,
    cameraCorner: "top-left",
    cameraRoundness: 0.4,
  });
  await fs.writeFile(
    path.join(directory, "project.json"),
    JSON.stringify(fixture),
  );
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
    await expect(page.locator("#project-title")).toHaveText(
      "Motion validation",
    );
    await page.locator("#tab-camera").click();
  };
  const close = async () => {
    await app
      ?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app?.close().catch(() => {});
  };
  const red = (x, y) =>
    page
      .locator("#preview")
      .evaluate(
        (c, [x, y]) =>
          c.getContext("2d").getImageData(x * c.width, y * c.height, 1, 1)
            .data[0],
        [x, y],
      );
  try {
    await launch();
    await page.locator('[data-preview="camera"]').click();
    await expect(page.locator("#cameraFlip")).not.toBeChecked();
    await expect.poll(() => red(0.2, 0.5)).toBeGreaterThan(40);
    expect(await red(0.2, 0.5)).toBeLessThan(65);
    await page
      .getByRole("checkbox", { name: "Flip horizontally", exact: true })
      .check();
    await expect.poll(() => red(0.2, 0.5)).toBeGreaterThan(190);
    await page.locator("#undo").click();
    await expect(page.locator("#cameraFlip")).not.toBeChecked();
    await expect.poll(() => red(0.2, 0.5)).toBeLessThan(65);
    await page.locator("#redo").click();
    await expect(page.locator("#cameraFlip")).toBeChecked();
    await expect.poll(() => red(0.2, 0.5)).toBeGreaterThan(190);
    await page.locator('[data-preview="combined"]').click();
    await expect.poll(() => red(173 / 1280, 365 / 720)).toBeGreaterThan(155);
    await page.locator("#cameraFlip").uncheck();
    await expect.poll(() => red(173 / 1280, 365 / 720)).toBeLessThan(100);
    await page.locator("#cameraFlip").check();
    await page.locator('[data-preview="screen"]').click();
    await expect.poll(() => red(0.2, 0.5)).toBeLessThan(65);
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    expect(
      JSON.parse(await fs.readFile(path.join(directory, "project.json"))).edits
        .style.cameraFlip,
    ).toBe(true);
    await close();
    await launch();
    await expect(page.locator("#cameraFlip")).toBeChecked();
    await page.locator('[data-preview="camera"]').click();
    await expect.poll(() => red(0.2, 0.5)).toBeGreaterThan(190);
    await fs.mkdir("evidence/camera", { recursive: true });
    await page.screenshot({ path: "evidence/camera/flip.png" });
    expect(errors).toEqual([]);
    await fs.writeFile(
      "evidence/camera/checks.json",
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
          cameraAndCompositionPixels: true,
          screenUnchanged: true,
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
