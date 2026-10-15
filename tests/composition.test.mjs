import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  defaults,
  binary,
  run,
  probe,
  saveProject,
  readProject,
  validateEdits,
  exportProject,
} from "../desktop/media.mjs";
import { inspectImport, importTrack } from "../desktop/import-media.mjs";
import { previewProject } from "../desktop/preview.mjs";
import { connectMcp, call } from "./mcp-client.mjs";
const exec = promisify(execFile);

test(
  "image screen media, every canvas ratio, fit/fill and independent exports survive save/reopen",
  { timeout: 120000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-canvas-"));
    const ffmpeg = await binary("ffmpeg");
    try {
      const original = path.join(root, "input.png");
      await run(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=lime:s=320x180",
        "-frames:v",
        "1",
        original,
      ]);
      const directory = path.join(root, "image.framestudio");
      await fs.mkdir(directory);
      const screen = await importTrack(
        original,
        directory,
        "screen",
        await inspectImport(original, 1.2),
      );
      assert.deepEqual(
        await fs.readFile(original),
        await fs.readFile(path.join(directory, "screen-original.png")),
      );
      assert.equal(screen.sourceKind, "image");
      assert.equal(screen.duration, 1.2);
      let p = {
        kind: "frame-studio",
        version: 1,
        name: "Canvas test",
        directory,
        duration: screen.duration,
        tracks: { screen, camera: { ...screen, sourceKind: undefined } },
        edits: {
          segments: [
            { start: 0.2, end: 0.6 },
            { start: 0.8, end: 1.2 },
          ],
          style: {
            ...defaults,
            showCamera: false,
            background: "#0000ff",
            padding: 0,
          },
        },
      };
      await saveProject(p);
      p = await readProject(directory);
      assert.equal(p.tracks.screen.sourceKind, "image");
      const sizes = {
        "16:9": [640, 360],
        "9:16": [360, 640],
        "1:1": [360, 360],
        "4:5": [360, 450],
        "4:3": [480, 360],
        "3:4": [360, 480],
        source: [640, 360],
      };
      const pixel = async (preview) => {
        const file = path.join(root, "preview.png");
        await fs.writeFile(file, preview.image);
        const { stdout } = await exec(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            file,
            "-vf",
            "crop=2:2:iw/2:ih/10,scale=1:1",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { encoding: "buffer" },
        );
        return [...stdout];
      };
      for (const [ratio, [width, height]] of Object.entries(sizes)) {
        p.edits.style.aspectRatio = ratio;
        const preview = await previewProject(p, { time: 0.5 });
        assert.equal(preview.width, width, ratio);
        assert.equal(preview.height, height, ratio);
        if (ratio === "9:16") {
          assert.ok(
            (await pixel(preview))[2] > 240,
            "fit retains blue letterbox",
          );
          p.edits.style.screenFit = "fill";
          assert.ok(
            (await pixel(await previewProject(p, { time: 0.5 })))[1] > 240,
            "fill covers canvas with image",
          );
          p.edits.style.screenFit = "fit";
        }
      }
      p.edits.style.aspectRatio = "9:16";
      const exported = await exportProject(
        p,
        p.edits,
        { mode: "both", height: 720, fps: 30, audio: false },
        root,
      );
      for (const file of exported.files) {
        const meta = await probe(file);
        assert.equal(meta.width, file.endsWith("combined.mp4") ? 720 : 1280);
        assert.equal(meta.height, file.endsWith("combined.mp4") ? 1280 : 720);
        assert.ok(Math.abs(meta.duration - 0.8) < 0.05);
        await run(ffmpeg, [
          "-v",
          "error",
          "-xerror",
          "-i",
          file,
          "-f",
          "null",
          "-",
        ]);
      }
      p.edits.style.aspectRatio = "1:1";
      const gif = await exportProject(
        p,
        p.edits,
        { format: "gif", mode: "combined", height: 360, fps: 20 },
        root,
      );
      assert.equal((await probe(gif.files[0])).width, 360);
      assert.equal((await probe(gif.files[0])).height, 360);
      await run(ffmpeg, [
        "-v",
        "error",
        "-xerror",
        "-i",
        gif.files[0],
        "-f",
        "null",
        "-",
      ]);
      const rotated = path.join(directory, "rotated.mp4");
      await run(ffmpeg, [
        "-v",
        "error",
        "-display_rotation",
        "90",
        "-i",
        path.join(directory, "screen.mp4"),
        "-c",
        "copy",
        rotated,
      ]);
      const rotatedMeta = await inspectImport(rotated);
      assert.deepEqual([rotatedMeta.width, rotatedMeta.height], [180, 320]);
      p.tracks.screen = { ...rotatedMeta, file: "rotated.mp4", offset: 0 };
      p.edits.style.aspectRatio = "source";
      const portrait = await previewProject(p, { time: 0.5 });
      assert.deepEqual([portrait.width, portrait.height], [360, 640]);
      await assert.rejects(inspectImport(original, 0), /duration/);
      assert.throws(
        () =>
          validateEdits(
            { ...p.edits, style: { ...p.edits.style, aspectRatio: "bogus" } },
            p.duration,
          ),
        /aspect ratio/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "MCP discovers canvas templates, sets ratios atomically and previews portrait media",
  { timeout: 120000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-canvas-mcp-"));
    let connection;
    try {
      await run(await binary("ffmpeg"), [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=green:s=320x180:d=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path.join(root, "screen.mp4"),
      ]);
      const p = {
        kind: "frame-studio",
        version: 1,
        name: "MCP canvas",
        directory: root,
        duration: 1,
        tracks: { screen: { file: "screen.mp4", offset: 0 } },
        edits: { segments: [{ start: 0, end: 1 }], style: { ...defaults } },
      };
      await saveProject(p);
      connection = await connectMcp();
      const args = { project_path: root };
      let current = await call(connection.client, "get_project", args);
      assert.ok(
        current.capabilities.canvas_templates.some((t) => t.id === "tiktok"),
      );
      const result = await call(connection.client, "update_style", {
        ...args,
        expected_revision: current.revision,
        changes: { canvasTemplate: "tiktok", screenFit: "fill" },
      });
      current = await call(connection.client, "get_project", args);
      assert.equal(current.style.aspectRatio, "9:16");
      assert.deepEqual(current.composition, { width: 1080, height: 1920 });
      const preview = await connection.client.callTool({
        name: "get_preview",
        arguments: { ...args, time: 0, height: 360 },
      });
      assert.ok(!preview.isError);
      const png = Buffer.from(
        preview.content.find((c) => c.type === "image").data,
        "base64",
      );
      assert.equal(png.readUInt32BE(16), 360);
      assert.equal(png.readUInt32BE(20), 640);
      await assert.rejects(
        call(connection.client, "update_style", {
          ...args,
          expected_revision: current.revision,
          changes: { canvasTemplate: "tiktok", aspectRatio: "1:1" },
        }),
        /do not match/,
      );
      assert.equal((await readProject(root)).revision, current.revision);
      await call(connection.client, "update_style", {
        ...args,
        expected_revision: current.revision,
        changes: { aspectRatio: "4:5" },
      });
      assert.equal(
        (await readProject(root)).edits.style.canvasTemplate,
        "custom",
      );
    } finally {
      await connection?.client.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
