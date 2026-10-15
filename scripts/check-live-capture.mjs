// Opt-in only: creates a generated test window, waits for its Run button,
// captures that exact window for five seconds, then verifies via the MCP.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startCapture } from "../desktop/native-capture.mjs";
import {
  binary,
  defaults,
  outputDuration,
  probe,
  readProject,
  run,
  saveProject,
  validateCursor,
} from "../desktop/media.mjs";
import { connectMcp, call } from "../tests/mcp-client.mjs";

const root = path.resolve(
  "evidence/live",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await fs.mkdir(root, { recursive: true });
const targetApp = path.join(root, "Open Record Studio Capture Test.app");
await fs.mkdir(path.join(targetApp, "Contents/MacOS"), { recursive: true });
await fs.writeFile(
  path.join(targetApp, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.framestudio.capturefixture</string><key>CFBundleName</key><string>Open Record Studio Capture Test</string><key>CFBundleExecutable</key><string>capture-window</string></dict></plist>`,
);
execFileSync("/usr/bin/xcrun", [
  "swiftc",
  "tests/fixtures/CaptureWindow.swift",
  "-o",
  path.join(targetApp, "Contents/MacOS/capture-window"),
]);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", targetApp]);
const fixture = spawn(
  path.join(targetApp, "Contents/MacOS/capture-window"),
  [],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const events = [];
let pending = "",
  capture,
  client;
let readyResolve, runResolve;
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});
const clicked = new Promise((resolve) => {
  runResolve = resolve;
});
fixture.stdout.on("data", (data) => {
  pending += data;
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) {
    const event = JSON.parse(line);
    events.push(event);
    if (event.event === "ready") readyResolve(event);
    if (event.event === "run") runResolve(event);
    if (event.event === "pointer") console.log(JSON.stringify(event));
  }
});
fixture.stderr.on("data", (data) => process.stderr.write(data));
const helper = path.resolve(
  "release/Open Record Studio.app/Contents/Resources/frame-capture",
);
const report = {
  date: new Date().toISOString(),
  root,
  captureSource: "dedicated generated native window",
  camera: false,
  microphone: false,
  systemAudio: false,
  captureSecondsRequested: 5,
  captureHelperSha256: createHash("sha256")
    .update(await fs.readFile(helper))
    .digest("hex"),
  appAsarSha256: createHash("sha256")
    .update(
      await fs.readFile("release/Open Record Studio.app/Contents/Resources/app.asar"),
    )
    .digest("hex"),
};
try {
  const source = await ready;
  console.log(
    JSON.stringify({ event: "waiting_for_click", root, targetApp, source }),
  );
  await clicked;
  const directory = path.join(root, "Live native capture.framestudio");
  await fs.mkdir(directory);
  capture = startCapture(helper, {
    source: `window:${source.windowID}`,
    output: path.join(directory, "screen.mp4"),
    audio: false,
  });
  const started = await capture.ready;
  await fs.writeFile(
    path.join(root, "capturing.json"),
    JSON.stringify(started),
  );
  console.log(JSON.stringify({ event: "recording", started }));
  await delay(5000);
  await capture.stop();
  const screen = await probe(path.join(directory, "screen.mp4"));
  if (
    !screen.video ||
    screen.audio ||
    screen.duration < 4.5 ||
    screen.duration > 7
  )
    throw new Error("Captured media failed duration/video/silent-track checks");
  const cursor = JSON.parse(
    await fs.readFile(path.join(directory, "cursor.json"), "utf8"),
  );
  cursor.samples = cursor.samples.filter((p) => p.t <= screen.duration);
  const project = {
    version: 1,
    kind: "frame-studio",
    name: "Live native capture",
    createdAt: new Date().toISOString(),
    duration: screen.duration,
    directory,
    tracks: { screen: { ...screen, file: "screen.mp4", offset: 0 } },
    cursor: validateCursor(cursor, screen.duration),
    edits: {
      segments: [{ start: 0, end: screen.duration }],
      style: { ...defaults },
    },
  };
  await saveProject(project);
  const uniquePoints = new Set(
    cursor.samples
      .filter((p) => p.visible)
      .map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`),
  ).size;
  Object.assign(report, {
    screenCaptureKit: true,
    screen,
    cursorSamples: cursor.samples.length,
    cursorVisibleSamples: cursor.samples.filter((p) => p.visible).length,
    cursorPressedSamples: cursor.samples.filter((p) => p.pressed && p.visible)
      .length,
    cursorUniquePoints: uniquePoints,
    targetEvents: events,
    projectDirectory: directory,
  });
  console.log(
    JSON.stringify({
      event: "captured",
      duration: screen.duration,
      cursorSamples: cursor.samples.length,
      uniquePoints,
    }),
  );
  ({ client } = await connectMcp());
  const args = { project_path: directory };
  let p = await call(client, "get_project", args);
  for (const [tool, fields] of [
    ["split_cut", { cut_index: 0, source_time: 1 }],
    ["split_cut", { cut_index: 1, source_time: 1.5 }],
    ["remove_cut", { cut_index: 1 }],
    [
      "add_zoom",
      {
        start: 1.6,
        end: Math.min(4.8, screen.duration),
        zoom: 1.6,
        focusX: 0.6,
        focusY: 0.6,
        ease: 0.4,
      },
    ],
  ])
    p = await call(client, tool, {
      ...args,
      expected_revision: p.revision,
      ...fields,
    });
  const image = await client.callTool(
    {
      name: "get_preview",
      arguments: {
        ...args,
        expected_revision: p.revision,
        time: 2,
        mode: "screen",
        height: 720,
        fps: 60,
      },
    },
    { timeout: 120000 },
  );
  if (image.isError) throw new Error(JSON.stringify(image.content));
  await fs.writeFile(
    path.join(root, "edited-preview.png"),
    Buffer.from(image.content.find((c) => c.type === "image").data, "base64"),
  );
  const job = await call(client, "render", {
    ...args,
    expected_revision: p.revision,
    output_directory: root,
    mode: "combined",
    height: 720,
    fps: 60,
    audio: false,
  });
  let rendered;
  for (let i = 0; i < 600; i++) {
    rendered = await call(client, "render_status", { job_id: job.job_id });
    if (["failed", "cancelled", "succeeded"].includes(rendered.status)) break;
    await delay(100);
  }
  if (rendered.status !== "succeeded")
    throw new Error(rendered.error || "Render did not complete");
  const exportMeta = await probe(rendered.files[0]);
  const reopened = await readProject(directory);
  if (Math.abs(exportMeta.duration - outputDuration(reopened.edits)) > 0.1)
    throw new Error("Edited export duration mismatch");
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-i",
    rendered.files[0],
    "-f",
    "null",
    "-",
  ]);
  for (const time of [0.5, 3.5])
    await run(await binary("ffmpeg"), [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      path.join(directory, "screen.mp4"),
      "-frames:v",
      "1",
      path.join(root, `source-${time}.png`),
    ]);
  Object.assign(report, {
    mcpEditPreviewRender: true,
    export: rendered,
    exportMeta,
    cuts: reopened.edits.segments,
    zooms: reopened.edits.zooms,
    fullDecodePassed: true,
    captureVerified: true,
    cursorMovementVerified:
      uniquePoints >= 3 && report.cursorPressedSamples > 0,
    uiRecordingFlowVerified: false,
  });
  await fs.writeFile(
    path.join(root, "validation.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.writeFile(
    "evidence/live/latest.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ event: "verified", root, report }));
} catch (error) {
  report.error = error.message;
  await fs.writeFile(
    path.join(root, "validation.json"),
    JSON.stringify(report, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  capture?.abort();
  await client?.close();
  fixture.kill();
}
