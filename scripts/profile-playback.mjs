import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const directory = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const raw = process.argv.includes("--raw");
const seconds = Number(process.env.FRAME_PROFILE_SECONDS || 12);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "frame-playback-"));
const projectFile = path.join(directory, "project.json");
const original = await fs.readFile(projectFile);
const app = await electron.launch({
  ...(process.env.FRAME_EXECUTABLE
    ? {
        executablePath: process.env.FRAME_EXECUTABLE,
        args: [`--project=${directory}`],
      }
    : { args: [".", `--project=${directory}`] }),
  env: { ...process.env, FRAME_DATA_DIR: profile },
});
try {
  const page = await app.firstWindow();
  await page.bringToFront();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach((window) => window.hide());
  });
  const session = await app.context().newCDPSession(page);
  const players = [];
  session.on("Media.playerPropertiesChanged", (event) => players.push(event));
  await session.send("Media.enable");
  await page.waitForFunction(
    () => !document.querySelector("#scrubber").disabled,
  );
  await page.evaluate(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    window.playbackProfile = {
      seeks: [],
      rates: 0,
      plays: 0,
      pauses: 0,
      events: [],
      frames: [],
      draws: [],
    };
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const start = performance.now();
      const result = draw.apply(this, args);
      if (this.canvas.id === "preview" && args[0] instanceof HTMLVideoElement) {
        window.profileVideo = args[0];
        window.playbackProfile.draws.push(performance.now() - start);
      }
      return result;
    };
    const proto = HTMLMediaElement.prototype;
    for (const key of ["currentTime", "playbackRate"]) {
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      Object.defineProperty(proto, key, {
        ...desc,
        set(value) {
          if (this === window.profileVideo) {
            if (key === "currentTime")
              window.playbackProfile.seeks.push({
                at: performance.now(),
                from: this.currentTime,
                to: value,
              });
            else window.playbackProfile.rates++;
          }
          desc.set.call(this, value);
        },
      });
    }
    for (const key of ["play", "pause"]) {
      const method = proto[key];
      proto[key] = function (...args) {
        if (this === window.profileVideo)
          window.playbackProfile[key === "play" ? "plays" : "pauses"]++;
        return method.apply(this, args);
      };
    }
  });
  await page.locator("#scrubber").fill("0.1");
  await page.waitForFunction(
    () => window.profileVideo?.readyState >= 2 && !window.profileVideo.seeking,
  );
  await page.locator("#back").click();
  await page.waitForFunction(
    () =>
      window.profileVideo.currentTime < 0.01 && !window.profileVideo.seeking,
  );
  await page.evaluate(() => {
    const video = window.profileVideo;
    window.playbackProfile = {
      seeks: [],
      rates: 0,
      plays: 0,
      pauses: 0,
      events: [],
      frames: [],
      draws: [],
    };
    for (const event of [
      "waiting",
      "stalled",
      "seeking",
      "seeked",
      "playing",
      "pause",
      "ratechange",
      "ended",
    ])
      video.addEventListener(event, () =>
        window.playbackProfile.events.push({
          event,
          at: performance.now(),
          time: video.currentTime,
        }),
      );
    const frame = (now, meta) => {
      window.playbackProfile.frames.push({
        at: now,
        mediaTime: meta.mediaTime,
        presented: meta.presentedFrames,
      });
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
    window.profileStart = performance.now();
  });
  if (raw) await page.evaluate(() => window.profileVideo.play());
  else await page.locator("#play").click();
  await page.waitForTimeout(seconds * 1000);
  const report = await page.evaluate(() => ({
    ...window.playbackProfile,
    elapsed: (performance.now() - window.profileStart) / 1000,
    mediaTime: window.profileVideo.currentTime,
    playhead: Number(document.querySelector("#scrubber").value),
    quality: {
      totalVideoFrames:
        window.profileVideo.getVideoPlaybackQuality().totalVideoFrames,
      droppedVideoFrames:
        window.profileVideo.getVideoPlaybackQuality().droppedVideoFrames,
    },
  }));
  const intervals = report.frames
    .slice(1)
    .map((frame, i) => frame.at - report.frames[i].at);
  const p95 = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
  const summary = {
    raw,
    elapsed: report.elapsed,
    mediaTime: report.mediaTime,
    playhead: report.playhead,
    frames: report.frames.length,
    p95FrameMs: p95(intervals),
    maxFrameMs: Math.max(...intervals),
    seeks: report.seeks.length,
    rateAssignments: report.rates,
    plays: report.plays,
    pauses: report.pauses,
    p95DrawMs: p95(report.draws),
    quality: report.quality,
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        asarSha256: process.env.FRAME_EXECUTABLE
          ? createHash("sha256")
              .update(await fs.readFile(path.resolve(process.env.FRAME_EXECUTABLE, "../../Resources/app.asar")))
              .digest("hex")
          : null,
        summary,
        report,
        players,
        projectSha256: createHash("sha256").update(original).digest("hex"),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(summary));
} finally {
  await app
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
    )
    .catch(() => {});
  await app.close().catch(() => {});
  await fs.rm(profile, { recursive: true, force: true });
  if (!(await fs.readFile(projectFile)).equals(original))
    throw new Error("Project changed during read-only profiling");
}
