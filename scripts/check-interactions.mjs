// Opt-in native check: records only a dedicated generated text window.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startCapture } from "../desktop/native-capture.mjs";
import {
  validateInteractions,
  automaticZooms,
} from "../desktop/interactions.mjs";
import {
  probe,
  binary,
  run,
  validateEdits,
  defaults,
} from "../desktop/media.mjs";

const root = path.resolve(
  "evidence/interactions/live",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const target = path.join(root, "Open Record Studio Interaction Test.app"),
  executable = path.join(target, "Contents/MacOS/fixture");
await fs.mkdir(path.dirname(executable), { recursive: true });
await fs.writeFile(
  path.join(target, "Contents/Info.plist"),
  `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.framestudio.interactionfixture</string><key>CFBundleName</key><string>Open Record Studio Interaction Test</string><key>CFBundleExecutable</key><string>fixture</string></dict></plist>`,
);
execFileSync("xcrun", [
  "swiftc",
  "tests/fixtures/InteractionWindow.swift",
  "-o",
  executable,
]);
execFileSync("codesign", ["--force", "--sign", "-", target]);
const helper = path.resolve(
  process.env.FRAME_CAPTURE_HELPER ||
    "release/Open Record Studio.app/Contents/Resources/frame-capture",
);
const report = {
  date: new Date().toISOString(),
  root,
  source: "dedicated generated native text window",
  physicalKeyboard: false,
  physicalCamera: false,
  helperSha256: createHash("sha256")
    .update(await fs.readFile(helper))
    .digest("hex"),
};
const fixture = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
let pending = "",
  capture;
const events = [];
fixture.stdout.on("data", (chunk) => {
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) events.push(JSON.parse(line));
});
fixture.stderr.on("data", (data) => process.stderr.write(data));
async function until(event, ms = 15000) {
  const start = Date.now();
  while (!events.some((e) => e.event === event)) {
    if (events.some((e) => e.event === "aborted"))
      throw new Error(events.find((e) => e.event === "aborted").reason);
    if (Date.now() - start > ms)
      throw new Error(`Timed out waiting for ${event}`);
    await delay(100);
  }
  return events.find((e) => e.event === event);
}
try {
  const ready = await until("ready");
  capture = startCapture(helper, {
    source: `window:${ready.windowID}`,
    output: path.join(root, "screen.mp4"),
  });
  await capture.ready;
  fixture.stdin.write("run\n");
  await until("done");
  await delay(300);
  await capture.stop();
  const media = await probe(path.join(root, "screen.mp4"));
  const raw = JSON.parse(
    await fs.readFile(path.join(root, "interactions.json")),
  );
  raw.events = raw.events
    .filter((e) => e.t <= media.duration)
    .map((e) => ({ ...e, end: Math.min(e.end, media.duration) }));
  const activity = validateInteractions(raw, media.duration);
  const kinds = [...new Set(activity.events.map((e) => e.type))];
  report.permissions = activity.permissions;
  report.kinds = kinds;
  report.events = activity.events;
  report.duration = media.duration;
  for (const kind of ["click", "typing", "selection"])
    if (!kinds.includes(kind)) throw new Error(`No ${kind} captured`);
  const typing = activity.events.filter((e) => e.type === "typing");
  if (
    typing.length !== 1 ||
    typing[0].count !== 5 ||
    typing[0].end - typing[0].t < 0.5
  )
    throw new Error("Keystrokes did not form one typing burst");
  const cursor = JSON.parse(await fs.readFile(path.join(root, "cursor.json")));
  const clickTime = activity.events.find((event) => event.type === "click").t;
  const motion = cursor.samples.filter(
    (sample) => sample.t > clickTime && sample.t < typing[0].t,
  );
  report.distinctCursorPositionsDuringMotion = new Set(
    motion.map((sample) => `${sample.x}:${sample.y}`),
  ).size;
  if (report.distinctCursorPositionsDuringMotion < 20)
    throw new Error("Cursor motion was incorrectly coalesced");
  const zooms = automaticZooms(activity, media.duration, cursor);
  validateEdits(
    { style: defaults, segments: [{ start: 0, end: media.duration }], zooms },
    media.duration,
  );
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-xerror",
    "-i",
    path.join(root, "screen.mp4"),
    "-f",
    "null",
    "-",
  ]);
  report.passed = true;
  report.generatedZooms = zooms;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (capture) capture.abort();
  fixture.kill();
  await fs.writeFile(
    path.join(root, "validation.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.writeFile(
    "evidence/interactions/native.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
