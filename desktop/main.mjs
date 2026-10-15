import {
  recordingPreferences,
  updateRecordingPreferences,
} from "./recording-preferences.mjs";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  nativeImage,
  Notification,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { configureAppIdentity } from "./app-identity.mjs";
import {
  binary,
  defaults,
  exportProject,
  probe,
  readProject,
  run,
  saveProject,
  validateEdits,
  validateCursor,
} from "./media.mjs";
import { serveMedia } from "./serve-media.mjs";
import { enhanceProjectAudio } from "./enhance-audio.mjs";
import { startCapture } from "./native-capture.mjs";
import { resizePreviewBounds } from "./preview-window.mjs";
import {
  keepAppInSwitcher,
  previewWorkspaceOptions,
} from "./window-visibility.mjs";
import { makeTakeMap } from "./webcam-take.mjs";
import { compositionSize, compositionLayout } from "./composition.mjs";
import {
  automaticZooms,
  cursorClicks,
  reconcileInteractions,
} from "./interactions.mjs";
import { projectRevision } from "./project-store.mjs";
import {
  projectsFolder,
  setProjectsFolder,
  allocateProject,
  projectName,
} from "./project-library.mjs";
import { assetWaveform, projectWaveforms } from "./waveform.mjs";
import { createExportNotifier } from "./export-notification.mjs";
const notifyExportComplete = createExportNotifier({
  Notification,
  openPath: (directory) => shell.openPath(directory),
});
import {
  imageExtensions,
  videoExtensions,
  inspectImport,
  importTrack,
} from "./import-media.mjs";
const nativeCapturePath = import.meta.url.includes("app.asar/")
  ? path.join(process.resourcesPath, "frame-capture")
  : path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../native/bin/frame-capture",
    );
const here = path.dirname(fileURLToPath(import.meta.url));
configureAppIdentity(app);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "studio",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
let win,
  current,
  recording,
  selectedSource,
  exporter,
  tray,
  lastExport,
  recordingPreview;
let previewResize;
const projects = new Map();
const sourceTargets = new Map();
const allowedTracks = new Set(["screen", "camera", "microphone"]);
let waveformJob;
const assetWaveformJobs = new Map();
let assetWaveformQueue = Promise.resolve();
const publicAssets = (p) =>
  Object.fromEntries(
    Object.entries(p.assets || {}).map(([id, asset]) => [
      id,
      { ...asset, url: `studio://media/${p.id}/assets/${id}` },
    ]),
  );
