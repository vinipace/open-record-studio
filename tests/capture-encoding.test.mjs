import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test(
  "hardware capture preserves a static screen's duration, host-clock offset and audio at 4K and 5K",
  {
    skip: process.platform !== "darwin" || process.arch !== "arm64",
    timeout: 60000,
  },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "frame-hardware-capture-"),
    );
    try {
      const helper = path.join(root, "check");
      await exec("xcrun", [
        "swiftc",
        "-O",
        "native/CaptureEncoding.swift",
        "tests/fixtures/CaptureEncodingFixture.swift",
        "-o",
        helper,
      ]);
      await exec(helper, [root], { timeout: 30000 });
      for (const [name, codec, width, height] of [
        ["4k", "h264", 3840, 2160],
        ["5k", "hevc", 5120, 2880],
      ]) {
        const file = path.join(root, name + ".mp4");
        const { stdout } = await exec("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-of",
          "json",
          file,
        ]);
        const streams = JSON.parse(stdout).streams;
        const video = streams.find((s) => s.codec_type === "video");
        assert.equal(video.codec_name, codec);
        assert.equal(video.width, width);
        assert.equal(video.height, height);
        assert.equal(Number(video.start_time), 0);
        assert.ok(Math.abs(Number(video.duration) - 3) < 0.05);
        if (name === "4k") {
          const audio = streams.find((s) => s.codec_type === "audio");
          assert.equal(audio.codec_name, "aac");
          assert.ok(Math.abs(Number(audio.duration) - 1) < 0.05);
        }
        await exec("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
