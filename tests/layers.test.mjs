import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { layersFixture } from "./layers-fixture.mjs";
import {
  binary,
  validateEdits,
  readProject,
  saveProject,
  exportProject,
  probe,
} from "../desktop/media.mjs";
import { previewProject } from "../desktop/preview.mjs";
import { layerRect } from "../desktop/canvas-media.mjs";
import { connectMcp, call } from "./mcp-client.mjs";
const exec = promisify(execFile);
const layer = {
  id: "logo",
  assetId: "image",
  start: 0,
  end: 4,
  mediaStart: 0,
  x: 0.5,
  y: 0.5,
  width: 0.5,
  opacity: 1,
  visible: true,
};
test("canvas layers reject missing media, invalid geometry and timing", () => {
  const assets = {
    image: { sourceKind: "image", duration: 0 },
    video: { sourceKind: "video", duration: 2 },
  };
  const edits = { segments: [{ start: 0, end: 4 }], layers: [layer] };
  assert.equal(validateEdits(edits, 4, assets).layers.length, 1);
  for (const patch of [
    { assetId: "missing" },
    { assetId: "__proto__" },
    { start: NaN },
    { end: 0.01 },
    { width: 3 },
    { x: -1 },
    { opacity: 2 },
    { mediaStart: 1 },
    { assetId: "video" },
  ])
    assert.throws(() =>
      validateEdits({ ...edits, layers: [{ ...layer, ...patch }] }, 4, assets),
    );
  assert.throws(() =>
    validateEdits({ ...edits, layers: [layer, layer] }, 4, assets),
  );
  assert.deepEqual(layerRect(layer, { width: 160, height: 80 }, 640, 360), {
    x: 160,
    y: 100,
    width: 320,
    height: 160,
  });
});
test(
  "layers preserve alpha, order, video timing, cuts and speed in previews, MP4 and GIF",
  { timeout: 120000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-layers-"));
    try {
      const { project: p, directory, image, video } = await layersFixture(root);
      await fs.copyFile(image, path.join(directory, "logo.png"));
      await fs.copyFile(video, path.join(directory, "video.mp4"));
      p.assets = {
        image: { file: "logo.png", name: "Logo", sourceKind: "image" },
        video: { file: "video.mp4", name: "Video", sourceKind: "video" },
      };
      p.edits.layers = [
        { ...layer, opacity: 0.5 },
        {
          ...layer,
          id: "video-layer",
          assetId: "video",
          start: 1,
          end: 3,
          x: 0.65,
          width: 0.2,
        },
      ];
      p.edits.segments = [
        { start: 0.5, end: 1.5 },
        { start: 2.5, end: 3.5 },
      ];
      p.edits.style.speed = 2;
      await saveProject(p);
      const reopened = await readProject(directory);
      const connection = await connectMcp();
      try {
        const args = { project_path: directory };
        const summary = await call(connection.client, "get_project", args);
        assert.equal(summary.layers.length, 2);
        assert.equal(Object.keys(summary.assets).length, 2);
        await call(connection.client, "update_style", {
          ...args,
          expected_revision: summary.revision,
          changes: { background: "#112233" },
        });
        assert.deepEqual(
          (await readProject(directory)).edits.layers,
          reopened.edits.layers,
        );
        const result = await connection.client.callTool({
          name: "get_preview",
          arguments: { ...args, time: 0.4, height: 360 },
        });
        assert.ok(!result.isError);
        assert.ok(result.content.some((c) => c.type === "image"));
      } finally {
        await connection.client.close();
      }

      assert.equal(reopened.assets.image.duration, 0);
      assert.equal(reopened.edits.layers.length, 2);
      const ffmpeg = await binary("ffmpeg");
      const pixel = async (file, t, x, y) => {
        const { stdout } = await exec(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            file,
            "-ss",
            String(t),
            "-frames:v",
            "1",
            "-vf",
            "scale=640:360",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { encoding: "buffer", maxBuffer: 1024 * 1024 },
        );
        const offset = (Math.floor(y * 360) * 640 + Math.floor(x * 640)) * 3;
        return [...stdout.subarray(offset, offset + 3)];
      };
      const check = (rgb, expected) => {
        assert.equal(rgb.length, 3);
        expected.forEach((v, i) =>
          assert.ok(Math.abs(v - rgb[i]) < 16, `${rgb} != ${expected}`),
        );
      };
      for (const time of [0.1, 0.4, 0.6, 0.9]) {
        const preview = await previewProject(reopened, {
          time,
          height: 360,
          fps: 30,
        });
        const file = path.join(root, `preview-${time}.png`);
        await fs.writeFile(file, preview.image);
        check(await pixel(file, 0, 0.3, 0.5), [0, 255, 0]); // transparent logo edge
        check(await pixel(file, 0, 0.5, 0.5), [128, 128, 0]); // opacity
        check(
          await pixel(file, 0, 0.65, 0.5),
          time > 0.25 && time < 0.75 ? [0, 0, 255] : [0, 255, 0],
        );
      }
      for (const format of ["mp4", "gif"]) {
        const result = await exportProject(
          reopened,
          reopened.edits,
          {
            format,
            mode: "both",
            height: format === "mp4" ? 720 : 360,
            fps: 30,
            audio: true,
          },
          root,
        );
        const combined = path.join(result.directory, `combined.${format}`);
        assert.ok(Math.abs((await probe(combined)).duration - 1) < 0.06);
        check(await pixel(combined, 0.4, 0.65, 0.5), [0, 0, 255]);
        check(await pixel(combined, 0.9, 0.65, 0.5), [0, 255, 0]);
        check(await pixel(combined, 0.4, 0.5, 0.5), [128, 128, 0]);
        check(
          await pixel(
            path.join(result.directory, `screen.${format}`),
            0.4,
            0.65,
            0.5,
          ),
          [0, 255, 0],
        );
      }
      reopened.edits.layers[1].visible = false;
      const hidden = await previewProject(reopened, { time: 0.4 });
      await fs.writeFile(path.join(root, "hidden.png"), hidden.image);
      check(
        await pixel(path.join(root, "hidden.png"), 0, 0.65, 0.5),
        [0, 255, 0],
      );
      reopened.edits.layers.reverse();
      reopened.edits.layers[0].visible = true;
      reopened.edits.layers[0].x = 0.5;
      const reordered = await previewProject(reopened, { time: 0.4 });
      await fs.writeFile(path.join(root, "reordered.png"), reordered.image);
      check(
        await pixel(path.join(root, "reordered.png"), 0, 0.5, 0.5),
        [128, 0, 128],
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
test("project canvas assets cannot escape the project through symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-layer-path-"));
  try {
    const { project, directory, image } = await layersFixture(root);
    await fs.symlink(image, path.join(directory, "external.png"));
    project.assets = { logo: { file: "external.png", sourceKind: "image" } };
    await saveProject(project);
    await assert.rejects(readProject(directory), /inside its project/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
