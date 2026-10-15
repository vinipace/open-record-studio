import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { motionFixture } from "./motion-fixture.mjs";
import {
  binary,
  defaults,
  exportProject,
  readProject,
  saveProject,
  validateEdits,
} from "../desktop/media.mjs";
import { previewProject } from "../desktop/preview.mjs";
import { compositionLayout } from "../desktop/composition.mjs";
import { connectMcp, call } from "./mcp-client.mjs";

const exec = promisify(execFile);
test("camera flip survives MCP/save and matches camera/composition MP4, GIF and previews without flipping the screen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-flip-"));
  try {
    const fixture = await motionFixture(path.join(root, "project.framestudio"));
    const p = await readProject(fixture.directory);
    const original = await fs.readFile(path.join(p.directory, "screen.mp4"));
    p.edits = {
      segments: [
        { start: 0.2, end: 0.7 },
        { start: 2, end: 2.5 },
      ],
      style: {
        ...defaults,
        speed: 1.5,
        showCursor: false,
        cameraOffset: 0.1,
        cameraSize: 0.5,
        cameraCorner: "top-left",
        cameraRoundness: 0.4,
      },
    };
    const legacy = structuredClone(p.edits);
    delete legacy.style.cameraFlip;
    assert.equal(validateEdits(legacy, p.duration).style.cameraFlip, false);
    assert.throws(
      () =>
        validateEdits({ ...legacy, style: { cameraFlip: "yes" } }, p.duration),
      /camera flip/,
    );
    await saveProject(p);
    const client = await connectMcp();
    try {
      const summary = await call(client.client, "get_project", {
        project_path: p.directory,
      });
      await call(client.client, "update_style", {
        project_path: p.directory,
        expected_revision: summary.revision,
        changes: { cameraFlip: true, cameraMargin: 0.1 },
      });
    } finally {
      await client.client.close();
    }
    p.edits = (await readProject(p.directory)).edits;
    assert.equal(p.edits.style.cameraFlip, true);
    assert.equal(p.edits.style.cameraMargin, 0.1);
    const ffmpeg = await binary("ffmpeg");
    const pixels = async (file) =>
      (
        await exec(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            file,
            "-vf",
            "select='eq(n,5)',scale=640:360",
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout;
    const imagePixels = async (file) =>
      (
        await exec(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            file,
            "-vf",
            "scale=640:360",
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout;
    const layout = compositionLayout(p.edits.style, 640, 360);
    const red = (buffer, x, y) =>
      buffer[(Math.floor(y) * 640 + Math.floor(x)) * 3];
    const check = (buffer, mode, flipped) => {
      const x1 =
        mode === "combined" ? layout.cameraGap + layout.cameraSize * 0.2 : 128;
      const x2 =
        mode === "combined" ? layout.cameraGap + layout.cameraSize * 0.8 : 512;
      const y =
        mode === "combined" ? layout.cameraGap + layout.cameraSize * 0.5 : 180;
      const difference = red(buffer, x1, y) - red(buffer, x2, y);
      assert.ok(
        flipped ? difference > 60 : difference < -60,
        `${mode} orientation difference ${difference}`,
      );
    };
    for (const mode of ["camera", "combined"]) {
      for (const flipped of [false, true]) {
        p.edits.style.cameraFlip = flipped;
        const preview = await previewProject(p, {
          time: 0.3,
          mode,
          height: 360,
        });
        const file = path.join(root, `${mode}-${flipped}.png`);
        await fs.writeFile(file, preview.image);
        check(await imagePixels(file), mode, flipped);
      }
    }
    p.edits.style.cameraFlip = true;
    for (const format of ["mp4", "gif"]) {
      const result = await exportProject(
        p,
        p.edits,
        {
          format,
          mode: "both",
          height: format === "mp4" ? 720 : 360,
          fps: 30,
          audio: false,
        },
        root,
      );
      for (const file of result.files) {
        const mode = path.basename(file, "." + format);
        check(await pixels(file), mode, mode !== "screen");
      }
    }
    assert.deepEqual(
      await fs.readFile(path.join(p.directory, "screen.mp4")),
      original,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
