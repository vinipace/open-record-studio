import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { followFixture } from "../follow-fixture.mjs";
import { cropAt } from "../../desktop/motion.mjs";

test("drag zooms in either direction, cancel, clamp overlap, select fixed focus and persist follow motion", async () => {
  test.setTimeout(120000);
  const root = path.resolve(".cache/zoom-ui"),
    directory = path.join(root, "project.framestudio");
  await fs.rm(root, { recursive: true, force: true });
  const fixture = await followFixture(directory);
  fixture.edits.zooms = [];
  await fs.writeFile(
    path.join(directory, "project.json"),
    JSON.stringify(fixture),
  );
  let app, page, playback;
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
    await page.bringToFront();
    // Isolate CDP gestures from physical mouse/focus changes on the shared desktop.
    // The app disables background throttling, so the hidden window still paints.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((window) => window.hide());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(page.locator("#project-title")).toHaveText(
      "Follow zoom validation",
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
  const saved = async () => {
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    return JSON.parse(await fs.readFile(path.join(directory, "project.json")));
  };
  const total = 3.5 / 1.5;
  const drag = async (from, to, cancel = false) => {
    const box = await page.locator("#zoom-lane").boundingBox();
    const x = (t) => box.x + (box.width * t) / total,
      y = box.y + box.height / 2;
    await page.mouse.move(x(from), y);
    await page.mouse.down();
    await page.mouse.move(x(to), y, { steps: 8 });
    await expect(page.locator(".zoom-draft")).toBeVisible();
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".zoom-draft")).toHaveCount(0);
  };
  try {
    await launch();
    await page.locator("#tab-motion").click();
    // A plain click and tiny movements do not create history or a section.
    await page.locator("#zoom-lane").click({ position: { x: 20, y: 12 } });
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(0);
    await expect(page.locator("#undo")).toBeDisabled();
    await drag(0.1, 1);
    expect((await saved()).edits.zooms[0].end).toBeCloseTo(1.5, 2);
    await page.locator("#undo").click();
    await drag(0.1, 1.9);
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(1);
    await expect(page.locator("#zoom-mode")).toHaveValue("follow");
    let p = await saved();
    expect(p.edits.zooms[0].start).toBeCloseTo(0.15, 2);
    expect(p.edits.zooms[0].end).toBeCloseTo(3.35, 2);
    expect(p.edits.zooms[0].mode).toBe("follow");
    expect(p.edits.zooms[0].ease).toBe(0.6);
    await expect(
      page.getByRole("slider", { name: "Ease in & out" }),
    ).toHaveValue("0.6");
    await expect(page.locator("#section-ease")).toHaveAttribute(
      "title",
      /Duration at each edge/,
    );
    await page.locator("#undo").click();
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(0);
    await page.locator("#redo").click();
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(1);
    await drag(2.25, 2);
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(2);
    p = await saved();
    expect(p.edits.zooms[1].start).toBeCloseTo(3.5, 2);
    expect(p.edits.zooms[1].end).toBeCloseTo(3.875, 2);
    await page.locator("#undo").click();
    // Dragging into an existing section stops at its edge.
    await drag(2.25, 1.6);
    p = await saved();
    expect(p.edits.zooms[1].start).toBe(p.edits.zooms[0].end);
    await page.locator("#undo").click();
    await drag(2.1, 2.3, true);
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(1);
    // Pointer cancellation also leaves no saved or undoable draft.
    const box = await page.locator("#zoom-lane").boundingBox();
    await page.mouse.move(box.x + box.width * 0.9, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.98, box.y + 12, { steps: 5 });
    await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })),
    );
    await page.mouse.up();
    await expect(page.locator(".zoom-draft")).toHaveCount(0);
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(1);
    await page.locator("#zoom-selector").selectOption({ index: 1 });
    await page.locator("#section-ease").fill("0.85");
    await expect(page.locator("#section-ease")).toHaveAttribute(
      "title",
      /Duration at each edge/,
    );
    expect((await saved()).edits.zooms[0].ease).toBe(0.85);
    await page.locator("#undo").click();
    await expect(page.locator("#section-ease")).toHaveValue("0.6");
    await page.locator("#redo").click();
    await expect(page.locator("#section-ease")).toHaveValue("0.85");
    await page.locator('[data-preview="screen"]').click();
    p = await saved();
    const pixel = () =>
      page
        .locator("#preview")
        .evaluate((c) => [
          ...c
            .getContext("2d")
            .getImageData(c.width * 0.15, c.height * 0.8, 1, 1).data,
        ]);
    for (const t of [1.4, 0.65, 1.4]) {
      await page.locator("#scrubber").fill(String(t));
      const crop = cropAt(p.edits, t, fixture.cursor);
      await expect
        .poll(async () =>
          Math.abs((await pixel())[0] - (crop.x + crop.size * 0.15) * 255),
        )
        .toBeLessThan(4);
      await expect
        .poll(async () =>
          Math.abs((await pixel())[1] - (crop.y + crop.size * 0.8) * 255),
        )
        .toBeLessThan(4);
    }
    await page.locator("#back").click();
    await expect.poll(async () => (await pixel())[2]).toBeLessThan(55);
    await page.evaluate(() => {
      document.querySelector("#scrubber").step = "0.000001";
      window.followFrames = [];
      window.followDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        window.followDraw.apply(this, args);
        if (
          this.canvas.id === "preview" &&
          args.length === 9 &&
          args[0] instanceof HTMLVideoElement
        )
          window.followFrames.push({
            wall: performance.now(),
            time: Number(document.querySelector("#scrubber").value),
            x: args[1] / args[0].videoWidth,
            y: args[2] / args[0].videoHeight,
            size: args[3] / args[0].videoWidth,
          });
      };
    });
    await page.locator("#play").click();
    await page.waitForFunction(
      () => Number(document.querySelector("#scrubber").value) > 1.8,
    );
    const frames = await page.evaluate(() => {
      const button = document.querySelector("#play");
      if (button.getAttribute("aria-label") === "Pause") button.click();
      CanvasRenderingContext2D.prototype.drawImage = window.followDraw;
      document.querySelector("#scrubber").step = "0.01";
      return window.followFrames;
    });
    expect(frames.length).toBeGreaterThan(60);
    let maxError = 0,
      maxStep = 0;
    const intervals = [];
    for (const [i, frame] of frames.entries()) {
      const expected = cropAt(p.edits, frame.time, fixture.cursor);
      for (const key of ["x", "y", "size"]) {
        maxError = Math.max(maxError, Math.abs(frame[key] - expected[key]));
        if (i)
          maxStep = Math.max(
            maxStep,
            Math.abs(frame[key] - frames[i - 1][key]),
          );
      }
      if (i > 5) intervals.push(frame.wall - frames[i - 1].wall);
    }
    intervals.sort((a, b) => a - b);
    const p95 = intervals[Math.floor(intervals.length * 0.95)];
    expect(maxError).toBeLessThan(0.00001);
    expect(maxStep).toBeLessThan(0.08);
    expect(p95).toBeLessThan(45);
    playback = {
      frames: frames.length,
      p95PaintIntervalMs: p95,
      maxViewportError: maxError,
      maxViewportStep: maxStep,
    };
    await page.locator("#zoom-mode").selectOption("fixed");
    await page.locator("#pick-zoom-focus").click();
    await expect(page.locator("#preview")).toHaveClass(/picking-focus/);
    const preview = await page.locator("#preview").boundingBox();
    await page.mouse.click(
      preview.x + preview.width * 0.75,
      preview.y + preview.height * 0.35,
    );
    await expect(page.locator("#preview")).not.toHaveClass(/picking-focus/);
    p = await saved();
    expect(p.edits.zooms[0].mode).toBe("fixed");
    expect(p.edits.zooms[0].focusX).toBeCloseTo(1, 2);
    expect(p.edits.zooms[0].focusY).toBeCloseTo(0.2, 2);
    const fixedFocus = p.edits.zooms[0].focusY;
    await page.locator("#pick-zoom-focus").click();
    await page.keyboard.press("Escape");
    expect((await saved()).edits.zooms[0].focusY).toBe(fixedFocus);
    await page.locator("#zoom-mode").selectOption("follow");
    p = await saved();
    await fs.mkdir("evidence/follow", { recursive: true });
    await page.screenshot({ path: "evidence/follow/editor.png" });
    await close();
    await launch();
    await page.locator("#tab-motion").click();
    await page.locator("#zoom-selector").selectOption({ index: 1 });
    await expect(page.locator("#zoom-mode")).toHaveValue("follow");
    await expect(page.locator("#section-ease")).toHaveValue("0.85");
    // Magnification and horizontal scrolling preserve the output/source mapping.
    await page.locator("#timeline-scale").fill(Math.log2(3).toFixed(2));
    await page.locator(".timeline-scroll").evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const lane = await page.locator("#zoom-lane").boundingBox();
    const at = (t) => lane.x + (lane.width * t) / total;
    await page.mouse.move(at(2.1), lane.y + 12);
    await page.mouse.down();
    // Scroll during the gesture; time mapping must include the changed scroll offset.
    await page.locator(".timeline-scroll").evaluate((el) => {
      el.scrollLeft -= 30;
    });
    const shifted = await page.locator("#zoom-lane").boundingBox();
    await page.mouse.move(
      shifted.x + (shifted.width * 2.3) / total,
      lane.y + 12,
      { steps: 5 },
    );
    await expect(page.locator(".zoom-draft")).toBeVisible();
    await page.mouse.up();
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(2);
    p = await saved();
    expect(p.edits.zooms[1].start).toBeCloseTo(3.65, 2);
    expect(p.edits.zooms[1].end).toBeCloseTo(3.95, 2);
    await page.locator("#undo").click();
    await saved();
    await close();
    // Imported media has no tracking data: new sections default to fixed.
    delete p.cursor;
    p.edits.zooms = [];
    await fs.writeFile(path.join(directory, "project.json"), JSON.stringify(p));
    await launch();
    await page.locator("#tab-motion").click();
    await page.locator("#add-zoom").click();
    await expect(page.locator("#zoom-mode")).toHaveValue("fixed");
    await expect(
      page.locator('#zoom-mode option[value="follow"]'),
    ).toBeDisabled();
    await expect(page.locator("#zoom-mode")).toHaveAttribute(
      "title",
      /No recorded mouse data/,
    );
    expect(errors).toEqual([]);
    await fs.writeFile(
      "evidence/follow/ui.json",
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
          dragBothDirections: true,
          smoothDefaultTransitionSeconds: 1.2,
          easingDurationUndoAndColdReopen: true,
          playback,
          clampOverlap: true,
          cancellation: true,
          singleUndo: true,
          fixedFocusPicker: true,
          previewFollows: true,
          coldReopen: true,
          scrolledDrag: true,
          noCursorFallback: true,
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
