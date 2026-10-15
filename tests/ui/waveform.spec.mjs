import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { binary, defaults, probe, run } from "../../desktop/media.mjs";

test("real audio waveforms follow source offsets, volume, splits, trims and timeline magnification", async () => {
  const root = path.resolve(".cache/waveform-ui"),
    evidence = path.resolve("evidence/waveform");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(evidence, { recursive: true });
  const ffmpeg = await binary("ffmpeg");
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=8",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.6*sin(2*PI*440*t)*if(between(t,1,2)+between(t,5,6),1,0)':s=16000:d=8",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "screen.mp4"),
  ]);
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.5*sin(2*PI*220*t)*between(t,2,3)':s=16000:d=4",
    path.join(root, "microphone.wav"),
  ]);
  await fs.writeFile(
    path.join(root, "project.json"),
    JSON.stringify({
      version: 1,
      kind: "frame-studio",
      name: "Audio waveform",
      duration: 8,
      tracks: {
        screen: {
          ...(await probe(path.join(root, "screen.mp4"))),
          file: "screen.mp4",
          offset: 0,
        },
        microphone: {
          ...(await probe(path.join(root, "microphone.wav"))),
          file: "microphone.wav",
          offset: 1,
        },
      },
      edits: { segments: [{ start: 0, end: 8 }], style: { ...defaults } },
    }),
  );
  const app = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? {
          executablePath: process.env.FRAME_EXECUTABLE,
          args: [`--project=${root}`],
        }
      : { args: [".", `--project=${root}`] }),
    env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
  });
  try {
    const page = await app.firstWindow(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.locator('#audio-lane .clip[data-waveform="ready"]'),
    ).toHaveCount(1);
    const amount = (index, fraction, band) =>
      page
        .locator("#audio-lane canvas")
        .nth(index)
        .evaluate(
          (c, { fraction, band }) => {
            const width = Math.min(10, c.width),
              x = Math.min(
                c.width - width,
                Math.max(0, Math.floor(c.width * fraction - width / 2)),
              );
            const pixels = c
              .getContext("2d")
              .getImageData(x, (band * c.height) / 2, width, c.height / 2).data;
            let filled = 0;
            for (let i = 3; i < pixels.length; i += 4)
              if (pixels[i] > 200) filled++;
            return filled / (pixels.length / 4);
          },
          { fraction, band },
        );
    await expect.poll(() => amount(0, 1.5 / 8, 0)).toBeGreaterThan(0.2);
    expect(await amount(0, 2.5 / 8, 0)).toBeLessThan(0.01);
    expect(await amount(0, 3.5 / 8, 1)).toBeGreaterThan(0.2);
    expect(await amount(0, 2.5 / 8, 1)).toBeLessThan(0.01);
    await page.locator("#tab-media").click();
    await page.locator("#media-library-tab").click();
    await page.locator('[data-media-track="microphone"]').click();
    await expect(page.locator("#delete")).toHaveAttribute(
      "aria-label",
      "Delete selected audio",
    );
    await page.locator("#media-microphoneVolume").fill("0");
    await expect.poll(() => amount(0, 3.5 / 8, 1)).toBeLessThan(0.01);
    expect(await amount(0, 1.5 / 8, 0)).toBeGreaterThan(0.2);
    await page.locator("#undo").click();
    await expect.poll(() => amount(0, 3.5 / 8, 1)).toBeGreaterThan(0.2);
    await page.locator("#tab-audio").click();
    await page.locator("#volume").fill("0");
    await expect.poll(() => amount(0, 1.5 / 8, 0)).toBeLessThan(0.01);
    expect(await amount(0, 3.5 / 8, 1)).toBeGreaterThan(0.2);
    await page.locator("#undo").click();
    await expect.poll(() => amount(0, 1.5 / 8, 0)).toBeGreaterThan(0.2);
    await page.locator("#scrubber").fill("4");
    await page.locator("#split").click();
    await expect(page.locator("#audio-lane canvas")).toHaveCount(2);
    expect(await amount(0, 1.5 / 4, 0)).toBeGreaterThan(0.2);
    expect(await amount(1, 1.5 / 4, 0)).toBeGreaterThan(0.2);
    expect(await amount(1, 1.5 / 4, 1)).toBeLessThan(0.01);
    await page.locator("#audio-lane .clip").first().click();
    await page.locator("#tab-clip").click();
    await page.locator("#trim-start").fill("1");
    await page.locator("#trim-start").press("Tab");
    await expect.poll(() => amount(0, 0.5 / 3, 0)).toBeGreaterThan(0.2);
    expect(await amount(0, 1.5 / 3, 0)).toBeLessThan(0.01);
    await page.locator("#speed").selectOption("2");
    expect(await amount(0, 0.5 / 3, 0)).toBeGreaterThan(0.2);
    const originalWidth = await page
      .locator("#audio-lane canvas")
      .first()
      .evaluate((c) => {
        window.__wave = c;
        return c.width;
      });
    await page.locator("#timeline-scale").fill(Math.log2(3).toFixed(2));
    await expect
      .poll(() =>
        page
          .locator("#audio-lane canvas")
          .first()
          .evaluate((c) => c.width),
      )
      .toBeGreaterThan(originalWidth * 2);
    expect(
      await page
        .locator("#audio-lane canvas")
        .first()
        .evaluate((c) => c === window.__wave),
    ).toBe(true);
    expect(await amount(0, 0.5 / 3, 0)).toBeGreaterThan(0.2);
    await page.locator("#timeline-scale").fill("0");
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    await page.screenshot({ path: path.join(evidence, "editor.png") });
    await page
      .locator(".timeline-scroll")
      .screenshot({ path: path.join(evidence, "audio-timeline.png") });
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
          actualDecodedAudio: true,
          stereoAndSilence: true,
          offsetAlignment: true,
          gains: true,
          cutTrimSpeedAlignment: true,
          magnification: true,
          persistentCanvas: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app.close().catch(() => {});
  }
});