let enhancementJob = null;
const enhancedFiles = new Map();
function publicProject(p) {
  current = p;
  if (!p.id) p.id = randomUUID();
  if (waveformJob && waveformJob.id !== p.id) {
    waveformJob.controller.abort();
    waveformJob = null;
  }
  for (const job of assetWaveformJobs.values())
    if (job.id !== p.id) job.controller.abort();
  projects.set(p.id, p);
  if (enhancementJob && enhancementJob.id !== p.id)
    enhancementJob.controller.abort();
  return {
    ...p,
    assets: publicAssets(p),
    tracks: Object.fromEntries(
      Object.entries(p.tracks).map(([k, t]) => [
        k,
        { ...t, url: `studio://media/${p.id}/${k}` },
      ]),
    ),
  };
}
function handle(name, fn) {
  ipcMain.handle("frame:" + name, async (event, ...args) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      throw new Error("Untrusted request");
    return fn(...args);
  });
}
handle("waveforms", async (id) => {
  if (!current || id !== current.id)
    throw new Error("Open this project before reading its waveforms");
  if (waveformJob?.id === id) return waveformJob.promise;
  waveformJob?.controller.abort();
  const controller = new AbortController();
  const job = {
    id,
    controller,
    promise: projectWaveforms(current, { signal: controller.signal }),
  };
  waveformJob = job;
  try {
    return await job.promise;
  } catch (error) {
    if (waveformJob === job) waveformJob = null;
    throw error;
  }
});
handle("assetWaveform", async (id, assetId) => {
  if (!current || current.id !== id)
    throw new Error("Open this project before reading its waveforms");
  const key = `${id}:${assetId}`;
  if (assetWaveformJobs.has(key)) return assetWaveformJobs.get(key).promise;
  const project = current;
  const controller = new AbortController();
  // Decode one take at a time so opening many takes cannot saturate playback.
  const promise = assetWaveformQueue.then(() =>
    assetWaveform(project, assetId, { signal: controller.signal }),
  );
  const job = { id, controller, promise };
  assetWaveformJobs.set(key, job);
  assetWaveformQueue = promise.catch(() => {});
  try {
    return await promise;
  } finally {
    if (assetWaveformJobs.get(key) === job) assetWaveformJobs.delete(key);
  }
});
handle("enhanceAudio", async (id) => {
  if (!current || current.id !== id)
    throw new Error("Open this project before enhancing audio");
  enhancementJob?.controller.abort();
  const controller = new AbortController();
  const job = { id, controller };
  enhancementJob = job;
  try {
    const files = await enhanceProjectAudio(current, {
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    enhancedFiles.set(id, files);
    return Object.fromEntries(
      Object.keys(files).map((key) => [
        key,
        `studio://media/${id}/enhanced/${key}`,
      ]),
    );
  } finally {
    if (enhancementJob === job) enhancementJob = null;
  }
});
handle("cancelEnhanceAudio", (id) => {
  if (enhancementJob?.id === id) enhancementJob.controller.abort();
});
app.on("before-quit", () => {
  waveformJob?.controller.abort();
  for (const job of assetWaveformJobs.values()) job.controller.abort();
  enhancementJob?.controller.abort();
});
function refreshRecordingMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(recordingPreview && recording?.previewExcluded
        ? [
            {
              label: recordingPreview.isVisible()
                ? "Hide webcam preview"
                : "Show webcam preview",
              click: () => {
                if (!recordingPreview || !recording?.previewExcluded) return;
                if (recordingPreview.isVisible()) recordingPreview.hide();
                else recordingPreview.showInactive();
                refreshRecordingMenu();
              },
            },
            { type: "separator" },
          ]
        : []),
      {
        label: "Stop recording",
        click: () => win.webContents.send("frame:stop"),
      },
    ]),
  );
}
function recordingUI(active) {
  if (active) {
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle("● REC");
    tray.setToolTip("Open Record Studio — recording");
    refreshRecordingMenu();
    globalShortcut.register("CommandOrControl+Shift+2", () =>
      win.webContents.send("frame:stop"),
    );
  } else {
    previewResize = null;
    recordingPreview?.destroy();
    recordingPreview = null;
    tray?.destroy();
    tray = null;
    globalShortcut.unregister("CommandOrControl+Shift+2");
    keepAppInSwitcher(app);
    win?.show();
  }
}
async function createProject(
  name,
  directory,
  tracks,
  duration,
  cursor,
  interactions,
  autoZoom,
) {
  const p = {
    version: 1,
    kind: "frame-studio",
    name,
    createdAt: new Date().toISOString(),
    duration,
    ...(cursor ? { cursor } : {}),
    ...(interactions ? { interactions, recording: { autoZoom } } : {}),
    tracks,
    edits: {
      segments: [{ start: 0, end: duration }],
      // Start at the captured/imported proportions; keep legacy defaults for old projects.
      style: { ...defaults, aspectRatio: "source" },
      ...(interactions
        ? { zooms: automaticZooms(interactions, duration, cursor, autoZoom) }
        : {}),
    },
    directory,
  };
  await saveProject(p);
  return publicProject(p);
}
async function chooseProjectsFolder() {
  ensureIdle();
  const choice = await dialog.showOpenDialog(win, {
    title: "Choose a folder for all your projects",
    defaultPath:
      (await projectsFolder(app.getPath("userData"))) || app.getPath("videos"),
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  if (choice.canceled || !choice.filePaths.length) return null;
  return setProjectsFolder(app.getPath("userData"), choice.filePaths[0]);
}
handle("projectsFolder", () => projectsFolder(app.getPath("userData")));
handle("chooseProjectsFolder", chooseProjectsFolder);
async function newLocation(sourceName) {
  const folder =
    (await projectsFolder(app.getPath("userData"))) ||
    (await chooseProjectsFolder());
  return folder ? allocateProject(folder, sourceName) : null;
}
function ensureIdle() {
  if (recording || exporter)
    throw new Error("Finish the current recording or export first");
}

handle("status", async () => ({
  ffmpeg: await binary("ffmpeg").then(
    () => true,
    () => false,
  ),
  screenPermission: systemPreferences.getMediaAccessStatus("screen"),
  cameraPermission: systemPreferences.getMediaAccessStatus("camera"),
  microphonePermission: systemPreferences.getMediaAccessStatus("microphone"),
  nativeCapture: await fs.access(nativeCapturePath).then(
    () => Number(process.getSystemVersion().split(".")[0]) >= 15,
    () => false,
  ),
  project: current ? publicProject(current) : null,
}));
handle("sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 280, height: 170 },
    fetchWindowIcons: true,
  });
  sourceTargets.clear();
  for (const s of sources)
    sourceTargets.set(
      s.id,
      s.id.startsWith("screen:") ? `screen:${s.display_id}` : s.id,
    );
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    displayId: s.display_id,
  }));
});
handle("openScreenSettings", async () => {
  ensureIdle();
  await shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
});
async function interactionAccess(request = false) {
  if (typeof request !== "boolean")
    throw new Error("Invalid permission request");
  const available =
    Number(process.getSystemVersion().split(".")[0]) >= 15 &&
    (await fs.access(nativeCapturePath).then(
      () => true,
      () => false,
    ));
  if (!available)
    return { available: false, accessibility: false, inputMonitoring: false };
  return {
    ...JSON.parse(
      await run(nativeCapturePath, [
        request ? "--request-interaction-access" : "--interaction-access",
      ]),
    ),
    available: true,
  };
}
function requireInteractionAccess(access) {
  if (!access.available)
    throw new Error(
      "Screen recording with automatic text tracking requires macOS 15 or later.",
    );
  if (!access.accessibility || !access.inputMonitoring)
    throw new Error(
      "Enable Accessibility and Input Monitoring for Open Record Studio before recording. Typing and selection tracking is required.",
    );
}
handle("interactionAccess", async (request = false) => {
  ensureIdle();
  return interactionAccess(request);
});
handle("selectSource", async (id) => {
  if (typeof id !== "string") throw new Error("Choose a capture source");
  selectedSource = id;
});
handle("recordingPreferences", () =>
  recordingPreferences(app.getPath("userData")),
);
handle("updateRecordingPreferences", (patch) =>
  updateRecordingPreferences(app.getPath("userData"), patch),
);
handle("begin", async () => {
  ensureIdle();
  requireInteractionAccess(await interactionAccess());
  await binary("ffmpeg");
  const directory = await newLocation();
  if (!directory) return null;
  const id = randomUUID();
  recording = {
    id,
    directory,
    queues: {},
    errors: [],
    startedAt: Date.now(),
    autoZoom: (await recordingPreferences(app.getPath("userData"))).autoZoom,
  };
  recordingUI(true);
  return { id };
});
handle("beginTake", async (projectId, revision) => {
  ensureIdle();
  if (
    !current ||
    current.id !== projectId ||
    current.revision !== revision ||
    (await projectRevision(current.directory)) !== revision
  )
    throw new Error("Save or reload the current project before recording");
  if (
    (current.edits.layers?.length || 0) >= 16 ||
    Object.keys(current.assets || {}).length >= 128
  )
    throw new Error("Remove an overlay before adding another recording");
  await binary("ffmpeg");
  const id = randomUUID();
  const directory = await fs.mkdtemp(
    path.join(current.directory, ".webcam-take-"),
  );
  const snapshot = structuredClone(current);
  await fs.writeFile(
    path.join(directory, "recovery.json"),
    JSON.stringify({
      kind: "webcam-take",
      projectId,
      revision,
      edits: snapshot.edits,
    }),
  );
  recording = {
    id,
    directory,
    kind: "webcam-take",
    project: snapshot,
    queues: {},
    errors: [],
    previewExcluded: true,
  };
  recordingUI(true);
  return { id };
});
handle("finishTake", async (id, samples) => {
  const rec = recording;
  if (!rec || rec.id !== id || rec.kind !== "webcam-take")
    throw new Error("Webcam recording not found");
  try {
    await Promise.all(Object.values(rec.queues));
    if (rec.errors.length) throw new Error(rec.errors.join("; "));
    await fs.writeFile(
      path.join(rec.directory, "timing.json"),
      JSON.stringify(samples),
    );
    const final = path.join(rec.directory, "camera.mkv");
    await run(await binary("ffmpeg"), [
      "-v",
      "error",
      "-nostdin",
      "-n",
      "-i",
      path.join(rec.directory, "camera.webm"),
      "-map",
      "0",
      "-c",
      "copy",
      final,
    ]);
    const meta = await probe(final);
    if (!meta.video || meta.duration < 0.05)
      throw new Error("No webcam frames were captured");
    const p = rec.project;
    const timing = makeTakeMap(p.edits, samples, meta.duration);
    const assetId = randomUUID(),
      layerId = randomUUID();
    const count =
      Object.values(p.assets || {}).filter((a) => a.timeMap).length + 1;
    const style = p.edits.style;
    const { width, height } = compositionSize(style, 720, p.tracks.screen);
    const { cameraSize: side, cameraGap: gap } = compositionLayout(
      style,
      width,
      height,
    );
    p.assets = {
      ...p.assets,
      [assetId]: {
        file: path.relative(p.directory, final),
        name: `Webcam take ${count}`,
        sourceKind: "video",
        width: meta.width,
        height: meta.height,
        duration: meta.duration,
        audio: meta.audio,
        timeMap: timing.timeMap,
      },
    };
    p.edits.layers = [
      ...(p.edits.layers || []),
      {
        id: layerId,
        assetId,
        start: timing.start,
        end: timing.end,
        mediaStart: 0,
        x: style.cameraCorner.endsWith("right")
          ? 1 - (gap + side / 2) / width
          : (gap + side / 2) / width,
        y: style.cameraCorner.startsWith("bottom")
          ? 1 - (gap + side / 2) / height
          : (gap + side / 2) / height,
        width: side / width,
        opacity: 1,
        visible: true,
        roundness: style.cameraRoundness,
        flip: style.cameraFlip,
        volume: 1,
      },
    ];
    p.edits = validateEdits(p.edits, p.duration, p.assets);
    if (current?.id !== p.id)
      throw new Error(
        "The project changed while recording. The take is kept for recovery.",
      );
    await saveProject(p);
    await fs.unlink(path.join(rec.directory, "camera.webm")).catch(() => {});
    await fs.unlink(path.join(rec.directory, "recovery.json")).catch(() => {});
    return { project: publicProject(p), layerId };
  } finally {
    recording = null;
    recordingUI(false);
  }
});
handle("startNative", async (id, audio) => {
  const rec = recording;
  if (!rec || rec.id !== id || rec.native || !selectedSource)
    throw new Error("No capture session");
  rec.native = startCapture(nativeCapturePath, {
    source: sourceTargets.get(selectedSource) || selectedSource,
    output: path.join(rec.directory, "screen.mp4"),
    audio: Boolean(audio),
    excludeApplicationPIDs: [process.pid],
  });
  rec.native.done.catch((error) => {
    rec.errors.push(error.message);
    win?.webContents.send("frame:stop");
  });
  const start = await rec.native.ready;
  const tracking = start.interactions;
  if (
    !tracking?.permissions?.accessibility ||
    !tracking?.permissions?.inputMonitoring ||
    !tracking?.capabilities?.typing ||
    !tracking?.capabilities?.selection
  ) {
    await rec.native.stop().catch(() => {});
    throw new Error(
      "Text tracking could not start. Check Open Record Studio’s Accessibility and Input Monitoring access, then retry recording.",
    );
  }
  rec.nativeStartedAt = start.startedAt;
  rec.previewExcluded =
    start.captureType === "window" ||
    start.excludedApplicationPIDs?.includes(process.pid) === true;
  return start;
});
handle("stopNative", async (id) => {
  if (recording?.id === id && recording.native) await recording.native.stop();
});
handle("recordingReady", () => {
  if (!recording) return;
  // An overdub stays in the editor, including when it is in a fullscreen Space.
  if (recording.kind === "webcam-take") {
    refreshRecordingMenu();
    return;
  }
  if (recordingPreview && !recording.previewExcluded)
    throw new Error(
      "The webcam preview could not be excluded from capture. Recording stopped.",
    );
  win.minimize();
  recordingPreview?.showInactive();
  refreshRecordingMenu();
});
handle("showRecordingPreview", () => recordingPreview?.showInactive());
handle("closeRecordingPreview", () => {
  if (recording) return;
  previewResize = null;
  recordingPreview?.destroy();
  recordingPreview = null;
});
handle("hideRecordingPreview", () => {
  previewResize = null;
  recordingPreview?.hide();
  refreshRecordingMenu();
});
handle("resizeRecordingPreview", (gesture) => {
  if (!recordingPreview || recordingPreview.isDestroyed()) return;
  if (
    !gesture ||
    !["start", "move", "end", "cancel"].includes(gesture.phase) ||
    !["nw", "ne", "sw", "se"].includes(gesture.corner) ||
    !Number.isFinite(gesture.screenX) ||
    !Number.isFinite(gesture.screenY)
  )
    throw new Error("Invalid preview resize");
  if (gesture.phase === "start") {
    const bounds = recordingPreview.getBounds();
    previewResize = {
      ...gesture,
      bounds,
      area: screen.getDisplayMatching(bounds).workArea,
    };
  } else if (previewResize?.corner === gesture.corner) {
    if (gesture.phase === "cancel")
      recordingPreview.setBounds(previewResize.bounds);
    else
      recordingPreview.setBounds(
        resizePreviewBounds(
          previewResize.bounds,
          gesture.corner,
          gesture.screenX - previewResize.screenX,
          gesture.screenY - previewResize.screenY,
          previewResize.area,
        ),
      );
    if (gesture.phase !== "move") previewResize = null;
  }
});
handle("append", async (id, track, bytes) => {
  const rec = recording;
  if (
    !rec ||
    rec.id !== id ||
    !allowedTracks.has(track) ||
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength > 32 * 1024 * 1024
  )
    throw new Error("Invalid recording chunk");
  const previous = rec.queues[track] || Promise.resolve();
  const job = previous.then(() =>
    fs.appendFile(
      path.join(rec.directory, track + ".webm"),
      Buffer.from(bytes),
    ),
  );
  rec.queues[track] = job.catch((error) => {
    rec.errors.push(error.message);
  });
  return job;
});
handle("abort", async (id) => {
  if (!recording || recording.id !== id) return;
  const rec = recording;
  rec.native?.abort();
  recording = null;
  await Promise.all(Object.values(rec.queues));
  recordingUI(false);
  // Keep captured files available for manual recovery after errors.
  await fs.writeFile(
    path.join(rec.directory, "recovery.json"),
    JSON.stringify({ interrupted: true, errors: rec.errors }),
  );
});
handle("finish", async (id, metadata) => {
  const rec = recording;
  if (!rec || rec.id !== id) throw new Error("Recording session not found");
  try {
    await Promise.all(Object.values(rec.queues));
    if (rec.errors.length) throw new Error(rec.errors.join("; "));
    if (rec.native) await rec.native.stop();
    const start = rec.nativeStartedAt ?? metadata?.screen?.startedAt;
    if (!Number.isFinite(start)) throw new Error("Missing recording clock");
    const tracks = {};
    let cursor, interactions;
    if (rec.native) {
      const info = await probe(path.join(rec.directory, "screen.mp4"));
      tracks.screen = { ...info, file: "screen.mp4", offset: 0 };
      const raw = JSON.parse(
        await fs.readFile(path.join(rec.directory, "cursor.json"), "utf8"),
      );
      // The final timer sample can follow the final video frame by one frame.
      raw.samples = raw.samples.filter((p) => p.t <= info.duration);
      cursor = validateCursor(raw, info.duration);
      const interactionRaw = await fs
        .readFile(path.join(rec.directory, "interactions.json"), "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code === "ENOENT")
            return cursorClicks(cursor, info.duration);
          throw error;
        });
      interactionRaw.events = interactionRaw.events
        .filter((event) => event.t <= info.duration)
        .map((event) => ({
          ...event,
          end: Math.min(event.end ?? event.t, info.duration),
        }));
      interactions = reconcileInteractions(
        interactionRaw,
        cursor,
        info.duration,
      );
    }
    for (const key of allowedTracks)
      if (rec.queues[key]) {
        const stamp = metadata[key]?.startedAt;
        if (!Number.isFinite(stamp)) throw new Error("Missing track clock");
        const raw = path.join(rec.directory, key + ".webm"),
          final = path.join(rec.directory, key + ".mkv");
        // Remux finalizes WebM durations and indexes without re-encoding media.
        await run(await binary("ffmpeg"), [
          "-v",
          "error",
          "-nostdin",
          "-n",
          "-i",
          raw,
          "-map",
          "0",
          "-c",
          "copy",
          final,
        ]);
        const info = await probe(final);
        tracks[key] = {
          ...info,
          file: key + ".mkv",
          offset: (stamp - start) / 1000,
        };
      }
    if (!tracks.screen?.video || tracks.screen.duration < 0.05)
      throw new Error("No screen frames were captured");
    const result = await createProject(
      path.basename(rec.directory, ".framestudio"),
      rec.directory,
      tracks,
      tracks.screen.duration,
      cursor,
      interactions,
      rec.autoZoom,
    );
    for (const key of Object.keys(tracks))
      await fs.unlink(path.join(rec.directory, key + ".webm")).catch(() => {});
    return result;
  } finally {
    recording = null;
    recordingUI(false);
  }
});
handle("importMedia", async (withCamera = false, imageDuration = 10) => {
  ensureIdle();
  await binary("ffmpeg");
  const choose = (title, images = false) =>
    dialog.showOpenDialog(win, {
      title,
      properties: ["openFile"],
      filters: [
        {
          name: images ? "Videos and images" : "Video",
          extensions: [...videoExtensions, ...(images ? imageExtensions : [])],
        },
      ],
    });
  const screenFile = await choose("Choose a video or image", true);
  if (screenFile.canceled) return null;
  let cameraFile;
  if (withCamera) {
    cameraFile = await choose("Choose the webcam recording");
    if (cameraFile.canceled) return null;
  }
  const screenMeta = await inspectImport(
    screenFile.filePaths[0],
    imageDuration,
  );
  const cameraMeta = cameraFile ? await probe(cameraFile.filePaths[0]) : null;
  if (cameraMeta && (!cameraMeta.video || cameraMeta.duration < 0.05))
    throw new Error("The webcam file has no usable video");
  const directory = await newLocation(
    path.basename(
      screenFile.filePaths[0],
      path.extname(screenFile.filePaths[0]),
    ),
  );
  if (!directory) return null;
  const tracks = {};
  try {
    for (const [key, file, meta] of [
      ["screen", screenFile.filePaths[0], screenMeta],
      ["camera", cameraFile?.filePaths[0], cameraMeta],
    ])
      if (file) {
        tracks[key] = await importTrack(file, directory, key, meta);
      }
    return await createProject(
      path.basename(directory, ".framestudio"),
      directory,
      tracks,
      tracks.screen.duration,
    );
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
});
let attachingCamera = false;
handle("attachCamera", async (projectId, revision) => {
  ensureIdle();
  if (!current || current.id !== projectId)
    throw new Error("Open this project before adding a webcam");
  if (current.tracks.camera)
    throw new Error("This project already has a webcam video");
  if (attachingCamera)
    throw new Error("A webcam video is already being imported");
  const p = current;
  attachingCamera = true;
  let copied;
  try {
    const picked = await dialog.showOpenDialog(win, {
      title: "Choose a webcam video",
      properties: ["openFile"],
      filters: [{ name: "Video", extensions: videoExtensions }],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    if (current !== p) throw new Error("The project changed. Please try again");
    const file = picked.filePaths[0];
    const meta = await inspectImport(file);
    if (meta.sourceKind === "image")
      throw new Error("Choose a video for the webcam track");
    const filename = `camera-${randomUUID()}${path.extname(file).toLowerCase()}`;
    copied = path.join(p.directory, filename);
    await fs.copyFile(file, copied, fs.constants.COPYFILE_EXCL);
    if (current !== p) throw new Error("The project changed. Please try again");
    const next = {
      ...p,
      revision,
      tracks: {
        ...p.tracks,
        camera: {
          ...meta,
          file: filename,
          name: path.basename(file),
          sourceKind: "video",
          offset: 0,
        },
      },
    };
    await saveProject(next);
    p.tracks = next.tracks;
    p.revision = next.revision;
    return publicProject(p);
  } catch (error) {
    if (copied) await fs.rm(copied, { force: true });
    throw error;
  } finally {
    attachingCamera = false;
  }
});
// Import into the current project without replacing or saving its unsaved edits.
let addingMedia = false;
handle("addMedia", async (projectId, remaining) => {
  ensureIdle();
  if (!current || current.id !== projectId)
    throw new Error("Open this project before adding media");
  if (addingMedia) throw new Error("Media is already being imported");
  if (!Number.isInteger(remaining) || remaining < 1 || remaining > 16)
    throw new Error("Keep at most 16 canvas layers");
  const p = current,
    imported = {},
    copied = [];
  addingMedia = true;
  try {
    const picked = await dialog.showOpenDialog(win, {
      title: "Add images or videos to the canvas",
      buttonLabel: "Add to canvas",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Images and videos",
          extensions: [...imageExtensions, ...videoExtensions],
        },
      ],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    if (picked.filePaths.length > remaining)
      throw new Error(`You can add ${remaining} more canvas layers`);
    if (Object.keys(p.assets || {}).length + picked.filePaths.length > 128)
      throw new Error("This project's media library is full (128 assets)");
    await fs.mkdir(path.join(p.directory, "assets"), { recursive: true });
    const assetRoot = await fs.realpath(path.join(p.directory, "assets"));
    if (!assetRoot.startsWith((await fs.realpath(p.directory)) + path.sep))
      throw new Error("Media must stay inside its project");
    for (const source of picked.filePaths) {
      const meta = await inspectImport(source),
        id = randomUUID();
      const file = `assets/${id}${path.extname(source).toLowerCase()}`;
      await fs.copyFile(
        source,
        path.join(p.directory, file),
        fs.constants.COPYFILE_EXCL,
      );
      copied.push(path.join(p.directory, file));
      imported[id] = {
        file,
        name: path.basename(source),
        sourceKind: meta.sourceKind || "video",
        width: meta.width,
        height: meta.height,
        duration: meta.sourceKind === "image" ? 0 : meta.duration,
      };
    }
    if (current !== p)
      throw new Error(
        "The project changed while importing media; please try again",
      );
    p.assets = { ...p.assets, ...imported };
    return publicAssets({ ...p, assets: imported });
  } catch (error) {
    await Promise.all(copied.map((file) => fs.rm(file, { force: true })));
    throw error;
  } finally {
    addingMedia = false;
  }
});
handle("open", async () => {
  ensureIdle();
  const picked = await dialog.showOpenDialog(win, {
    title: "Open a project folder",
    defaultPath:
      (await projectsFolder(app.getPath("userData"))) || app.getPath("videos"),
    properties: ["openDirectory"],
    buttonLabel: "Open project",
  });
  return picked.canceled
    ? null
    : publicProject(await readProject(picked.filePaths[0]));
});
handle("projectRevision", async () =>
  current ? projectRevision(current.directory) : null,
);
handle("reload", async () => {
  ensureIdle();
  if (!current) throw new Error("Open a project first");
  return publicProject(await readProject(current.directory));
});
handle("save", async (edits, revision) => {
  if (!current) throw new Error("Open a project first");
  const next = {
    ...current,
    revision,
    edits: validateEdits(edits, current.duration, current.assets),
  };
  await saveProject(next);
  current.edits = next.edits;
  current.revision = next.revision;
  return next.revision;
});
handle("renameProject", async (id, name, revision) => {
  ensureIdle();
  if (!current || current.id !== id)
    throw new Error("Open this project before renaming it");
  const p = current;
  const next = { ...p, name: projectName(name), revision };
  await saveProject(next);
  p.name = next.name;
  p.revision = next.revision;
  return { name: next.name, revision: next.revision };
});
handle("export", async (edits, options) => {
  ensureIdle();
  if (!current) throw new Error("Open a project first");
  const validated = validateEdits(edits, current.duration, current.assets);
  const picked = await dialog.showOpenDialog(win, {
    title: "Choose an export folder",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Export here",
  });
  if (picked.canceled) return null;
  exporter = new AbortController();
  try {
    const result = await exportProject(
      current,
      validated,
      options,
      picked.filePaths[0],
      {
        signal: exporter.signal,
        onProgress: (p) => {
          if (!win.isDestroyed()) {
            win.webContents.send("frame:progress", p);
            win.setProgressBar(p.ratio);
          }
        },
      },
    );
    lastExport = result.directory;
    notifyExportComplete(current.name, result);
    return result;
  } finally {
    exporter = null;
    if (!win.isDestroyed()) win.setProgressBar(-1);
  }
});
handle("cancelExport", () => exporter?.abort());
handle("reveal", async () => {
  if (lastExport) await shell.openPath(lastExport);
  else if (current) await shell.openPath(current.directory);
});
handle("demo", async () => {
  ensureIdle();
  const root = path.join(app.getPath("userData"), "sample.framestudio");
  try {
    return publicProject(await readProject(root));
  } catch {}
  await fs.mkdir(root, { recursive: true });
  const ffmpeg = await binary("ffmpeg");
  // Native FFmpeg cannot read inside app.asar. Materialize the original demo
  // artwork in this self-contained sample project before rendering its videos.
  for (const name of ["screen", "camera"]) {
    await fs.writeFile(
      path.join(root, `sample-${name}.png`),
      await fs.readFile(path.join(here, `assets/demo-${name}.png`)),
    );
  }
  await run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    path.join(root, "sample-screen.png"),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=8",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-t",
    "8",
    path.join(root, "screen.mp4"),
  ]);
  await run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    path.join(root, "sample-camera.png"),
    "-t",
    "8",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "camera.mp4"),
  ]);
  const tracks = {
    screen: {
      ...(await probe(path.join(root, "screen.mp4"))),
      file: "screen.mp4",
      offset: 0,
    },
    camera: {
      ...(await probe(path.join(root, "camera.mp4"))),
      file: "camera.mp4",
      offset: 0,
    },
  };
  return createProject("Two tracks, one story", root, tracks, 8);
});

