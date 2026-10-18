import { autoZoomOptions } from "./recording-options.mjs";
import {
  validateTimeMap,
  layerSpans,
  takeOutputSpans,
} from "./webcam-take.mjs";
import { validateRemovedAudio, audioRemovalFilter } from "./audio-edits.mjs";
import { validateInteractions } from "./interactions.mjs";
import { layerRect, validateLayers } from "./canvas-media.mjs";
import {
  perspectiveFilter,
  cursorAt,
  sourceAt,
  sourceRanges,
  cursorPolygon,
} from "./motion.mjs";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { revisionOf } from "./project-store.mjs";
import { cameraStartHold } from "./camera-timing.mjs";
import { normalizeExportOptions } from "./export-settings.mjs";
import { enhanceProjectAudio } from "./enhance-audio.mjs";
import { audioModel, defaultAudioModel } from "./audio-models.mjs";
import {
  screenRenderSize,
  selectVideoEncoder,
  videoEncodingArgs,
} from "./export-performance.mjs";
import { createExportProgress } from "./export-progress.mjs";
import { canRenderScreen, prepareScreen } from "./screen-render.mjs";
import {
  aspectRatios,
  canvasTemplates,
  compositionSize,
  compositionLayout,
} from "./composition.mjs";
export { saveProject } from "./project-store.mjs";

export async function binary(name) {
  for (const p of [
    process.env[`FRAME_${name.toUpperCase()}`],
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .map((d) => path.join(d, name)),
  ].filter(Boolean)) {
    try {
      await access(p);
      return p;
    } catch {}
  }
  throw new Error(
    `${name} is missing. Install FFmpeg with Homebrew: brew install ffmpeg`,
  );
}

export function run(command, args, { signal, onProgress, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      cwd,
    });
    let out = "",
      err = "",
      progressBuffer = "",
      processError;
    child.stdout.on("data", (data) => {
      if (!onProgress) out += data;
      else {
        progressBuffer += data;
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop();
        for (const line of lines)
          if (line.startsWith("out_time_us="))
            onProgress(Number(line.slice(12)) / 1e6);
      }
    });
    child.stderr.on("data", (data) => {
      err = (err + data).slice(-12000);
    });
    // Abort emits error before the child closes. Wait for close so callers
    // can safely remove output directories after cancellation.
    child.on("error", (error) => {
      processError = error;
    });
    child.on("close", (code, exitSignal) =>
      code === 0 && !processError
        ? resolve(out)
        : reject(
            processError ||
              new Error(
                signal?.aborted
                  ? "Export cancelled"
                  : `${path.basename(command)} failed (${exitSignal || code}): ${err.slice(-2500)}`,
              ),
          ),
    );
  });
}

export async function probe(file) {
  const info = JSON.parse(
    await run(await binary("ffprobe"), [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      file,
    ]),
  );
  const video = info.streams.find((s) => s.codec_type === "video");
  const rotation = Number(
    video?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ??
      video?.tags?.rotate ??
      0,
  );
  const portraitRotation = Math.abs((Math.abs(rotation) % 180) - 90) < 0.001;
  let duration = Number(info.format.duration || video?.duration || 0);
  // MediaRecorder's live WebM often lacks a Duration element.
  if (!duration) {
    const packets = await run(await binary("ffprobe"), [
      "-v",
      "error",
      "-show_entries",
      "packet=pts_time,duration_time",
      "-of",
      "csv=p=0",
      file,
    ]);
    for (const line of packets.split("\n")) {
      const [pts, span] = line.split(",").map(Number);
      if (Number.isFinite(pts))
        duration = Math.max(duration, pts + (Number.isFinite(span) ? span : 0));
    }
  }
  return {
    duration,
    width: (portraitRotation ? video?.height : video?.width) || 0,
    height: (portraitRotation ? video?.width : video?.height) || 0,
    audio: info.streams.some((s) => s.codec_type === "audio"),
    video: Boolean(video),
  };
}

