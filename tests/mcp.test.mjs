import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { motionFixture } from "./motion-fixture.mjs";
import { connectMcp, call } from "./mcp-client.mjs";
import { binary, probe, readProject, saveProject } from "../desktop/media.mjs";

const exec = promisify(execFile);
let root, connection, client, projectPath, mediaHash;
const hash = (data) => createHash("sha256").update(data).digest("hex");
const args = () => ({ project_path: projectPath });
const get = () => call(client, "get_project", args());
const report = {
  tools: [],
  previewChecks: [],
  render: null,
  conflictChecks: false,
  cancellation: false,
};
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-mcp-test-"));
  projectPath = path.join(root, "Motion project.framestudio");
  await motionFixture(projectPath);
  mediaHash = hash(await fs.readFile(path.join(projectPath, "screen.mp4")));
  connection = await connectMcp();
  client = connection.client;
});
after(async () => {
  await client?.close();
  await fs.mkdir("evidence/mcp", { recursive: true });
  await fs.writeFile(
    "evidence/mcp/checks.json",
    JSON.stringify({ ...report, date: new Date().toISOString() }, null, 2),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("MCP stdio discovery works with legacy and modern clients", async () => {
  const tools = (await client.listTools()).tools;
  report.tools = tools.map((t) => t.name);
  assert.equal(tools.length, 15);
  assert(
    tools.find((t) => t.name === "update_style").inputSchema.properties.changes,
  );
  assert(
    tools.find((t) => t.name === "apply_edits").inputSchema.properties
      .operations,
  );
  assert(tools.find((t) => t.name === "get_preview").annotations.readOnlyHint);
  const modern = await connectMcp("auto");
  try {
    assert.equal((await modern.client.listTools()).tools.length, 15);
  } finally {
    await modern.client.close();
  }
  const p = await get();
  assert.equal(p.cuts.length, 2);
  assert.equal(p.editable_cursor, true);
  assert.equal(p.output_duration, 3.5 / 1.5);
  assert.deepEqual(p.timeline[1], {
    cut_index: 1,
    source_start: 2,
    source_end: 4,
    output_start: 1,
    output_end: p.output_duration,
  });
  assert(p.capabilities.editable_style_fields.includes("cursorSmoothing"));
  assert(p.capabilities.editable_style_fields.includes("cameraRoundness"));
  assert.equal(p.capabilities.export_formats.gif.height, 480);
  assert.deepEqual(p.capabilities.zoom_modes, ["follow", "fixed"]);
  assert.equal(p.capabilities.default_zoom_mode, "follow");
  assert(!JSON.stringify(p).includes('"samples"'));
  assert.equal(connection.stderr(), "");
});

test("MCP cut and zoom CRUD persists, validates, and rejects stale/concurrent writes", async () => {
  let p = await get();
  const originalEdits = (await readProject(projectPath)).edits;
  const edit = async (name, changes) => {
    p = await call(client, name, {
      ...args(),
      expected_revision: p.revision,
      ...changes,
    });
    return p;
  };
  await edit("add_cut", { start: 1.5, end: 2 });
  assert.equal(p.cuts.length, 3);
  await edit("edit_cut", { cut_index: 1, start: 1.6, end: 1.9 });
  assert.deepEqual(p.cuts[1], { index: 1, start: 1.6, end: 1.9 });
  await edit("remove_cut", { cut_index: 1 });
  await edit("split_cut", { cut_index: 1, source_time: 3 });
  assert.equal(p.cuts.length, 3);
  await edit("remove_zoom", { zoom_id: "z1" });
  await edit("add_zoom", {
    start: 0.1,
    end: 1.3,
    zoom: 2,
    focusX: 0.2,
    focusY: 0.7,
    ease: 0.3,
  });
  const id = p.zooms[0].id;
  assert.equal(p.zooms[0].mode, "follow");
  await edit("edit_zoom", {
    zoom_id: id,
    changes: { mode: "fixed", zoom: 2.5, focusX: 0.8 },
  });
  assert.equal(p.zooms[0].mode, "fixed");
  assert.equal(p.zooms[0].zoom, 2.5);
  assert.equal(p.zooms[0].id, id);
  const disk = await readProject(projectPath);
  assert.equal(disk.edits.zooms[0].focusX, 0.8);
  const beforeBytes = await fs.readFile(path.join(projectPath, "project.json"));
  await assert.rejects(
    () => edit("add_cut", { start: 0, end: 4 }),
    /overlap|ordered/i,
  );
  await assert.rejects(
    () => edit("edit_zoom", { zoom_id: id, changes: { start: 3, end: 2 } }),
    /zoom/i,
  );
  await assert.rejects(() => edit("remove_cut", { cut_index: 90 }), /index/i);
  assert.deepEqual(
    await fs.readFile(path.join(projectPath, "project.json")),
    beforeBytes,
  );
  const oldRevision = p.revision;
  await edit("remove_zoom", { zoom_id: id });
  await assert.rejects(
    () =>
      call(client, "remove_cut", {
        ...args(),
        expected_revision: oldRevision,
        cut_index: 0,
      }),
    /changed on disk/,
  );
  // Race two independent stdio processes, not just two requests in one server.
  const other = await connectMcp();
  try {
    const input = {
      ...args(),
      expected_revision: p.revision,
      cut_index: 0,
      start: 0.1,
      end: 1.4,
    };
    const results = await Promise.allSettled([
      call(client, "edit_cut", input),
      call(other.client, "edit_cut", input),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  } finally {
    await other.client.close();
  }
  // The desktop's shared save helper also refuses its old revision.
  disk.edits.style.padding = 0.1;
  await assert.rejects(() => saveProject(disk), /changed on disk/);
  const restore = await readProject(projectPath);
  restore.edits = originalEdits;
  await saveProject(restore);
  assert.equal(
    hash(await fs.readFile(path.join(projectPath, "screen.mp4"))),
    mediaHash,
  );
  report.conflictChecks = true;
});

test("MCP batch edits support dry runs, rollback, sequential indices and cross-process conflicts", async () => {
  const project_path = path.join(root, "batch.framestudio");
  await motionFixture(project_path);
  const file = path.join(project_path, "project.json");
  let p = await call(client, "get_project", { project_path });
  const original = await fs.readFile(file);
  const operations = [
    { operation: "split_cut", cut_index: 0, source_time: 0.5 },
    { operation: "split_cut", cut_index: 1, source_time: 1 },
    { operation: "remove_cut", cut_index: 1 },
    { operation: "edit_zoom", zoom_id: "z1", changes: { zoom: 1.8 } },
    { operation: "update_style", changes: { speed: 2, cameraRoundness: 0.4 } },
    {
      operation: "add_zoom",
      start: 3.6,
      end: 3.9,
      zoom: 2,
      focusX: 0.5,
      focusY: 0.5,
      ease: 0.2,
    },
  ];
  const request = { project_path, expected_revision: p.revision, operations };
  const dry = await call(client, "apply_edits", { ...request, dry_run: true });
  assert.equal(dry.saved, false);
  assert.equal(dry.base_revision, p.revision);
  assert.equal(dry.project.revision, p.revision);
  assert.equal(dry.project.output_duration, 1.5);
  assert.equal(dry.project.cuts.length, 3);
  assert.equal(dry.operation_results[5].zoom_id, dry.project.zooms[1].id);
  assert.deepEqual(await fs.readFile(file), original);
  const failed = await client.callTool({
    name: "apply_edits",
    arguments: {
      ...request,
      operations: [
        ...operations.slice(0, 2),
        { operation: "remove_cut", cut_index: 99 },
      ],
    },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, "INVALID_EDIT");
  assert.equal(failed.structuredContent.error.operation_index, 2);
  assert.deepEqual(await fs.readFile(file), original);
  const saved = await call(client, "apply_edits", request);
  assert.equal(saved.saved, true);
  assert.equal(saved.project.revision, hash(await fs.readFile(file)));
  assert.notEqual(saved.project.revision, p.revision);
  assert.deepEqual(saved.project.cuts, dry.project.cuts);
  assert.equal(saved.project.style.cameraShape, "square");
  assert.equal(saved.project.style.cameraRoundness, 0.4);
  assert.equal(saved.operation_results[5].zoom_id, saved.project.zooms[1].id);
  const stale = await client.callTool({
    name: "apply_edits",
    arguments: request,
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, "REVISION_CONFLICT");
  assert.match(stale.structuredContent.error.recovery, /get_project/);
  p = saved.project;
  const other = await connectMcp();
  try {
    const responses = await Promise.all([
      client.callTool({
        name: "apply_edits",
        arguments: {
          project_path,
          expected_revision: p.revision,
          operations: [
            {
              operation: "update_style",
              changes: { padding: 0.1, cursorSize: 2 },
            },
          ],
        },
      }),
      other.client.callTool({
        name: "update_style",
        arguments: {
          project_path,
          expected_revision: p.revision,
          changes: { padding: 0.15, cursorSize: 3 },
        },
      }),
    ]);
    assert.equal(responses.filter((r) => !r.isError).length, 1);
    assert(
      ["PROJECT_BUSY", "REVISION_CONFLICT"].includes(
        responses.find((r) => r.isError).structuredContent.error.code,
      ),
    );
    const final = await call(client, "get_project", { project_path });
    assert(
      ["0.1:2", "0.15:3"].includes(
        `${final.style.padding}:${final.style.cursorSize}`,
      ),
    );
    assert.deepEqual(final.cuts, p.cuts);
  } finally {
    await other.client.close();
  }
  report.batchEdits = {
    dryRunUnchanged: true,
    rollback: true,
    sequentialIndices: true,
    concurrentWrites: true,
  };
});

test("MCP style controls persist, affect previews and renders, and reject unavailable controls", async () => {
  const project_path = path.join(root, "style.framestudio");
  await motionFixture(project_path);
  let p = await call(client, "get_project", { project_path });
  const edit = async (changes) => {
    p = await call(client, "update_style", {
      project_path,
      expected_revision: p.revision,
      changes,
    });
  };
  const preview = async (mode) => {
    const response = await client.callTool({
      name: "get_preview",
      arguments: {
        project_path,
        expected_revision: p.revision,
        time: 0.5,
        mode,
        height: 720,
        fps: 30,
      },
    });
    assert(!response.isError, JSON.stringify(response.content));
    const image = Buffer.from(
      response.content.find((c) => c.type === "image").data,
      "base64",
    );
    const file = path.join(root, "styled-preview.png");
    await fs.writeFile(file, image);
    return {
      data: await pixels(file),
      file,
      image,
      meta: response.structuredContent,
    };
  };
  const cursorPixels = (data) => {
    let count = 0;
    for (let i = 0; i < data.length; i += 3)
      if (Math.min(data[i], data[i + 1], data[i + 2]) > 230) count++;
    return count;
  };
  const originalCursor = cursorPixels((await preview("screen")).data);
  assert(originalCursor > 100);
  await edit({ cursorSize: 2, cursorSmoothing: 0.12, cursorClicks: false });
  const largerCursor = cursorPixels((await preview("screen")).data);
  assert(largerCursor > originalCursor * 2);
  await edit({ cameraShape: "square" });
  assert.equal(p.style.cameraRoundness, 0);
  await edit({
    background: "#204060",
    padding: 0.1,
    cameraSize: 0.3,
    cameraCorner: "bottom-left",
    cameraRoundness: 0.5,
    showCursor: false,
    cameraOffset: 0.1,
    speed: 2,
    volume: 0.3,
    microphoneVolume: 0.4,
  });
  assert.equal(p.style.cameraShape, "square");
  assert.equal(p.style.cursorSize, 2);
  assert.equal(p.output_duration, 1.75);
  assert.equal(cursorPixels((await preview("screen")).data), 0);
  p = await call(client, "edit_zoom", {
    project_path,
    expected_revision: p.revision,
    zoom_id: "z1",
    changes: { mode: "follow" },
  });
  assert.equal(p.zooms[0].mode, "follow");
  const image = await preview("combined");
  const job = await call(client, "render", {
    project_path,
    expected_revision: p.revision,
    output_directory: path.join(root, "styled-exports"),
    height: 720,
    fps: 30,
    audio: false,
  });
  const rendered = await waitForJob(job.job_id);
  assert.equal(rendered.status, "succeeded", rendered.error);
  const renderedPixels = await pixels(rendered.files[0], image.meta.frame);
  assert.equal(renderedPixels.length, image.data.length);
  let delta = 0;
  for (let i = 0; i < image.data.length; i++)
    delta += Math.abs(image.data[i] - renderedPixels[i]);
  const meanError = delta / image.data.length;
  assert(meanError < 4, `Styled preview/export mean error: ${meanError}`);
  const disk = await readProject(project_path);
  assert.deepEqual(disk.edits.style, p.style);
  assert.equal(
    hash(await fs.readFile(path.join(project_path, "screen.mp4"))),
    mediaHash,
  );
  for (const changes of [
    {},
    { cameraRoundness: 1.1 },
    { cursorSize: 99 },
    { showCursor: "false" },
    { unknown: true },
  ])
    await assert.rejects(() => edit(changes));
  assert.equal(
    (await call(client, "get_project", { project_path })).revision,
    p.revision,
  );
  delete disk.cursor;
  delete disk.tracks.camera;
  await saveProject(disk);
  p = await call(client, "get_project", { project_path });
  assert(!p.capabilities.editable_style_fields.includes("showCursor"));
  assert(!p.capabilities.editable_style_fields.includes("cameraRoundness"));
  assert.deepEqual(p.capabilities.render_modes, ["combined"]);
  assert.deepEqual(p.capabilities.preview_modes, ["combined", "screen"]);
  assert.deepEqual(p.capabilities.zoom_modes, ["fixed"]);
  assert.equal(p.capabilities.default_zoom_mode, "fixed");
  const followFailure = await client.callTool({
    name: "edit_zoom",
    arguments: {
      project_path,
      expected_revision: p.revision,
      zoom_id: "z1",
      changes: { mode: "follow" },
    },
  });
  assert.equal(followFailure.isError, true);
  assert.equal(
    followFailure.structuredContent.error.code,
    "UNSUPPORTED_CONTROL",
  );
  for (const changes of [{ showCursor: false }, { cameraRoundness: 0.2 }]) {
    const failure = await client.callTool({
      name: "update_style",
      arguments: {
        project_path,
        expected_revision: p.revision,
        changes,
      },
    });
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent.error.code, "UNSUPPORTED_CONTROL");
  }
  assert.equal(
    (await call(client, "get_project", { project_path })).revision,
    p.revision,
  );
  await fs.mkdir("evidence/mcp", { recursive: true });
  await fs.writeFile("evidence/mcp/styled-preview.png", image.image);
  await fs.copyFile(rendered.files[0], "evidence/mcp/styled-render.mp4");
  report.styleEdits = {
    originalCursorPixels: originalCursor,
    enlargedCursorPixels: largerCursor,
    hiddenCursorPixels: 0,
    previewRenderMeanError: meanError,
    unsupportedControlsRejected: true,
  };
});

async function waitForJob(
  id,
  predicate = (j) => ["succeeded", "failed", "cancelled"].includes(j.status),
) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const job = await call(client, "render_status", { job_id: id });
    if (predicate(job)) return job;
    await delay(40);
  }
  throw new Error("Render timed out");
}

test("MCP renders enhanced microphone audio using the bundled RNNoise model", async () => {
  const directory = path.join(root, "enhanced-audio.framestudio");
  await motionFixture(directory);
  const project = await readProject(directory);
  const audio = path.join(directory, "microphone.wav");
  await exec(await binary("ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:a",
    "pcm_s16le",
    audio,
  ]);
  project.tracks.microphone = {
    ...(await probe(audio)),
    file: "microphone.wav",
    offset: 0,
  };
  await saveProject(project);
  const before = await call(client, "get_project", { project_path: directory });
  const updated = await call(client, "update_style", {
    project_path: directory,
    expected_revision: before.revision,
    changes: { enhanceAudio: true },
  });
  const job = await call(client, "render", {
    project_path: directory,
    expected_revision: updated.revision,
    output_directory: path.join(root, "enhanced-output"),
    mode: "separate",
    height: 720,
    fps: 30,
    audio: true,
  });
  const result = await waitForJob(job.job_id);
  assert.equal(result.status, "succeeded", result.error);
  const camera = await probe(
    result.files.find((file) => file.endsWith("camera.mp4")),
  );
  const screen = await probe(
    result.files.find((file) => file.endsWith("screen.mp4")),
  );
  assert.equal(camera.audio, true);
  assert.equal(screen.audio, false);
  assert(Math.abs(camera.duration - updated.output_duration) < 0.05);
  report.enhancedAudio = { rendered: true, microphoneOnCameraOnly: true };
});
async function pixels(file, frame) {
  const { stdout } = await exec(
    await binary("ffmpeg"),
    [
      "-v",
      "error",
      "-i",
      file,
      ...(frame === undefined ? [] : ["-vf", `select=eq(n\\,${frame})`]),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

test(
  "MCP renders combined/separate videos and inline previews match decoded output frames",
  { timeout: 120000 },
  async () => {
    const p = await get();
    const job = await call(client, "render", {
      ...args(),
      expected_revision: p.revision,
      output_directory: path.join(root, "exports"),
      mode: "both",
      height: 720,
      fps: 60,
      audio: false,
    });
    assert.equal(job.status, "running");
    const result = await waitForJob(job.job_id);
    assert.equal(result.status, "succeeded", result.error);
    assert.equal(result.files.length, 3);
    for (const file of result.files)
      assert(Math.abs((await probe(file)).duration - p.output_duration) < 0.05);
    report.render = {
      status: result.status,
      outputs: result.files.map((f) => path.basename(f)),
      duration: p.output_duration,
    };
    // First frame, cut boundary (output 1 maps to source 2), eased zoom/cursor,
    // and the last output frame. Include all three composition modes.
    for (const [mode, time] of [
      ["screen", 0],
      ["screen", 1],
      ["combined", 1.25],
      ["camera", 1.25],
      ["screen", p.output_duration - 1e-12],
    ]) {
      const response = await client.callTool(
        {
          name: "get_preview",
          arguments: {
            ...args(),
            expected_revision: p.revision,
            mode,
            time,
            height: 720,
            fps: 60,
          },
        },
        { timeout: 120000 },
      );
      assert(!response.isError, JSON.stringify(response.content));
      const image = response.content.find((c) => c.type === "image");
      assert.equal(image.mimeType, "image/png");
      const bytes = Buffer.from(image.data, "base64");
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      const meta = response.structuredContent;
      assert.equal(meta.revision, p.revision);
      assert.equal(meta.height, 720);
      if (time === 1) assert.equal(meta.sourceTime, 2);
      const imagePath = path.join(root, "preview.png");
      await fs.writeFile(imagePath, bytes);
      const actual = await pixels(imagePath);
      const expected = await pixels(
        result.files.find((f) => path.basename(f) === `${mode}.mp4`),
        meta.frame,
      );
      assert.equal(actual.length, expected.length);
      let sum = 0;
      for (let i = 0; i < actual.length; i++)
        sum += Math.abs(actual[i] - expected[i]);
      const meanError = sum / actual.length;
      assert(
        meanError < 4,
        `${mode} at ${time}: mean channel error ${meanError}`,
      );
      report.previewChecks.push({
        mode,
        time: meta.time,
        sourceTime: meta.sourceTime,
        frame: meta.frame,
        meanError,
      });
      await fs.mkdir("evidence/mcp", { recursive: true });
      await fs.writeFile(`evidence/mcp/${mode}-${meta.frame}.png`, bytes);
    }
    await assert.rejects(
      () => call(client, "get_preview", { ...args(), time: p.output_duration }),
      /Preview time/,
    );
  },
);

test("MCP renders GIF with default settings and preserves animated zoom/cursor pixels", async () => {
  const p = await get();
  const job = await call(client, "render", {
    ...args(),
    expected_revision: p.revision,
    output_directory: path.join(root, "gif-output"),
    format: "gif",
    mode: "both",
    audio: true,
  });
  const result = await waitForJob(job.job_id);
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.options.height, 480);
  assert.equal(result.options.fps, 20);
  assert.equal(result.options.audio, false);
  assert.equal(result.files.length, 3);
  for (const file of result.files) {
    assert.ok(file.endsWith(".gif"));
    const meta = await probe(file);
    assert.equal(meta.height, 480);
    assert.equal(meta.audio, false);
    assert.ok(Math.abs(meta.duration - p.output_duration) < 0.1);
  }
  // Compare against the lossless preview at the same edited timestamp. The
  // native MP4 encoder rasterizes the cursor differently; its output is checked
  // separately above, and is not a pixel reference for GIF palette conversion.
  const project = await readProject(projectPath);
  const { previewProject } = await import("../desktop/preview.mjs");
  const reference = await previewProject(project, {
    mode: "screen",
    time: 1,
    height: 720,
    fps: 60,
  });
  const actualFile = result.files.find((f) => f.endsWith("screen.gif"));
  const referenceFile = path.join(root, "gif-preview.png");
  await fs.writeFile(referenceFile, reference.image);
  const expectedFile = path.join(root, "gif-reference.png");
  await exec(await binary("ffmpeg"), [
    "-v",
    "error",
    "-i",
    referenceFile,
    "-frames:v",
    "1",
    "-vf",
    "scale=-2:480",
    "-update",
    "1",
    expectedFile,
  ]);
  const actual = await pixels(actualFile, 20),
    expected = await pixels(expectedFile);
  assert.equal(actual.length, expected.length);
  let sum = 0;
  for (let i = 0; i < actual.length; i++)
    sum += Math.abs(actual[i] - expected[i]);
  // A GIF's 256-color palette uses dithering: single pixels intentionally
  // differ. Compare local color averages, plus the cursor's actual position.
  const { width, height } = await probe(actualFile);
  const blockErrors = [];
  for (let y = 0; y < height; y += 16)
    for (let x = 0; x < width; x += 16)
      for (let channel = 0; channel < 3; channel++) {
        let delta = 0,
          count = 0;
        for (let dy = y; dy < Math.min(y + 16, height); dy++)
          for (let dx = x; dx < Math.min(x + 16, width); dx++) {
            const i = (dy * width + dx) * 3 + channel;
            delta += actual[i] - expected[i];
            count++;
          }
        blockErrors.push(Math.abs(delta) / count);
      }
  const blockError =
    blockErrors.reduce((a, b) => a + b, 0) / blockErrors.length;
  assert.ok(blockError < 3, `GIF local color error: ${blockError}`);
  const cursorCenter = (data) => {
    let x = 0,
      y = 0,
      count = 0;
    for (let i = 0; i < data.length; i += 3)
      if (Math.min(data[i], data[i + 1], data[i + 2]) > 225) {
        x += (i / 3) % width;
        y += Math.floor(i / 3 / width);
        count++;
      }
    assert.ok(count > 100, "The cursor must remain visible in GIF output");
    return [x / count, y / count];
  };
  const a = cursorCenter(actual),
    b = cursorCenter(expected);
  const cursorError = Math.hypot(a[0] - b[0], a[1] - b[1]);
  assert.ok(cursorError < 2, `GIF cursor position error: ${cursorError}`);
  report.gif = {
    status: result.status,
    height: 480,
    fps: 20,
    meanFrameError: sum / actual.length,
    meanLocalColorError: blockError,
    cursorPositionError: cursorError,
  };
});

test(
  "MCP render cancellation cleans partial files and allows retry",
  { timeout: 120000 },
  async () => {
    const p = await get(),
      output = path.join(root, "cancelled");
    const job = await call(client, "render", {
      ...args(),
      expected_revision: p.revision,
      output_directory: output,
      height: 2160,
      fps: 60,
    });
    await waitForJob(
      job.job_id,
      (j) => j.track === "combined" || j.status === "failed",
    );
    await assert.rejects(
      () =>
        call(client, "render", {
          ...args(),
          expected_revision: p.revision,
          output_directory: output,
        }),
      /already running/,
    );
    const cancelled = await call(client, "cancel_render", {
      job_id: job.job_id,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(await fs.readdir(output), []);
    assert.equal(
      (await call(client, "cancel_render", { job_id: job.job_id })).status,
      "cancelled",
    );
    const retry = await call(client, "render", {
      ...args(),
      expected_revision: p.revision,
      output_directory: output,
      height: 720,
      fps: 30,
      audio: false,
    });
    assert.equal((await waitForJob(retry.job_id)).status, "succeeded");
    report.cancellation = true;
  },
);

test(
  "MCP disconnect cancels active render and removes temporary output",
  { timeout: 30000 },
  async () => {
    const other = await connectMcp();
    const p = await get(),
      output = path.join(root, "disconnect");
    const job = await call(other.client, "render", {
      ...args(),
      expected_revision: p.revision,
      output_directory: output,
      height: 2160,
    });
    assert.equal(job.status, "running");
    await other.client.close();
    const end = Date.now() + 5000;
    while ((await fs.readdir(output)).length && Date.now() < end)
      await delay(40);
    assert.deepEqual(await fs.readdir(output), []);
  },
);
