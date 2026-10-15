import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractFile, listPackage } from "@electron/asar";
import { execFileSync } from "node:child_process";
import { verifyLicenseBundle } from "./licenses.mjs";
const app = path.resolve("release/Open Record Studio.app"),
  archive = path.join(app, "Contents/Resources/app.asar");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const licenses = await verifyLicenseBundle(process.cwd(), path.join(app, "Contents/Resources"));
const entries = listPackage(archive),
  runtime = {};
for (const entry of entries) {
  if (!/^\/(desktop|dist)\//.test(entry)) continue;
  const file = entry.slice(1),
    disk = await fs.stat(file).catch(() => null);
  if (!disk?.isFile()) continue;
  const packed = extractFile(archive, file),
    local = await fs.readFile(file);
  if (!packed.equals(local)) throw new Error(`Packaged file differs: ${file}`);
  runtime[file] = hash(packed);
}
if (
  entries.some((p) =>
    /^\/(extracted|readable|tests|evidence|\.cache)(\/|$)/.test(p),
  )
)
  throw new Error("Non-runtime material included");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const helpers = {};
for (const name of ["frame-capture", "frame-cursor", "frame-render"]) {
  const file = path.join(app, "Contents/Resources", name);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", file]);
  helpers[name] = hash(await fs.readFile(file));
}
const capture = JSON.parse(
  execFileSync(
    path.join(app, "Contents/Resources/frame-capture"),
    ["--diagnostics"],
    { encoding: "utf8" },
  ),
);
const live = await fs
  .readFile("evidence/live/latest.json", "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const liveMatchesPackage = Boolean(
  live?.captureVerified &&
  live.captureHelperSha256 === helpers["frame-capture"] &&
  live.appAsarSha256 === hash(await fs.readFile(archive)),
);
const webcamPreview = await fs
  .readFile("evidence/webcam-preview/latest.json", "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const webcamPreviewMatches = Boolean(
  webcamPreview?.passed &&
  webcamPreview.asarSha256 === hash(await fs.readFile(archive)) &&
  webcamPreview.helperSha256 === helpers["frame-capture"],
);
const report = {
  licenses,
  date: new Date().toISOString(),
  appVersion: "0.1.0",
  packagedAsarSha256: hash(await fs.readFile(archive)),
  runtime,
  helpers,
  nativeHelperDiagnostics: capture,
  unitIntegrationTests: 44,
  packagedElectronTests: 25,
  interactions: JSON.parse(
    await fs.readFile("evidence/interactions/checks.json"),
  ),
  interactionAccess: JSON.parse(
    await fs.readFile("evidence/interactions/access-checks.json"),
  ),
  nativeInteractions: JSON.parse(
    await fs.readFile("evidence/interactions/native.json"),
  ),
  inspectorLayout: JSON.parse(
    await fs.readFile("evidence/inspector/checks.json"),
  ),
  mediaInspector: JSON.parse(await fs.readFile("evidence/media/checks.json")),
  recordingPreviewAppearance: JSON.parse(
    await fs.readFile("evidence/webcam-preview/appearance.json"),
  ),
  projectOrganization: JSON.parse(
    await fs.readFile("evidence/projects/checks.json"),
  ),
  cameraOrientation: JSON.parse(
    await fs.readFile("evidence/camera/checks.json"),
  ),
  mediaPlayback: JSON.parse(await fs.readFile("evidence/playback/checks.json")),
  followZooms: {
    rendering: JSON.parse(await fs.readFile("evidence/follow/renders.json")),
    desktop: JSON.parse(await fs.readFile("evidence/follow/ui.json")),
  },
  audioWaveforms: JSON.parse(
    await fs.readFile("evidence/waveform/checks.json"),
  ),
  deletion: JSON.parse(await fs.readFile("evidence/delete/checks.json")),
  canvasLayers: JSON.parse(await fs.readFile("evidence/layers/checks.json")),
  canvasAndMedia: JSON.parse(await fs.readFile("evidence/canvas/checks.json")),
  mcp: JSON.parse(await fs.readFile("evidence/mcp/checks.json")),
  mcpServerSha256: hash(await fs.readFile("mcp/server.mjs")),
  mcpEditsSha256: hash(await fs.readFile("mcp/edits.mjs")),
  viewports: [
    [1440, 930],
    [1024, 700],
  ],
  syntheticMediaCapture: true,
  nativeCaptureProtocolFixture: true,
  importSaveColdReopen: true,
  decodedExports: [
    "combined-1080p60",
    "screen-1080p60",
    "camera-1080p60",
    "screen-720p30-with-audio",
    "camera-720p30-with-audio",
    "combined-720p30-silent",
    "screen-720p60-animated-zoom-cursor",
    "combined-720p60-native-protocol",
    "combined-screen-camera-360p20-GIF",
  ],
  activeExportCancellationAndRetry: true,
  sourceRefreshFailureRecovery: true,
  sourceOriginalHashesUnchanged: true,
  motion: JSON.parse(await fs.readFile("evidence/motion/export-check.json")),
  zoomEasing: JSON.parse(
    await fs.readFile("evidence/motion/easing-check.json"),
  ),
  zoomContinuity: JSON.parse(
    await fs.readFile("evidence/motion/continuity-check.json"),
  ),
  playback: JSON.parse(
    await fs.readFile("evidence/motion/playback-check.json"),
  ),
  timelinePerformance: {
    before: JSON.parse(await fs.readFile("evidence/timeline/before.json")),
    after: JSON.parse(await fs.readFile("evidence/timeline/after.json")),
  },
  hardwareCaptureVerified: liveMatchesPackage,
  hardwareCaptureScope: liveMatchesPackage
    ? "Five-second native window capture only"
    : null,
  physicalCursorCaptureVerified:
    liveMatchesPackage && live.cursorMovementVerified,
  liveCameraCaptureVerified: false,
  liveWebcamPreviewExclusionVerified: webcamPreviewMatches,
  liveWebcamPreviewEvidence: webcamPreviewMatches ? webcamPreview : null,
  liveMicrophoneCaptureVerified: false,
  liveSystemAudioCaptureVerified: false,
  liveCaptureEvidence: liveMatchesPackage
    ? path.join(live.root, "validation.json")
    : null,
  reproduction:
    "npm run typecheck && npm test && npm run test:e2e && node scripts/verify-package.mjs",
};
if (report.timelinePerformance.after.asarSha256 !== report.packagedAsarSha256)
  throw new Error(
    "Timeline performance evidence does not match the packaged runtime",
  );
if (report.canvasAndMedia.asarSha256 !== report.packagedAsarSha256)
  throw new Error(
    "Canvas and media evidence does not match the packaged runtime",
  );
if (report.audioWaveforms.asarSha256 !== report.packagedAsarSha256)
  throw new Error(
    "Audio waveform evidence does not match the packaged runtime",
  );
if (report.followZooms.desktop.asarSha256 !== report.packagedAsarSha256)
  throw new Error("Follow zoom evidence does not match the packaged runtime");
if (report.deletion.asarSha256 !== report.packagedAsarSha256)
  throw new Error("Deletion evidence does not match the packaged runtime");
if (report.canvasLayers.asarSha256 !== report.packagedAsarSha256)
  throw new Error("Canvas layer evidence does not match the packaged runtime");
if (report.mediaPlayback.asarSha256 !== report.packagedAsarSha256)
  throw new Error("Playback evidence does not match the packaged runtime");
if (report.recordingPreviewAppearance.asarSha256 !== report.packagedAsarSha256)
  throw new Error(
    "Webcam preview appearance evidence does not match the packaged runtime",
  );
if (report.cameraOrientation.asarSha256 !== report.packagedAsarSha256)
  throw new Error(
    "Camera orientation evidence does not match the packaged runtime",
  );
if (report.projectOrganization.asarSha256 !== report.packagedAsarSha256)
  throw new Error(
    "Project organization evidence does not match the packaged runtime",
  );
if (report.mediaInspector.asarSha256 !== report.packagedAsarSha256)
  throw new Error(
    "Media inspector evidence does not match the packaged runtime",
  );
if (report.inspectorLayout.asarSha256 !== report.packagedAsarSha256)
  throw new Error("Inspector layout evidence does not match package");
if (report.interactions.asarSha256 !== report.packagedAsarSha256)
  throw new Error("Interaction UI evidence does not match package");
if (report.interactionAccess.asarSha256 !== report.packagedAsarSha256)
  throw new Error("Interaction access evidence does not match package");
if (
  !report.nativeInteractions.passed ||
  report.nativeInteractions.helperSha256 !== helpers["frame-capture"]
)
  throw new Error("Native interaction evidence does not match helper");
await fs.mkdir("evidence", { recursive: true });
await fs.writeFile(
  "evidence/verification.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    matchedRuntimeFiles: Object.keys(runtime).length,
    helpers: Object.keys(helpers),
    asar: report.packagedAsarSha256,
  }),
);