export const defaults = {
  aspectRatio: "16:9",
  canvasTemplate: "custom",
  screenFit: "fit",
  background: "#7060a6",
  padding: 0,
  cameraSize: 0.22,
  cameraMargin: 0.035,
  cameraCorner: "bottom-right",
  cameraShape: "circle",
  cameraRoundness: 1,
  cameraFlip: false,
  showCamera: true,
  zoom: 1,
  focusX: 0.5,
  focusY: 0.5,
  speed: 1,
  volume: 1,
  microphoneVolume: 1,
  enhanceAudio: false,
  audioEnhancementModel: defaultAudioModel,
  cameraOffset: 0,
  showCursor: true,
  cursorSize: 1,
  cursorSmoothing: 0.06,
  cursorClicks: true,
};
const finite = (value, min, max, label) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Invalid ${label}`);
  return value;
};

export function validateEdits(edits, duration, assets = {}) {
  if (
    !edits ||
    !Array.isArray(edits.segments) ||
    !edits.segments.length ||
    edits.segments.length > 100
  )
    throw new Error("Keep between 1 and 100 timeline clips");
  let last = -1;
  const segments = edits.segments.map((s) => {
    const start = finite(s.start, 0, duration, "clip start"),
      end = finite(s.end, 0, duration + 0.001, "clip end");
    if (end - start < 0.05 || start < last - 0.001)
      throw new Error(
        "Clips must be ordered, non-overlapping, and at least 0.05 seconds long",
      );
    last = end;
    return { start, end };
  });
  const s = { ...defaults, ...edits.style };
  if (!aspectRatios.includes(s.aspectRatio))
    throw new Error("Invalid aspect ratio");
  if (!["fit", "fill"].includes(s.screenFit))
    throw new Error("Invalid screen fit");
  const template = canvasTemplates.find((t) => t.id === s.canvasTemplate);
  if (
    s.canvasTemplate !== "custom" &&
    (!template || template.ratio !== s.aspectRatio)
  )
    throw new Error("Invalid canvas template or aspect ratio");
  // Older projects stored only a circle/square preset.
  if (edits.style?.cameraRoundness === undefined)
    s.cameraRoundness = s.cameraShape === "square" ? 0 : 1;
  if (!/^#[0-9a-f]{6}$/i.test(s.background))
    throw new Error("Invalid background");
  for (const [key, min, max] of [
    ["padding", 0, 0.2],
    ["cameraSize", 0.1, 0.5],
    ["cameraMargin", 0, 0.2],
    ["cameraRoundness", 0, 1],
    ["zoom", 1, 3],
    ["focusX", 0, 1],
    ["focusY", 0, 1],
    ["speed", 0.5, 2],
    ["volume", 0, 1],
    ["microphoneVolume", 0, 1],
    ["cameraOffset", -60, 60],
    ["cursorSize", 0.5, 3],
    ["cursorSmoothing", 0, 0.15],
  ])
    finite(s[key], min, max, key);
  if (
    !["bottom-right", "bottom-left", "top-right", "top-left"].includes(
      s.cameraCorner,
    ) ||
    !["circle", "square"].includes(s.cameraShape)
  )
    throw new Error("Invalid camera layout");
  s.showCamera = Boolean(s.showCamera);
  if (typeof s.enhanceAudio !== "boolean")
    throw new Error("Invalid audio enhancement");
  audioModel(s.audioEnhancementModel);
  if (typeof s.cameraFlip !== "boolean") throw new Error("Invalid camera flip");
  s.showCursor = Boolean(s.showCursor);
  s.cursorClicks = Boolean(s.cursorClicks);
  if (
    edits.zooms !== undefined &&
    (!Array.isArray(edits.zooms) || edits.zooms.length > 80)
  )
    throw new Error("Keep at most 80 zoom sections");
  let zoomEnd = -1;
  const ids = new Set();
  const zooms = (edits.zooms || []).map((z) => {
    if (
      typeof z.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(z.id) ||
      ids.has(z.id)
    )
      throw new Error("Invalid zoom ID");
    ids.add(z.id);
    const start = finite(z.start, 0, duration, "zoom start"),
      end = finite(z.end, 0, duration + 0.001, "zoom end");
    if (end - start < 0.1 || start < zoomEnd)
      throw new Error("Zoom sections must be ordered and cannot overlap");
    zoomEnd = end;
    if (z.mode !== undefined && !["fixed", "follow"].includes(z.mode))
      throw new Error("Invalid zoom mode");
    const trigger =
      z.trigger ?? (/^auto-\d+$/.test(z.id) ? "event" : undefined);
    if (
      trigger !== undefined &&
      !["click", "typing", "selection", "scroll", "drag", "event"].includes(
        trigger,
      )
    )
      throw new Error("Invalid zoom trigger");
    return {
      id: z.id,
      ...(trigger ? { trigger } : {}),
      ...(z.mode !== undefined ? { mode: z.mode } : {}),
      start,
      end,
      zoom: finite(z.zoom, 1, 3, "zoom scale"),
      focusX: finite(z.focusX, 0, 1, "zoom focus"),
      focusY: finite(z.focusY, 0, 1, "zoom focus"),
      ease: finite(z.ease, 0.1, 2, "zoom easing"),
    };
  });
  const layers = validateLayers(edits.layers, assets, duration);
  const removedAudio = validateRemovedAudio(edits.removedAudio, duration);
  return {
    segments,
    style: s,
    ...(zooms.length ? { zooms } : {}),
    ...(layers.length ? { layers } : {}),
    ...(removedAudio.length ? { removedAudio } : {}),
  };
}

export function outputDuration(edits) {
  return (
    edits.segments.reduce((n, s) => n + s.end - s.start, 0) / edits.style.speed
  );
}

export function validateCursor(cursor, duration) {
  if (cursor == null) return undefined;
  if (
    cursor.clean !== true ||
    !Array.isArray(cursor.samples) ||
    cursor.samples.length > 6000000
  )
    throw new Error("Invalid cursor track");
  let previous = -1;
  const samples = cursor.samples.map((p) => {
    const t = finite(p.t, 0, duration + 1, "cursor time");
    if (t < previous) throw new Error("Cursor samples must be ordered");
    previous = t;
    return {
      t,
      x: finite(p.x, 0, 1, "cursor x"),
      y: finite(p.y, 0, 1, "cursor y"),
      visible: Boolean(p.visible),
      pressed: Boolean(p.pressed),
    };
  });
  return { clean: true, samples };
}

export async function readProject(directory) {
  const root = await realpath(directory);
  const bytes = await readFile(path.join(root, "project.json"), "utf8");
  const p = JSON.parse(bytes);
  if (
    p.version !== 1 ||
    p.kind !== "frame-studio" ||
    typeof p.name !== "string"
  )
    throw new Error("This is not an Open Record Studio project");
  finite(p.duration, 0.05, 86400, "duration");
  if (!p.tracks?.screen) throw new Error("Project has no screen track");
  const tracks = {};
  for (const key of ["screen", "camera", "microphone"]) {
    const t = p.tracks[key];
    if (!t) continue;
    if (typeof t.file !== "string" || path.isAbsolute(t.file))
      throw new Error("Invalid media path");
    const file = await realpath(path.resolve(root, t.file));
    if (!file.startsWith(root + path.sep))
      throw new Error("Media must stay inside its project");
    finite(t.offset ?? 0, -86400, 86400, "track offset");
    const meta = await probe(file);
    if (key !== "microphone" && !meta.video)
      throw new Error(`${key} track has no video`);
    tracks[key] = {
      ...meta,
      ...(["image", "video"].includes(t.sourceKind)
        ? { sourceKind: t.sourceKind }
        : {}),
      ...(typeof t.name === "string" ? { name: t.name.slice(0, 255) } : {}),
      file: t.file,
      offset: t.offset || 0,
    };
  }
  if (
    p.assets !== undefined &&
    (!p.assets ||
      typeof p.assets !== "object" ||
      Array.isArray(p.assets) ||
      Object.keys(p.assets).length > 128)
  )
    throw new Error("Invalid canvas media library");
  const assets = {};
  for (const [id, asset] of Object.entries(p.assets || {})) {
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(id) ||
      !asset ||
      typeof asset.file !== "string" ||
      path.isAbsolute(asset.file) ||
      !["image", "video"].includes(asset.sourceKind)
    )
      throw new Error("Invalid canvas media");
    const file = await realpath(path.resolve(root, asset.file));
    if (!file.startsWith(root + path.sep))
      throw new Error("Media must stay inside its project");
    const meta = await probe(file);
    if (
      !meta.video ||
      !meta.width ||
      !meta.height ||
      (asset.sourceKind === "video" && meta.duration < 0.05)
    )
      throw new Error("Canvas media has no usable visual content");
    assets[id] = {
      file: asset.file,
      name:
        typeof asset.name === "string"
          ? asset.name.slice(0, 255)
          : path.basename(asset.file),
      sourceKind: asset.sourceKind,
      width: meta.width,
      height: meta.height,
      duration: asset.sourceKind === "image" ? 0 : meta.duration,
      audio: meta.audio,
      ...(asset.timeMap
        ? { timeMap: validateTimeMap(asset.timeMap, meta.duration) }
        : {}),
    };
  }
  return {
    ...p,
    tracks,
    assets,
    cursor: validateCursor(p.cursor, p.duration),
    interactions: validateInteractions(p.interactions, p.duration),
    edits: validateEdits(p.edits, p.duration, assets),
    directory: root,
    revision: revisionOf(bytes),
  };
}

function aligned(
  filters,
  index,
  track,
  kind,
  key,
  project,
  edits,
  prefilter = "",
) {
  const n = edits.segments.length,
    isVideo = kind === "v";
  const offset =
    (track.offset || 0) + (key === "camera" ? edits.style.cameraOffset : 0);
  const base = `${key}${kind}`;
  let chain = isVideo ? "setpts=PTS-STARTPTS" : "asetpts=PTS-STARTPTS";
  if (prefilter) chain += `,${prefilter}`;
  if (offset < 0)
    chain += isVideo
      ? `,trim=start=${-offset},setpts=PTS-STARTPTS`
      : ` ,atrim=start=${-offset},asetpts=PTS-STARTPTS`;
  if (offset > 0) {
    if (isVideo) {
      const hold =
        key === "camera" ? cameraStartHold(track, edits.style.cameraOffset) : 0;
      if (hold > 0) chain += `,tpad=start_duration=${hold}:start_mode=clone`;
      if (offset > hold)
        chain += `,tpad=start_duration=${offset - hold}:start_mode=add:color=black`;
    } else chain += `,adelay=${Math.round(offset * 1000)}:all=1`;
  }
  chain += isVideo
    ? `,tpad=stop_duration=${project.duration + 60}:stop_mode=add:color=black`
    : ",apad";
  chain +=
    n > 1
      ? `,${isVideo ? "split" : "asplit"}=${n}${edits.segments.map((_, i) => `[${base}${i}]`).join("")}`
      : `[${base}0]`;
  filters.push(`[${index}:${kind}:0]${chain}`);
  for (let i = 0; i < n; i++) {
    const seg = edits.segments[i];
    filters.push(
      `[${base}${i}]${isVideo ? "trim" : "atrim"}=start=${seg.start}:end=${seg.end},${isVideo ? `setpts=(PTS-STARTPTS)/${edits.style.speed}` : `asetpts=PTS-STARTPTS,atempo=${edits.style.speed}`}[${base}cut${i}]`,
    );
  }
  filters.push(
    `${edits.segments.map((_, i) => `[${base}cut${i}]`).join("")}concat=n=${n}:v=${isVideo ? 1 : 0}:a=${isVideo ? 0 : 1}[${base}out]`,
  );
  return `${base}out`;
}

function takeAligned(filters, index, layer, asset, edits, kind, key, fps) {
  const video = kind === "v",
    spans = takeOutputSpans(edits, layer, asset);
  const total = outputDuration(edits),
    chunks = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at + 0.00001) chunks.push({ start: at, end: span.start });
    chunks.push(span);
    at = span.end;
  }
  if (at < total) chunks.push({ start: at, end: total });
  const used = chunks.filter((c) => c.rate);
  if (used.length)
    filters.push(
      `[${index}:${kind}:0]${video ? "split" : "asplit"}=${used.length}${used.map((_, i) => `[${key}input${i}]`).join("")}`,
    );
  let input = 0;
  const outputs = [];
  for (const [i, c] of chunks.entries()) {
    const length = video
      ? (Math.round(c.end * fps) - Math.round(c.start * fps)) / fps
      : c.end - c.start;
    const out = `${key}part${i}`;
    // Consume zero-frame chunks too, so every split output remains connected.
    if (video && length <= 0) {
      if (c.rate) filters.push(`[${key}input${input++}]nullsink`);
      continue;
    }
    if (!c.rate)
      filters.push(
        video
          ? `color=c=black:s=${asset.width}x${asset.height}:r=${fps}:d=${length},setsar=1[${out}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${length}[${out}]`,
      );
    else {
      let tempo = c.rate,
        tempos = [];
      while (tempo > 2) {
        tempos.push("atempo=2");
        tempo /= 2;
      }
      while (tempo < 0.5) {
        tempos.push("atempo=0.5");
        tempo *= 2;
      }
      tempos.push(`atempo=${tempo}`);
      const mediaEnd = c.mediaStart + (c.end - c.start) * c.rate;
      filters.push(
        video
          ? `[${key}input${input++}]trim=start=${c.mediaStart}:end=${mediaEnd},setpts=(PTS-STARTPTS)/${c.rate},fps=${fps},tpad=stop_duration=0.1:stop_mode=clone,trim=duration=${length},setsar=1,format=yuv420p[${out}]`
          : `[${key}input${input++}]atrim=start=${c.mediaStart}:end=${mediaEnd},asetpts=PTS-STARTPTS,${tempos.join(",")},aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${length}[${out}]`,
      );
    }
    outputs.push(`[${out}]`);
  }
  filters.push(
    `${outputs.join("")}concat=n=${outputs.length}:v=${video ? 1 : 0}:a=${video ? 0 : 1}[${key}out]`,
  );
  return `${key}out`;
}

export function exportArgs(
  project,
  edits,
  options,
  mode,
  destination,
  cursorFiles,
  enhancedAudio = {},
  screenRender,
) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n"];
  const filters = [],
    indexes = {};
  let count = 0;
  const audioIndexes = {};
  for (const key of ["screen", "camera", "microphone"])
    if (project.tracks[key]) {
      indexes[key] = count++;
      args.push("-i", path.join(project.directory, project.tracks[key].file));
    }
  if (options.audio && edits.style.enhanceAudio) {
    for (const [key, file] of Object.entries(enhancedAudio)) {
      audioIndexes[key] = count++;
      args.push("-i", file);
    }
  }
  let cursorIndex;
  let renderedIndex;
  if (screenRender && mode !== "camera") {
    renderedIndex = count++;
    args.push("-i", screenRender.movie);
  }
  if (cursorFiles && mode !== "camera") {
    cursorIndex = count++;
    args.push("-i", cursorFiles.movie);
  }
  const duration = outputDuration(edits),
    s = edits.style,
    size = compositionSize(s, options.height, project.tracks.screen),
    height = mode === "combined" ? size.height : options.height,
    width = size.width;
  const fps = options.fps;
  const copyScreen =
    renderedIndex !== undefined &&
    mode === "screen" &&
    screenRender.height === height;
  let video;
  if (copyScreen) {
    // The GPU already produced the final screen frames. Mux system audio
    // without decoding or encoding this video a second time.
  } else if (mode === "camera") {
    video = aligned(
      filters,
      indexes.camera,
      project.tracks.camera,
      "v",
      "camera",
      project,
      edits,
    );
    filters.push(
      `[${video}]${s.cameraFlip ? "hflip," : ""}scale=-2:${height},setsar=1,fps=${fps},format=yuv420p[vout]`,
    );
  } else {
    const renderSize =
      cursorFiles?.size ||
      screenRenderSize(project, edits, {
        ...options,
        mode: options.mode || mode,
      });
    const resize =
      renderSize.width !== project.tracks.screen.width ||
      renderSize.height !== project.tracks.screen.height
        ? `scale=${renderSize.width}:${renderSize.height}:flags=lanczos`
        : "";
    if (renderedIndex !== undefined) {
      video = "screenfps";
      filters.push(`[${renderedIndex}:v:0]setpts=PTS-STARTPTS[${video}]`);
    } else {
      video = aligned(
        filters,
        indexes.screen,
        project.tracks.screen,
        "v",
        "screen",
        project,
        edits,
        resize,
      );
      filters.push(`[${video}]fps=${fps}[screenfps]`);
      video = "screenfps";
      if (cursorIndex !== undefined) {
        filters.push(
          `[${video}][${cursorIndex}:v]overlay=x=0:y=0:format=yuv420:shortest=1[cursorb]`,
        );
        video = "cursorb";
      }
    }
    const crop =
      renderedIndex !== undefined
        ? "null"
        : perspectiveFilter(edits, fps, project.cursor);
    if (mode === "screen")
      filters.push(
        `[${video}]${crop},scale=-2:${height},setsar=1,fps=${fps},format=yuv420p[vout]`,
      );
    else {
      const { pad, innerWidth, innerHeight, cameraSize, cameraGap } =
        compositionLayout(s, width, height);
      filters.push(
        `color=c=${s.background}:s=${width}x${height}:r=${fps}:d=${duration}[bg]`,
      );
      filters.push(
        `[${video}]${crop},scale=${innerWidth}:${innerHeight}:force_original_aspect_ratio=${s.screenFit === "fill" ? "increase" : "decrease"}:force_divisible_by=2${s.screenFit === "fill" ? `,crop=${innerWidth}:${innerHeight}` : ""},setsar=1,fps=${fps}[screenfit]`,
      );
      filters.push(
        "[bg][screenfit]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1[framed]",
      );
      if (project.tracks.camera && s.showCamera) {
        const cam = aligned(
          filters,
          indexes.camera,
          project.tracks.camera,
          "v",
          "camera",
          project,
          edits,
        );
        const size = cameraSize,
          gap = cameraGap;
        let mask = "";
        const radius = (size * s.cameraRoundness) / 2;
        if (radius > 0) {
          // Signed distance to a rounded square, sampled at pixel centers.
          // A one-pixel alpha edge matches Canvas roundRect antialiasing.
          const dx = `(abs(X+0.5-W/2)-(W/2-${radius}))`,
            dy = `(abs(Y+0.5-H/2)-(H/2-${radius}))`;
          mask = `,format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='255*clip(${radius}+0.5-sqrt(pow(max(${dx},0),2)+pow(max(${dy},0),2))-min(max(${dx},${dy}),0),0,1)'`;
        }
        filters.push(
          `[${cam}]${s.cameraFlip ? "hflip," : ""}crop='min(iw,ih)':'min(iw,ih)',scale=${size}:${size},setsar=1,fps=${fps}${mask}[camfit]`,
        );
        const x = s.cameraCorner.endsWith("right") ? `W-w-${gap}` : `${gap}`,
          y = s.cameraCorner.startsWith("bottom") ? `H-h-${gap}` : `${gap}`;
        filters.push(
          `[framed][camfit]overlay=x=${x}:y=${y}:shortest=1,format=yuv420p[vout]`,
        );
      } else filters.push("[framed]format=yuv420p[vout]");
    }
  }
  const takeAudios = [];
  const activeLayers = (edits.layers || []).filter(
    (l) =>
      l.visible && l.opacity > 0 && sourceRanges(edits, l.start, l.end).length,
  );
  const layers = mode === "combined" ? activeLayers : [];
  const addTakeAudio = (layer, asset, index, key) => {
    if (
      !options.audio ||
      !asset.timeMap ||
      !asset.audio ||
      (layer.volume ?? 1) <= 0
    )
      return;
    const audio = takeAligned(
      filters,
      audioIndexes[`asset-${layer.assetId}`] ?? index,
      layer,
      asset,
      edits,
      "a",
      `${key}audio`,
      fps,
    );
    filters.push(`[${audio}]volume=${layer.volume ?? 1}[${key}mix]`);
    takeAudios.push(`${key}mix`);
  };
  if (layers.length) {
    // Rename the base composition output, then composite in bottom-to-top order.
    const last = filters.length - 1;
    filters[last] = filters[last].replace("[vout]", "[layerbase]");
    let base = "layerbase";
    for (const [i, layer] of layers.entries()) {
      const asset = project.assets[layer.assetId],
        index = count++,
        key = `layer${i}`;
      if (asset.sourceKind === "image")
        args.push("-loop", "1", "-framerate", String(fps));
      args.push("-i", path.join(project.directory, asset.file));
      const stream = asset.timeMap
        ? takeAligned(filters, index, layer, asset, edits, "v", key, fps)
        : aligned(
            filters,
            index,
            { offset: layer.start - layer.mediaStart },
            "v",
            key,
            project,
            edits,
          );
      addTakeAudio(layer, asset, index, key);
      const rect = layerRect(layer, asset, width, height);
      const enable =
        layerSpans(layer, asset)
          .flatMap((span) => sourceRanges(edits, span.start, span.end))
          .map((r) => `gte(t,${r.start})*lt(t,${r.end})`)
          .join("+") || "0";
      let shape = "";
      if (layer.roundness !== undefined) {
        shape = "crop='min(iw,ih)':'min(iw,ih)',";
      }
      let mask = "";
      const radius = (rect.width * (layer.roundness || 0)) / 2;
      if (radius > 0) {
        const dx = `(abs(X+0.5-W/2)-(W/2-${radius}))`,
          dy = `(abs(Y+0.5-H/2)-(H/2-${radius}))`;
        mask = `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(${radius}+0.5-sqrt(pow(max(${dx},0),2)+pow(max(${dy},0),2))-min(max(${dx},${dy}),0),0,1)'`;
      }
      filters.push(
        `[${stream}]${layer.flip ? "hflip," : ""}${shape}scale=${rect.width}:${rect.height},setsar=1,fps=${fps},format=rgba${mask},colorchannelmixer=aa=${layer.opacity}[${key}fit]`,
      );
      const out = i === layers.length - 1 ? "vout" : `${key}base`;
      filters.push(
        `[${base}][${key}fit]overlay=x=${rect.x}:y=${rect.y}:enable='${enable}':eof_action=pass:format=auto[${out}]`,
      );
      base = out;
    }
  }
  if (mode === "camera" && options.audio) {
    for (const [i, layer] of activeLayers.entries()) {
      const asset = project.assets[layer.assetId];
      if (!asset.timeMap || !asset.audio || (layer.volume ?? 1) <= 0) continue;
      let index = audioIndexes[`asset-${layer.assetId}`];
      if (index === undefined) {
        index = count++;
        args.push("-i", path.join(project.directory, asset.file));
      }
      addTakeAudio(layer, asset, index, `take${i}`);
    }
  }
  const audios = [...takeAudios];
  if (options.audio) {
    const sources =
      mode === "screen"
        ? ["screen"]
        : mode === "camera"
          ? ["microphone"]
          : ["screen", "microphone"];
    for (const key of sources)
      if (project.tracks[key]?.audio) {
        const a = aligned(
          filters,
          audioIndexes[key] ?? indexes[key],
          project.tracks[key],
          "a",
          key,
          project,
          edits,
        );
        // Lock the layout before sample-wise removal; amix must not renegotiate
        // aeval's input layout when mixing mono recordings with stereo takes.
        filters.push(
          `[${a}]aresample=48000,aformat=channel_layouts=stereo,volume=${key === "screen" ? s.volume : s.microphoneVolume}${audioRemovalFilter(edits)}[${a}vol]`,
        );
        audios.push(`${a}vol`);
      }
  }
  if (audios.length > 1)
    filters.push(
      audios.map((a) => `[${a}]`).join("") +
        `amix=inputs=${audios.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=0[aout]`,
    );
  else if (audios.length === 1) filters.push(`[${audios[0]}]anull[aout]`);
  if (filters.length) args.push("-filter_complex", filters.join(";"));
  args.push("-map", copyScreen ? `${renderedIndex}:v:0` : "[vout]");
  if (audios.length) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  args.push(
    ...(copyScreen
      ? ["-c:v", "copy"]
      : [...videoEncodingArgs(options), "-pix_fmt", "yuv420p"]),
    "-t",
    String(duration),
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    destination,
  );
  return args;
}