app
  .whenReady()
  .then(async () => {
    keepAppInSwitcher(app);
    app.on("activate", () => {
      keepAppInSwitcher(app);
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    const startup = process.argv.find((a) => a.startsWith("--project="));
    if (startup) current = await readProject(startup.slice(10));
    protocol.handle("studio", async (request) => {
      const url = new URL(request.url),
        [id, track, assetId] = url.pathname.slice(1).split("/");
      const p = projects.get(id);
      if (url.hostname === "media" && p && track === "enhanced") {
        const file = enhancedFiles.get(id)?.[assetId];
        return file
          ? serveMedia(file, request)
          : new Response("Not found", { status: 404 });
      }
      const media =
        track === "assets" && Object.hasOwn(p?.assets || {}, assetId)
          ? p.assets[assetId]
          : allowedTracks.has(track)
            ? p?.tracks[track]
            : null;
      if (url.hostname !== "media" || !p || !media)
        return new Response("Not found", { status: 404 });
      return serveMedia(path.join(p.directory, media.file), request);
    });
    win = new BrowserWindow({
      width: 1440,
      height: 930,
      minWidth: 1024,
      minHeight: 700,
      backgroundColor: "#09090b",
      title: "Open Record Studio",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 20, y: 15 },
      webPreferences: {
        preload: path.join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(({ url, frameName }) => {
      if (
        url !== "about:blank" ||
        frameName !== "frame-recording-preview" ||
        recording?.kind === "webcam-take" ||
        recordingPreview
      )
        return { action: "deny" };
      const displayId = Number(
        sourceTargets.get(selectedSource)?.split(":")[1],
      );
      const display =
        (selectedSource?.startsWith("screen:") &&
          screen.getAllDisplays().find((d) => d.id === displayId)) ||
        screen.getDisplayMatching(win.getBounds());
      const { x, y, width, height } = display.workArea;
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          title: "Open Record Studio — Webcam preview",
          width: 248,
          height: 248,
          x: x + width - 272,
          y: y + height - 272,
          show: false,
          acceptFirstMouse: true,
          frame: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: process.platform !== "darwin",
          alwaysOnTop: true,
          transparent: true,
          backgroundColor: "#00000000",
          hasShadow: false,
          roundedCorners: false,
        },
      };
    });
    win.webContents.on("did-create-window", (preview) => {
      recordingPreview = preview;
      preview.once("ready-to-show", () => {
        if (
          !recording &&
          recordingPreview === preview &&
          !preview.isDestroyed()
        )
          preview.showInactive();
      });
      preview.setContentProtection(true);
      preview.setAlwaysOnTop(true, "floating");
      preview.setVisibleOnAllWorkspaces(true, previewWorkspaceOptions);
      preview.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      preview.webContents.on("will-navigate", (event) =>
        event.preventDefault(),
      );
      preview.on("close", (event) => {
        if (recording) {
          event.preventDefault();
          preview.hide();
          refreshRecordingMenu();
        }
      });
      // Native visibility events can precede isVisible() changing on macOS.
      preview.on("show", () => setImmediate(refreshRecordingMenu));
      preview.on("hide", () => setImmediate(refreshRecordingMenu));
      preview.on("closed", () => {
        if (recordingPreview === preview) recordingPreview = null;
        keepAppInSwitcher(app);
        refreshRecordingMenu();
      });
    });
    win.webContents.on("will-prevent-unload", (event) => {
      const choice = dialog.showMessageBoxSync(win, {
        type: "question",
        buttons: ["Keep editing", "Discard changes"],
        defaultId: 0,
        cancelId: 0,
        message: "This project has unsaved edits.",
        detail: "Save with ⌘S to keep your changes before closing.",
      });
      if (choice === 1) event.preventDefault();
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== win.webContents.getURL()) event.preventDefault();
    });
    session.defaultSession.setPermissionRequestHandler(
      (wc, permission, callback) =>
        callback(
          wc === win.webContents &&
            ["media", "display-capture"].includes(permission),
        ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (wc, permission) =>
        wc === win.webContents &&
        ["media", "display-capture"].includes(permission),
    );
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          if (request.frame !== win.webContents.mainFrame || !selectedSource)
            return callback({});
          const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 0, height: 0 },
          });
          const target = sources.find((s) => s.id === selectedSource);
          if (!target) return callback({});
          callback({
            video: target,
            ...(request.audioRequested ? { audio: "loopback" } : {}),
          });
        } catch {
          callback({});
        }
      },
    );
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Open Record Studio",
          submenu: [
            { role: "about" },
            {
              label: "Licenses & acknowledgements",
              click: async () => {
                const target = app.isPackaged
                  ? path.join(process.resourcesPath, "licenses/index.html")
                  : path.join(here, "../THIRD_PARTY_NOTICES.md");
                const error = await shell.openPath(target);
                if (error)
                  dialog.showErrorBox("Could not open acknowledgements", error);
              },
            },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
    await win.loadFile(path.join(here, "../dist/index.html"));
    win.on("close", (event) => {
      if (recording || exporter) {
        event.preventDefault();
        dialog.showMessageBox(win, {
          message: recording
            ? "Stop the recording before closing."
            : "Cancel or finish the export before closing.",
          type: "info",
        });
      }
    });
    app.on("window-all-closed", () => app.quit());
    app.on("will-quit", () => globalShortcut.unregisterAll());
  })
  .catch((error) => {
    console.error(error);
    dialog.showErrorBox("Open Record Studio could not start", error.message);
    app.quit();
  });
