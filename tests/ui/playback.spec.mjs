import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaults, binary, run, probe } from "../../desktop/media.mjs";

test("HEVC and AAC playback stays continuous through audio startup, seeking, cuts and speed changes", async () => {
  test.setTimeout(90000);
  const root = path.resolve(".cache/playback-ui");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "screen.mp4");
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=720x1280:r=60:d=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=12",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "pools=2:frame-threads=2:log-level=error",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    file,
  ]);
  const meta = await probe(file);
  const project = {
    version: 1,
    kind: "frame-studio",
    name: "Continuous playback",
    duration: meta.duration,
    tracks: { screen: { ...meta, file: "screen.mp4", offset: 0 } },
    edits: {
      segments: [{ start: 0, end: meta.duration }],
      style: { ...defaults, aspectRatio: "source" },
    },
  };
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify(project));
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
    const page = await app.firstWindow();
    await page.bringToFront();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.hide()),
    );
    await expect(page.locator("#project-title")).toHaveText(project.name);
    // Keep startup timing independent of the user's Bluetooth output latency.
    // Route only this isolated test's media elements; leave the OS default alone.
    const audioOutput = await page.evaluate(async () => {
      const output = (await navigator.mediaDevices.enumerateDevices()).find(
        (device) =>
          device.kind === "audiooutput" && /Built-in/i.test(device.label),
      );
      if (!output || !HTMLMediaElement.prototype.setSinkId)
        return "system default";
      const play = HTMLMediaElement.prototype.play;
      const pending = new WeakMap();
      HTMLMediaElement.prototype.play = function (...args) {
        if (this.muted || this.volume === 0 || this.sinkId === output.deviceId)
          return play.apply(this, args);
        if (!pending.has(this)) {
          const promise = this.setSinkId(output.deviceId).then(() =>
            play.apply(this, args),
          );
          pending.set(this, promise);
          promise.finally(() => pending.delete(this)).catch(() => {});
        }
        return pending.get(this);
      };
      return output.label;
    });
    await page.evaluate(() => {
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.id === "preview" && args[0] instanceof HTMLVideoElement)
          window.playbackVideo = args[0];
        return draw.apply(this, args);
      };
    });
    await page.locator("#scrubber").fill("0.1");
    await page.waitForFunction(
      () =>
        window.playbackVideo?.readyState >= 2 && !window.playbackVideo.seeking,
    );
    await page.locator("#back").click();
    await page.waitForFunction(
      () =>
        window.playbackVideo.currentTime < 0.01 &&
        !window.playbackVideo.seeking,
    );
    await page.evaluate(() => {
      window.playbackStats = { seeks: 0, pauses: 0, frames: [], times: [] };
      for (const event of ["seeking", "pause"])
        window.playbackVideo.addEventListener(event, () => {
          window.playbackStats[event === "seeking" ? "seeks" : "pauses"]++;
        });
      const frame = (now, meta) => {
        window.playbackStats.frames.push(now);
        window.playbackStats.times.push(meta.mediaTime);
        window.playbackVideo.requestVideoFrameCallback(frame);
      };
      window.playbackVideo.requestVideoFrameCallback(frame);
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (this instanceof HTMLAudioElement && !window.playbackMicrophone) {
          window.playbackMicrophone = this;
          window.microphoneStats = { seeks: 0, pauses: 0 };
          this.addEventListener(
            "seeking",
            () => window.microphoneStats.seeks++,
          );
          this.addEventListener("pause", () => window.microphoneStats.pauses++);
        }
        return play.apply(this, args);
      };
    });
    const sample = () =>
      page.evaluate(() => ({
        ...window.playbackStats,
        mediaTime: window.playbackVideo.currentTime,
        playhead: Number(document.querySelector("#scrubber").value),
      }));
    await page.locator("#play").click();
    await page.waitForTimeout(5000);
    const continuous = await sample();
    expect(continuous.seeks).toBe(0);
    expect(continuous.pauses).toBe(0);
    expect(continuous.frames.length).toBeGreaterThan(250);
    expect(continuous.mediaTime).toBeGreaterThan(4.5);
    expect(Math.abs(continuous.playhead - continuous.mediaTime)).toBeLessThan(
      0.035,
    );
    const gaps = continuous.frames
      .slice(1)
      .map((t, i) => t - continuous.frames[i])
      .sort((a, b) => a - b);
    expect(gaps[Math.floor(gaps.length * 0.95)]).toBeLessThan(45);
    await page.locator("#play").click();
    // Make a retained cut through the UI, then cross it at a different speed.
    await page.locator("#scrubber").fill("3");
    await page.locator("#split").click();
    await page.locator("#scrubber").fill("5");
    await page.locator("#split").click();
    await page.locator('#screen-lane [data-clip="1"]').click();
    await page.locator("#delete").click();
    await page.locator("#tab-clip").click();
    await page.locator("#speed").selectOption("1.5");
    await page.locator("#scrubber").fill("1.7");
    await page.waitForFunction(
      () =>
        !window.playbackVideo.seeking &&
        Math.abs(window.playbackVideo.currentTime - 2.55) < 0.01,
    );
    await page.evaluate(() => {
      window.playbackStats = { seeks: 0, pauses: 0, frames: [], times: [] };
    });
    await page.locator("#play").click();
    await page.waitForTimeout(2000);
    const cut = await sample();
    expect(cut.seeks).toBe(1);
    expect(cut.pauses).toBeLessThanOrEqual(1);
    // Exclude the deliberate GOP seek from the continuous frame-cadence check.
    const cutGaps = cut.frames
      .slice(1)
      .flatMap((t, i) => (cut.times[i] >= 5 ? [t - cut.frames[i]] : []))
      .sort((a, b) => a - b);
    expect(cut.frames.length).toBeGreaterThan(60);
    expect(cutGaps[Math.floor(cutGaps.length * 0.95)]).toBeLessThan(45);
    expect(cut.playhead).toBeGreaterThan(3);
    expect(Math.abs(cut.mediaTime - (cut.playhead * 1.5 + 2))).toBeLessThan(
      0.06,
    );
    expect(cut.times.some((time) => time >= 5)).toBe(true);
    expect(cut.times.every((time) => time < 3.1 || time >= 5)).toBe(true);
    await page.locator("#play").click();
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    // A recording with silent screen video must follow its microphone clock.
    const micRoot = path.join(root, "microphone.framestudio");
    await fs.mkdir(micRoot);
    await run(await binary("ffmpeg"), [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:v",
      "-c",
      "copy",
      path.join(micRoot, "screen.mp4"),
      "-map",
      "0:a",
      "-c",
      "copy",
      path.join(micRoot, "microphone.m4a"),
    ]);
    await fs.writeFile(
      path.join(micRoot, "project.json"),
      JSON.stringify({
        ...project,
        name: "Microphone playback",
        tracks: {
          screen: { ...project.tracks.screen, audio: false },
          microphone: {
            ...(await probe(path.join(micRoot, "microphone.m4a"))),
            file: "microphone.m4a",
            offset: 0,
          },
        },
      }),
    );
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, micRoot);
    await page.locator("#open").click();
    await expect(page.locator("#project-title")).toHaveText(
      "Microphone playback",
    );
    await page.evaluate(() => {
      window.playbackStats = { seeks: 0, pauses: 0, frames: [], times: [] };
    });
    await page.locator("#play").click();
    await page.waitForTimeout(4000);
    const mic = await page.evaluate(() => ({
      ...window.microphoneStats,
      mediaTime: window.playbackMicrophone.currentTime,
      screenTime: window.playbackVideo.currentTime,
      playhead: Number(document.querySelector("#scrubber").value),
      screenFrames: window.playbackStats.frames.filter(
        (_, i) => window.playbackStats.times[i] > 1,
      ),
    }));
    expect(mic.seeks).toBe(0);
    expect(mic.pauses).toBe(0);
    expect(mic.mediaTime).toBeGreaterThan(3.5);
    expect(Math.abs(mic.playhead - mic.mediaTime)).toBeLessThan(0.035);
    expect(Math.abs(mic.screenTime - mic.mediaTime)).toBeLessThan(0.1);
    const micGaps = mic.screenFrames
      .slice(1)
      .map((t, i) => t - mic.screenFrames[i])
      .sort((a, b) => a - b);
    expect(mic.screenFrames.length).toBeGreaterThan(100);
    expect(micGaps[Math.floor(micGaps.length * 0.95)]).toBeLessThan(45);
    await fs.mkdir("evidence/playback", { recursive: true });
    await fs.writeFile(
      "evidence/playback/checks.json",
      JSON.stringify(
        {
          date: new Date().toISOString(),
          audioOutput,
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
          continuous: {
            seeks: continuous.seeks,
            pauses: continuous.pauses,
            frames: continuous.frames.length,
            p95FrameMs: gaps[Math.floor(gaps.length * 0.95)],
            mediaTime: continuous.mediaTime,
          },
          cut: {
            seeks: cut.seeks,
            pauses: cut.pauses,
            frames: cut.frames.length,
            playhead: cut.playhead,
            mediaTime: cut.mediaTime,
          },
          microphone: mic,
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