export async function prepareCursor(
  project,
  edits,
  fps,
  temp,
  {
    signal,
    onProgress = () => {},
    frameCount = Math.ceil(outputDuration(edits) * fps),
    size = project.tracks.screen,
  } = {},
) {
  if (!project.cursor?.clean || !edits.style.showCursor) return undefined;
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const p = cursorAt(project.cursor, sourceAt(edits, f / fps), edits.style);
    frames.push({
      x: p?.x ?? 0,
      y: p?.y ?? 0,
      visible: Boolean(p),
      pressed: Boolean(p?.pressed && edits.style.cursorClicks),
    });
  }
  const job = path.join(temp, "cursor.json"),
    movie = path.join(temp, "cursor.mov");
  await writeFile(
    job,
    JSON.stringify({
      width: size.width,
      height: size.height,
      fps: fps,
      scale: (size.width / 1280) * edits.style.cursorSize,
      polygon: cursorPolygon,
      frames,
    }),
  );
  const helper = import.meta.url.includes("app.asar/")
    ? path.join(process.resourcesPath, "frame-cursor")
    : fileURLToPath(new URL("../native/bin/frame-cursor", import.meta.url));
  // A timestamped alpha track keeps pointer and screen frame-accurate even
  // when FFmpeg buffers frames across its overlay/perspective filters.
  onProgress({ ratio: 0, track: "cursor" });
  await run(helper, [job, movie], {
    signal,
    onProgress: (seconds) =>
      onProgress({ ratio: (seconds * fps) / frameCount, track: "cursor" }),
  });
  return { job, movie, size: { width: size.width, height: size.height } };
}

// Render a stable global palette in a separate pass. Splitting the video into
// palettegen/paletteuse in one graph would buffer the entire recording in RAM.
function gifArgs(
  project,
  edits,
  options,
  mode,
  destination,
  cursorFiles,
  palette,
) {
  const args = exportArgs(
    project,
    edits,
    { ...options, audio: false },
    mode,
    destination,
    cursorFiles,
  );
  args.splice(args.indexOf("-map"));
  let index = args.indexOf("-filter_complex");
  if (palette) {
    const input = args.filter((arg) => arg === "-i").length;
    args.splice(index, 0, "-i", palette);
    index += 2;
    args[index + 1] +=
      `;[vout][${input}:v]paletteuse=dither=${options.quality === "high" ? "sierra2_4a" : "bayer"}:diff_mode=rectangle[gifout]`;
    args.push(
      "-map",
      "[gifout]",
      "-an",
      "-c:v",
      "gif",
      "-loop",
      "0",
      "-t",
      String(outputDuration(edits)),
      "-fps_mode",
      "passthrough",
    );
  } else {
    // Analyze every frame: diff-only statistics can miss colors after concat
    // cuts, leaving later clips mapped to unrelated palette entries.
    args[index + 1] +=
      `;[vout]trim=duration=${outputDuration(edits)},palettegen=max_colors=${options.quality === "high" ? 256 : 128}:reserve_transparent=0:stats_mode=full[palette]`;
    args.push(
      "-map",
      "[palette]",
      "-frames:v",
      "1",
      "-an",
      "-c:v",
      "png",
      "-update",
      "1",
    );
  }
  args.push("-progress", "pipe:1", destination);
  return args;
}

export async function exportProject(
  project,
  edits,
  options,
  parent,
  { signal, onProgress = () => {} } = {},
) {
  edits = validateEdits(edits, project.duration, project.assets);
  options = normalizeExportOptions(options);
  if (options.mode !== "combined" && !project.tracks.camera)
    throw new Error("Separate exports require a webcam track");
  const modes =
    options.mode === "combined"
      ? ["combined"]
      : options.mode === "separate"
        ? ["screen", "camera"]
        : ["combined", "screen", "camera"];
  const name =
    (project.name
      .replace(/[^a-z0-9 _-]/gi, "")
      .trim()
      .slice(0, 64) || "Recording") +
    "-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    randomUUID().slice(0, 6);
  const temp = path.join(parent, ".frame-export-" + randomUUID()),
    final = path.join(parent, name);
  await mkdir(temp, { recursive: false });
  const gif = options.format === "gif";
  const nativeScreen = await canRenderScreen(project, options);
  const renderSize = screenRenderSize(project, edits, options);
  const enhance = options.audio && !gif && edits.style.enhanceAudio;
  const cursor =
    !nativeScreen && project.cursor?.clean && edits.style.showCursor;
  const pixels = (renderSize.width * renderSize.height) / (1920 * 1080);
  const stages = [
    ...(enhance ? [{ track: "Enhance Audio", work: 0.25 }] : []),
    ...(cursor ? [{ track: "cursor", work: pixels * 0.12 }] : []),
    ...(nativeScreen ? [{ track: "screen", work: 1 }] : []),
    ...modes.flatMap((mode) => {
      const work =
        mode === "camera"
          ? nativeScreen
            ? 1
            : 0.5
          : nativeScreen
            ? mode === "screen"
              ? 0.03
              : 0.7
            : pixels * (mode === "combined" ? 1.3 : 1);
      return [
        ...(gif ? [{ track: `${mode} colors`, work: work * 0.7 }] : []),
        { track: mode, work },
      ];
    }),
    { track: "finishing", work: 0.03 },
  ];
  const progress = createExportProgress(stages);
  const emit = () =>
    onProgress({ ...progress.snapshot(), encoder: options.encoder });
  const update = (ratio) => {
    progress.update(ratio);
    emit();
  };
  const advance = () => {
    progress.advance();
    emit();
  };
  const heartbeat = setInterval(emit, 1000);
  heartbeat.unref();
  emit();
  try {
    const command = await binary("ffmpeg");
    options.encoder = gif
      ? "gif"
      : await selectVideoEncoder(command, run, signal);
    const enhancedAudio = enhance
      ? await enhanceProjectAudio(project, {
          signal,
          onProgress: update,
          model: edits.style.audioEnhancementModel,
        })
      : {};
    if (enhance) advance();
    const cursorFiles = nativeScreen
      ? undefined
      : await prepareCursor(project, edits, options.fps, temp, {
          signal,
          size: renderSize,
          onProgress: ({ ratio }) => update(ratio),
        });
    if (cursor) advance();
    const screenRender = nativeScreen
      ? await prepareScreen(project, edits, options, temp, run, {
          signal,
          onProgress: update,
        })
      : undefined;
    if (nativeScreen) advance();
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];
      emit();
      const palette = path.join(temp, `palette-${mode}.png`);
      if (gif) {
        emit();
        const args = gifArgs(
          project,
          edits,
          options,
          mode,
          palette,
          cursorFiles,
        );
        const index = args.indexOf("-filter_complex");
        const graph = path.join(temp, `palette-${mode}.txt`);
        await writeFile(graph, args[index + 1]);
        args.splice(index, 2, "-filter_complex_script", graph);
        await run(command, args, {
          signal,
          onProgress: (seconds) =>
            update(Math.min(0.99, seconds / outputDuration(edits))),
        });
        await rm(graph);
        advance();
      }
      const destination = path.join(temp, `${mode}.${options.format}`);
      const args = (gif ? gifArgs : exportArgs)(
        project,
        edits,
        options,
        mode,
        destination,
        cursorFiles,
        gif ? palette : enhancedAudio,
        screenRender,
      );
      const index = args.indexOf("-filter_complex");
      const graph = path.join(temp, `graph-${mode}.txt`);
      if (index >= 0) {
        await writeFile(graph, args[index + 1]);
        args.splice(index, 2, "-filter_complex_script", graph);
      }
      const runOptions = {
        signal,
        onProgress: (seconds) =>
          update(Math.min(0.99, seconds / outputDuration(edits))),
      };
      try {
        await run(command, args, runOptions);
      } catch (error) {
        if (
          signal?.aborted ||
          args[args.indexOf("-c:v") + 1] !== "h264_videotoolbox"
        )
          throw error;
        // Hardware may be available at startup but busy or incompatible with
        // an individual output. Retry this file once with the software encoder.
        await rm(destination, { force: true });
        const index = args.indexOf("-c:v");
        args.splice(
          index,
          args.indexOf("-pix_fmt", index) - index,
          ...videoEncodingArgs({ ...options, encoder: "libx264" }),
        );
        options.encoder = "libx264";
        await run(command, args, runOptions);
      }
      await rm(graph, { force: true });
      if (gif) await rm(palette);
      const meta = await probe(destination);
      if (!meta.video || Math.abs(meta.duration - outputDuration(edits)) > 0.15)
        throw new Error(`${mode} export duration did not match the timeline`);
      advance();
    }
    if (cursorFiles)
      for (const file of [cursorFiles.job, cursorFiles.movie]) await rm(file);
    if (screenRender)
      for (const file of [screenRender.job, screenRender.movie]) await rm(file);
    await writeFile(
      path.join(temp, "export.json"),
      JSON.stringify(
        {
          version: 1,
          project: project.name,
          edits,
          ...(project.interactions
            ? {
                interactions: {
                  ...validateInteractions(
                    project.interactions,
                    project.duration,
                  ),
                  timebase: "source",
                  sourceDuration: project.duration,
                },
                ...(project.recording?.autoZoom
                  ? {
                      recording: {
                        autoZoom: autoZoomOptions(project.recording.autoZoom),
                      },
                    }
                  : {}),
              }
            : {}),
          options,
          duration: outputDuration(edits),
          files: modes.map((m) => `${m}.${options.format}`),
        },
        null,
        2,
      ),
    );
    await rename(temp, final);
    advance();
    return {
      directory: final,
      files: modes.map((m) => path.join(final, `${m}.${options.format}`)),
    };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
