import {
  loadRecordingPreferences,
  saveRecordingPreferences,
  flushRecordingPreferences,
  devicePreference,
  populateDevices,
} from "./recording-preferences";
import {
  defaultAutoZoom,
  type AutoZoomOptions,
} from "../desktop/recording-options.mjs";
import { exportProgressText } from "./export-progress";
import { WebcamTake } from "./webcam-take";
import { CutMedia } from "./cut-media";
import { EnhancedAudio } from "./enhanced-audio";
import { audioModels, audioModel } from "../desktop/audio-models.mjs";
import { attachTooltips } from "./tooltips";
import "./style.css";
import appIconUrl from "../desktop/assets/open-record-studio.png";
import {
  audibleRanges,
  audioRemovedAt,
  mergeRanges,
} from "../desktop/audio-edits.mjs";
import { CanvasMedia } from "./canvas-media";
import { MediaInspector, type MediaTrack } from "./media-inspector";
import { loadFilmstrip, type Filmstrip } from "./filmstrip";
import { TimelineView } from "./timeline-view";
import type { WaveformState } from "./waveform";
import { cameraFrameTime } from "../desktop/camera-timing.mjs";
import { startRecorder } from "./recording";
import { createRecordingPreview } from "./recording-preview";
import { exportFormats } from "../desktop/export-settings.mjs";
import {
  aspectRatios,
  canvasTemplates,
  compositionRatio,
  compositionSize,
  compositionLayout,
  applyCanvasStyle,
} from "../desktop/composition.mjs";
import type {
  Edits,
  Project,
  Style,
  Source,
  ExportOptions,
  Zoom,
  TimeRange,
} from "./types";
import {
  cropAt,
  defaultZoomEase,
  canFollowCursor,
  sourceRanges,
  cursorAt,
  cursorPath,
} from "../desktop/motion.mjs";
import {
  clock,
  duration,
  segmentAt,
  sourceTime,
  removeTimelineRange,
  nextMediaCut,
} from "./timeline";
import { moveZoomRange, zoomDragRange } from "./zoom-gesture";
import { timelineDrag } from "./timeline-drag";
import {
  attachTimelinePinch,
  maxTimelineScale,
  timelineZoomAt,
  timelineInset,
  timelineGutter,
} from "./timeline-viewport";

const icon = (name: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({ image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 5 5 3-3 5 5"/>', volume: '<path d="m11 4-6 5H2v6h3l6 5zM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>', redo: '<path d="M21 6H10a7 7 0 0 0 0 14M21 6l-5-5m5 5-5 5"/>', end: '<path d="m6 5 10 7-10 7zM19 5v14"/>', start: '<path d="m18 5-10 7 10 7zM5 5v14"/>', screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>', camera: '<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-3v10l-5-3"/>', mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>', play: '<path d="m8 5 11 7-11 7z" fill="currentColor"/>', pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>', folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>', download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>', cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 12 12M8 16 20 4"/>', trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>', undo: '<path d="M3 10h11a7 7 0 0 1 0 14M3 10l5-5m-5 5 5 5" transform="translate(0 -4)"/>', save: '<path d="M5 3h12l4 4v14H3V3h2zM7 3v6h10V3M7 21v-8h10v8"/>', plus: '<path d="M12 5v14M5 12h14"/>', sliders: '<path d="M4 7h5m4 0h7M4 17h10m4 0h2"/><circle cx="11" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>', check: '<path d="m5 12 4 4L19 6"/>', layers: '<path d="m12 3 10 5-10 5L2 8zm-9 10 9 5 9-5m-18 5 9 5 9-5"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>', bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>' } as Record<string, string>)[name] || ""}</svg>`;
const api = window.studio;
const $ = <T extends Element = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
let project: Project | null = null,
  edits: Edits | null = null,
  playhead = 0,
  playing = false,
  selected = 0,
  busy = false,
  dirty = false,
  history: Edits[] = [],
  future: Edits[] = [];
type PreviewMode = "combined" | "screen" | "camera";
let previewMode: PreviewMode = "combined";
let activePanel = "appearance";
type SelectionKind = "clip" | "audio" | "zoom" | "media" | "range" | "none";
let selectionKind: SelectionKind = "clip";
let selectedAudio: TimeRange | null = null;
let selectedMediaTrack: MediaTrack | null = "screen";
let selectedZoom = "";
let pickingZoomFocus = "";
let cancelZoomDraft: (() => void) | null = null;
let cancelTimelineGesture: (() => void) | null = null;
let selectedRange: TimeRange | null = null;
let timelineScale = 1;
let trimTotal: number | null = null;
let seekRequested = false;
let scrubFrameTime = 0,
  paintedPreviewTime = 0;
let redraw = true;
let externalChange = false;
let filmstrips: Partial<Record<"screen" | "camera", Filmstrip>> = {};
let thumbnailAbort = new AbortController();
let waveforms: WaveformState = { status: "loading", tracks: {} };
let playbackBase = 0,
  playbackStarted = 0,
  playbackSourceBase = 0;
let playbackMaster: "screen" | "microphone" = "screen";
const media = {
  screen: document.createElement("video"),
  camera: document.createElement("video"),
  microphone: document.createElement("audio"),
};
const liveTakePreview = document.createElement("video");
liveTakePreview.muted = true;
liveTakePreview.playsInline = true;
function connectMedia(el: HTMLMediaElement, key: keyof typeof media) {
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  el.addEventListener("loadedmetadata", () => {
    if (media[key] === el) syncMedia(true);
  });
  el.addEventListener("seeked", () => {
    if (media[key] === el) redraw = true;
  });
  el.addEventListener("loadeddata", () => (redraw = true));
  el.addEventListener("error", () => {
    if (media[key] === el)
      toast(
        "Could not load a media track. Try reopening the project.",
        "error",
      );
  });
  if (el instanceof HTMLVideoElement) {
    el.playsInline = true;
    const presented = () => {
      if (media[key] === el) redraw = true;
      el.requestVideoFrameCallback(presented);
    };
    el.requestVideoFrameCallback(presented);
  }
}
const cutMedia = {
  screen: new CutMedia(media.screen, (el) => connectMedia(el, "screen")),
  camera: new CutMedia(media.camera, (el) => connectMedia(el, "camera")),
  microphone: new CutMedia(media.microphone, (el) =>
    connectMedia(el, "microphone"),
  ),
};
const enhancedAudio = new EnhancedAudio(updateEnhanceStatus, () =>
  syncMedia(true),
);
let sources: Source[] = [],
  sourceId = "",
  recorders: MediaRecorder[] = [],
  streams: MediaStream[] = [],
  recordId = "",
  recordMetadata: Record<string, { startedAt: number }> = {},
  writeQueue: Promise<void> = Promise.resolve(),
  recordError = "",
  stopping = false,
  recordStarted = 0,
  nativeRecording = false,
  timer: ReturnType<typeof setInterval> | null = null;

$("#app").innerHTML = `
<header class="titlebar">
  <div class="brand"><span class="brand-mark">${icon("layers", 17)}</span><span>Open Record Studio</span></div>
  <div class="project-heading"><span class="title-divider"></span><div id="project-title" role="button" tabindex="-1" title="Double-click to rename">Untitled recording</div><input id="project-name" aria-label="Project name" maxlength="120" autocomplete="off" spellcheck="false" hidden/></div>
  <div class="header-actions"><button id="new-recording" class="subtle" data-tooltip="Recording options">${icon("plus", 16)}<span>Record</span></button><button id="add-media" class="subtle" data-tooltip="Add images or videos to this project" disabled>＋ Add media</button><button id="import" class="icon-button" data-tooltip="Start a project from a video or image" aria-label="Import media">${icon("download", 17)}</button><button id="open" class="icon-button" data-tooltip="Open a project" aria-label="Open project">${icon("folder", 17)}</button><span class="action-divider"></span><button id="save" class="icon-button" data-tooltip="Save project" data-shortcut="⌘S" aria-keyshortcuts="Meta+S" aria-label="Save project" disabled>${icon("save", 17)}</button><button id="export" class="primary" data-tooltip="Export video or GIF" disabled>${icon("upload", 16)}Export video</button></div>
</header>
<main class="workspace">
<section class="editor">
  <div class="editor-toolbar"><div class="preview-tabs" role="tablist" aria-label="Preview output"><button data-preview="combined" role="tab" aria-selected="true" class="active">${icon("layers", 14)}Composition</button><button data-preview="screen" role="tab" aria-selected="false">${icon("screen", 14)}Screen</button><button data-preview="camera" role="tab" aria-selected="false">${icon("camera", 14)}Webcam</button></div><div class="preview-meta"><button id="fit" class="subtle" title="Reset screen zoom" disabled>Reset zoom</button></div></div>
  <div class="preview-wrap"><canvas id="preview" width="1280" height="720" aria-label="Video preview"></canvas><div id="welcome"><img class="welcome-symbol" src="${appIconUrl}" alt="Open Record Studio" width="76" height="76" draggable="false"/><span class="welcome-kicker">YOUR NEXT GREAT DEMO STARTS HERE</span><h1>A great recording.<br><span>Every track, yours.</span></h1><p>Capture your screen and camera. Shape the story.<br>Export them together, or keep them separate.</p><div class="welcome-actions"><button id="welcome-record" class="primary">${icon("plus")}New recording</button><button id="welcome-import">${icon("download")}Use video or image</button></div><button id="demo" class="text-button">Explore a sample project <span>→</span></button></div></div>
  <div class="transport"><div class="transport-left"><button id="undo" title="Undo · ⌘Z" aria-label="Undo" disabled>${icon("undo", 16)}</button><button id="redo" title="Redo · ⌘⇧Z" aria-label="Redo" disabled>${icon("redo", 16)}</button><span class="action-divider"></span><button id="split" title="Split at playhead · S" aria-label="Split at playhead" disabled>${icon("cut", 16)}</button><button id="delete" title="Delete selected item · Delete" aria-label="Delete selected clip" disabled>${icon("trash", 16)}</button><button id="remove-range" class="range-cut-button" title="Remove selected time from all tracks · Delete" hidden>${icon("cut", 14)}<span id="range-duration"></span></button></div><div class="play-controls"><button id="back" title="Return to start" aria-label="Return to start" disabled>${icon("start", 14)}</button><button id="play" class="play-button" title="Play · Space" aria-label="Play" disabled>${icon("play", 17)}</button><button id="end" title="Go to end" aria-label="Go to end" disabled>${icon("end", 14)}</button><span id="timecode">00:00.0 <em>/ 00:00.0</em></span></div><div class="timeline-info"><label class="timeline-scale" title="Timeline zoom · Pinch over the timeline">−<input id="timeline-scale" type="range" min="0" max="4" step="0.01" value="0" aria-label="Timeline magnification"/>＋</label><span class="linked-indicator">${icon("layers", 13)}Linked tracks</span><span id="clip-count" class="muted">No clips</span></div></div>
  <div id="timeline-empty"><span>${icon("layers", 20)}</span><div><strong>Your media will appear here</strong><p>Choose a video or image, or start a recording.</p></div></div>
  <div class="timeline-scroll"><div class="timeline" tabindex="-1" title="⌘ drag to select a range · Delete to cut"><div class="ruler"><span>TRACKS</span><div id="ticks"></div></div><div class="track-row"><div class="track-label"><span class="track-symbol screen">${icon("screen", 15)}</span><span id="screen-track-name">Screen</span></div><div id="screen-lane" class="lane"></div></div><div class="track-row"><div class="track-label"><span class="track-symbol camera">${icon("camera", 15)}</span>Webcam</div><div id="camera-lane" class="lane"></div></div><div class="track-row audio-row"><div class="track-label"><span class="track-symbol audio">${icon("volume", 15)}</span>Audio</div><div id="audio-lane" class="lane"></div></div><div class="track-row zoom-row"><div class="track-label"><span class="track-symbol zoom">＋</span>Zoom</div><div id="zoom-lane" class="lane"></div></div><div id="layer-tracks"></div><div class="range-selection-track"><div id="range-selection" role="img" hidden></div></div><div id="playhead" class="playhead"><i></i></div><input id="scrubber" type="range" min="0" max="1" step="0.01" value="0" aria-label="Timeline playhead" disabled></div></div>
  <footer class="editor-footer"><span><i class="status-dot"></i><span id="save-state">Ready when you are</span><button id="reload-project" class="text-button" hidden>Reload</button></span><span><kbd>Space</kbd> Play / pause <b>·</b> <kbd>S</kbd> Split <b>·</b> <kbd>⌘Z</kbd> Undo</span></footer>
</section>
<aside class="inspector"><nav class="inspector-tabs" role="tablist" aria-label="Editor settings" aria-orientation="horizontal">${[
  ["appearance", "image", "Canvas"],
  ["camera", "camera", "Camera"],
  ["audio", "volume", "Audio"],
  ["motion", "bolt", "Motion"],
  ["clip", "cut", "Timing"],
  ["media", "layers", "Media"],
]
  .map(
    ([id, ico, label], i) =>
      `<button id="tab-${id}" data-panel="${id}" role="tab" aria-controls="panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" title="${label}" aria-label="${label}" class="${i === 0 ? "active" : ""}">${icon(ico, 17)}<span>${label}</span></button>`,
  )
  .join("")}</nav>
<div class="inspector-body"><div id="settings" class="settings disabled">
<div id="panel-appearance" class="settings-panel" role="tabpanel" aria-labelledby="tab-appearance">
  <section class="canvas-settings"><h3>Format <span class="section-value" id="canvas-size">1920 × 1080</span></h3><label class="field-caption" for="canvasTemplate">Template</label><select id="canvasTemplate" class="wide-select"><option value="custom">Custom canvas</option>${canvasTemplates.map((t) => `<option value="${t.id}">${t.name} · ${t.ratio}</option>`).join("")}</select><div class="ratio-picker" role="group" aria-label="Project aspect ratio">${aspectRatios.map((r) => `<button data-ratio="${r}" aria-pressed="false" title="${r === "source" ? "Match screen media" : r + " canvas"}"><i style="aspect-ratio:${r === "source" ? "16/9" : r.replace(":", "/")}"></i><span>${r === "source" ? "Source" : r}</span></button>`).join("")}</div><label class="field-caption" for="screenFit">Screen placement</label><select id="screenFit" class="wide-select"><option value="fit">Fit · show entire media</option><option value="fill">Fill · crop to canvas</option></select></section>
  <section><h3>Background</h3><div class="swatches">${[
    ["#7060a6", "Lavender"],
    ["#465e8b", "Blue hour"],
    ["#c27862", "Terracotta"],
    ["#518579", "Sage"],
    ["#d0c4ac", "Sand"],
    ["#202127", "Graphite"],
  ]
    .map(
      ([c, name]) =>
        `<button class="swatch" data-color="${c}" style="--swatch:${c}" title="${name}" aria-label="${name} background" aria-pressed="false"><span></span>${icon("check", 13)}</button>`,
    )
    .join(
      "",
    )}</div><div class="color-field"><label for="background">Custom color</label><div><input id="background" type="color" value="#7060a6" aria-label="Custom background color"/><span id="color-value">#7060A6</span></div></div></section>
  <section><h3>Framing</h3><label class="range-label" for="padding">Padding <output id="padding-value">0%</output></label><input id="padding" type="range" min="0" max="0.2" step="0.005" value="0"/></section>
  <section><h3>Screen zoom <button id="reset-zoom" class="text-reset" title="Reset zoom and focus">Reset</button></h3><label class="range-label" for="zoom">Scale <output id="zoom-value">1×</output></label><input id="zoom" type="range" min="1" max="3" step="0.05" value="1"/><button id="open-motion" class="wide-button">Animated zoom & cursor →</button></section>

</div>
<div id="panel-camera" class="settings-panel" role="tabpanel" aria-labelledby="tab-camera" hidden>
  <section><h3>Camera overlay<label class="switch"><input id="showCamera" type="checkbox" aria-label="Show webcam overlay" checked/><span></span></label></h3></section>
  <section><h3>Orientation</h3><label class="check-row"><input id="cameraFlip" type="checkbox"/>Flip horizontally</label></section>
  <section><h3>Shape</h3><div class="shape-picker" role="group" aria-label="Webcam shape"><button data-shape="circle" aria-pressed="true"><i class="shape-circle"></i>Circle</button><button data-shape="square" aria-pressed="false"><i class="shape-square"></i>Square</button></div><select id="cameraShape" aria-label="Webcam shape" hidden><option value="circle">Circle</option><option value="square">Square</option></select><label class="range-label" for="cameraRoundness">Roundness <output id="cameraRoundness-value">100%</output></label><input id="cameraRoundness" type="range" min="0" max="1" step="0.01" value="1"/></section>
  <section><h3>Position</h3><div class="position-picker" role="group" aria-label="Webcam position">${["top-left", "top-right", "bottom-left", "bottom-right"].map((c) => `<button data-corner="${c}" title="${c.replace("-", " ")}" aria-label="${c.replace("-", " ")}" aria-pressed="false"><span class="position-dot ${c}"></span></button>`).join("")}</div><select id="cameraCorner" aria-label="Webcam position" hidden><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option><option value="top-right">Top right</option><option value="top-left">Top left</option></select><label class="range-label" for="cameraSize">Size <output id="cameraSize-value">22%</output></label><input id="cameraSize" type="range" min="0.1" max="0.5" step="0.01" value="0.22"/><label class="range-label" for="cameraMargin">Margin <output id="cameraMargin-value">3.5%</output></label><input id="cameraMargin" type="range" min="0" max="0.2" step="0.005" value="0.035"/></section>
  <section><h3>Synchronization</h3><div class="field-row"><label for="cameraOffset">Camera offset</label><div class="unit-input"><input id="cameraOffset" type="number" step="0.01" min="-60" max="60" value="0"/><span>s</span></div></div></section>
</div>
<div id="panel-audio" class="settings-panel" role="tabpanel" aria-labelledby="tab-audio" hidden>
  <section class="audio-enhancement"><h3><label for="enhanceAudio">Enhance Audio</label><label class="switch" title="Reduce background noise in speech"><input id="enhanceAudio" type="checkbox"/><span></span></label></h3>
    <details id="audio-advanced"><summary>Advanced</summary><label class="audio-model-label" for="audioEnhancementModel">Model</label><select id="audioEnhancementModel" aria-describedby="audio-model-description">${audioModels.map((model) => `<option value="${model.id}">${model.name}</option>`).join("")}</select><p id="audio-model-description"></p><p class="audio-model-note">Applies to preview and export. Your audio stays on this Mac.</p></details>
    <div id="enhance-audio-status" role="status" hidden></div><button id="retry-enhance-audio" class="text-button" hidden>Retry</button></section>
  <section><h3>${icon("screen", 16)}Screen audio</h3><label class="range-label" for="volume">Volume <output id="volume-value">100%</output></label><input id="volume" type="range" min="0" max="1" step="0.05" value="1"/></section>
  <section><h3>${icon("mic", 16)}Microphone</h3><label class="range-label" for="microphoneVolume">Volume <output id="microphoneVolume-value">100%</output></label><input id="microphoneVolume" type="range" min="0" max="1" step="0.05" value="1"/></section>

</div>
<div id="panel-motion" class="settings-panel" role="tabpanel" aria-labelledby="tab-motion" hidden>
<section class="zoom-editor">
  <div class="zoom-toolbar"><select id="zoom-selector" aria-label="Zoom section"><option value="" disabled>Select zoom</option></select><button id="add-zoom" class="icon-button" title="Add zoom at playhead" aria-label="Add zoom">${icon("plus", 15)}</button><button id="remove-zoom" class="icon-button" title="Remove selected zoom" aria-label="Remove zoom" disabled>${icon("trash", 15)}</button></div>
  <fieldset id="zoom-settings" disabled>
    <div class="zoom-movement"><label for="zoom-mode">Mode</label><select id="zoom-mode"><option value="follow">Follow mouse</option><option value="fixed">Fixed focus</option></select><button id="pick-zoom-focus" class="icon-button" title="Choose focus in preview" aria-label="Choose focus in preview" aria-pressed="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="6"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/></svg></button></div>
    <label class="range-label" for="section-zoom">Scale <output id="section-zoom-value">2×</output></label><input id="section-zoom" type="range" min="1" max="3" step=".05" value="2"/>
    <label class="range-label" for="section-ease">Ease in &amp; out <output id="section-ease-value">${defaultZoomEase}s</output></label><input id="section-ease" type="range" min=".1" max="2" step=".05" value="${defaultZoomEase}"/>
    <div class="clip-fields"><label for="zoom-start">Source in<input id="zoom-start" type="number" min="0" step=".1"/></label><label for="zoom-end">Source out<input id="zoom-end" type="number" min=".1" step=".1"/></label></div>
  </fieldset>
</section>
<section><h3>Cursor <label class="switch"><input id="showCursor" type="checkbox" aria-label="Show cursor" checked/><span></span></label></h3><div id="cursor-settings"><label class="range-label" for="cursorSize">Size <output id="cursorSize-value">1×</output></label><input id="cursorSize" type="range" min=".5" max="3" step=".1" value="1"/><label class="range-label" for="cursorSmoothing">Smoothing <output id="cursorSmoothing-value">60ms</output></label><input id="cursorSmoothing" type="range" min="0" max=".15" step=".01" value=".06"/><label class="check-row"><input id="cursorClicks" type="checkbox" checked/>Highlight clicks</label></div></section>
</div>
<div id="panel-clip" class="settings-panel" role="tabpanel" aria-labelledby="tab-clip" hidden>
  <section><h3>Selected clip <span class="section-value" id="selected-clip-label">Clip 1</span></h3><div class="clip-fields"><label for="trim-start">Source in<input id="trim-start" type="number" min="0" step="0.1"/></label><label for="trim-end">Source out<input id="trim-end" type="number" min="0.05" step="0.1"/></label></div></section>
  <section><h3>Playback</h3><div class="field-row"><label for="speed">Project speed</label><select id="speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></div></section>
</div>
<div id="panel-media" class="settings-panel" role="tabpanel" aria-labelledby="tab-media" hidden>
  <div class="media-toolbar"><div class="media-view-tabs" role="tablist" aria-label="Media view"><button id="media-properties-tab" role="tab" aria-selected="true" aria-controls="media-properties-view">Properties</button><button id="media-library-tab" role="tab" aria-selected="false" aria-controls="media-library-view" tabindex="-1">All media <span id="media-count">0</span></button></div><button id="add-layer" class="media-add-button" title="Add images or videos to the canvas" aria-label="Add media to canvas">＋ Add</button></div>
  <div id="media-properties-view" role="tabpanel" aria-labelledby="media-properties-tab"><section id="media-source-settings" hidden></section><section id="layer-settings" hidden></section></div>
  <div id="media-library-view" role="tabpanel" aria-labelledby="media-library-tab" hidden><section class="media-library"><div id="media-empty"><div class="media-empty-icon">${icon("layers", 26)}</div><h3>Bring your story in</h3><button id="media-start" class="wide-button">${icon("download", 16)}Choose a file</button></div><div id="media-sources"><h3 class="library-group-title">Source tracks</h3><div id="media-list" class="media-list"></div><div id="media-additions"><button id="attach-camera" class="text-button">${icon("plus", 13)}Add webcam video</button></div></div><div id="canvas-layers"></div></section></div>
</div>
</div><div class="inspector-bottom"><button id="projects-folder" class="text-button">${icon("folder", 15)}Projects folder</button></div></div></aside></main><div id="toast" role="status" aria-live="polite"></div>
<div id="record-menu" popover><button id="record-new-screen">${icon("screen", 16)}New screen recording</button><button id="record-webcam-here">${icon("camera", 16)}<span>Record webcam here</span><span id="record-webcam-time"></span></button></div>
<dialog id="projects-dialog"><div class="dialog-header"><h2>Projects folder</h2><button class="close-dialog" aria-label="Close">${icon("close")}</button></div><p class="dialog-copy">New recordings and imports are saved here automatically. Choose once, then start creating.</p><p id="projects-path" class="folder-path"></p><div class="dialog-footer"><span>Change this anytime.</span><button id="choose-projects-folder" class="primary">Choose folder</button></div></dialog>
<dialog id="record-dialog" aria-labelledby="record-title">
  <div class="dialog-header"><h2 id="record-title">New recording</h2><button class="close-dialog" aria-label="Close">${icon("close")}</button></div>
  <div class="capture-toolbar"><div class="capture-tabs" role="tablist" aria-label="Capture type"><button id="capture-screen-tab" data-source-filter="screen" role="tab" aria-selected="true" aria-controls="source-list">${icon("screen", 15)}Screen</button><button id="capture-window-tab" data-source-filter="window" role="tab" aria-selected="false" aria-controls="source-list" tabindex="-1">${icon("layers", 15)}Window</button></div><button id="refresh-sources" class="icon-button" title="Refresh sources" aria-label="Refresh sources"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 17.9 17"/></svg></button></div>
  <div id="source-list" class="source-grid" role="tabpanel" aria-labelledby="capture-screen-tab" aria-busy="true"></div>
  <div class="capture-inputs">
    <div class="capture-input">${icon("camera", 17)}<label for="record-camera">Camera</label><select id="record-camera"><option value="">Off</option></select></div>
    <div class="capture-input">${icon("mic", 17)}<label for="record-microphone">Microphone</label><select id="record-microphone"><option value="">Off</option></select></div>
    <div class="capture-input">${icon("volume", 17)}<label for="record-system">System audio</label><label class="switch" title="Include sound from your Mac"><input type="checkbox" id="record-system" aria-label="System audio"/><span></span></label></div>
  </div>
  <p id="record-camera-error" role="alert" hidden></p>
  <details class="record-advanced"><summary>Advanced ${icon("sliders", 14)}</summary><div class="auto-zoom-heading">Automatic zooms</div><div class="auto-zoom-options">${Object.entries(
    {
      typing: "Typing",
      selection: "Text selection",
      click: "Clicks",
      scroll: "Scrolling",
      drag: "Dragging",
    },
  )
    .map(
      ([kind, label]) =>
        `<label class="auto-zoom-option">${label}<span class="switch"><input data-auto-zoom="${kind}" type="checkbox" aria-label="Automatic zooms on ${label.toLowerCase()}" ${defaultAutoZoom[kind as keyof AutoZoomOptions] ? "checked" : ""}/><span></span></span></label>`,
    )
    .join(
      "",
    )}</div><span class="auto-zoom-note">All activity stays in your metadata.</span></details>
  <div class="interaction-setup" hidden>${icon("bolt", 15)}<span id="interaction-access-status" role="status"></span><button id="interaction-enable" class="text-button">Allow access</button></div>
  <div class="dialog-footer"><button id="record-use-media" class="text-button" title="Start a project from a video or image">${icon("image", 16)}Import media</button><span id="record-status" class="sr-only" role="status"></span><button id="start-record" class="primary" title="Record · stop with ⌘⇧2" disabled><span class="record-dot"></span>Record</button></div>
</dialog>
<dialog id="export-dialog"><div class="dialog-header"><div><span class="eyebrow">EXPORT</span><h2>Your export. Your tracks.</h2></div><button class="close-dialog" aria-label="Close">${icon("close")}</button></div><div class="export-format-row"><label for="export-format">Format</label><select id="export-format"><option value="mp4">MP4 video</option><option value="gif">Animated GIF</option></select><span class="hint" id="export-format-note">Video with optional audio.</span></div><div class="export-modes"><label class="export-card"><input type="radio" name="mode" value="combined" checked/><span class="export-icon">${icon("layers", 24)}</span><strong id="combined-export-label">Combined video</strong><span>Your finished composition, in one file.</span></label><label class="export-card" id="separate-card"><input type="radio" name="mode" value="separate"/><span class="export-icon">${icon("screen", 24)}${icon("camera", 24)}</span><strong>Separate tracks</strong><span id="separate-export-description">Full-frame screen and webcam MP4s.</span><b>IN SYNC</b></label><label class="export-card" id="both-card"><input type="radio" name="mode" value="both"/><span class="export-icon">${icon("plus", 24)}</span><strong>Both</strong><span>The composition plus both tracks.</span></label></div><p class="hint export-note">Separate files share your cuts, playback speed, and timing. Screen zoom is applied; backgrounds and the webcam crop are excluded.</p><p class="hint" id="export-dimensions"></p><div class="export-options"><label>Resolution<select id="export-height"><option value="720">720p</option><option value="1080" selected>1080p</option><option value="2160">4K</option></select></label><label>Frame rate<select id="export-fps"><option value="30">30 fps</option><option value="60" selected>60 fps</option></select></label><label>Quality<select id="export-quality"><option value="high">High</option><option value="standard">Standard</option></select></label></div><label class="check-row" id="export-audio-row"><input type="checkbox" id="export-audio" checked/><span id="export-audio-label">Include audio</span></label><div id="export-progress" hidden><div class="progress-track"><div></div></div><div class="export-progress-details" role="status"><span id="export-progress-label">Preparing export…</span><span id="export-progress-time">Estimating time…</span></div></div><div class="dialog-footer"><span id="export-summary">H.264 · MP4</span><button id="cancel-export" hidden>Cancel export</button><button id="start-export" class="primary">${icon("upload")}Export video</button></div></dialog>
<div id="recording-banner" hidden><span class="record-dot"></span><strong>Recording</strong><span id="record-clock">00:00.0</span><button id="stop-record">${icon("stop", 16)}Stop & edit</button></div>`;

attachTooltips($(".header-actions"));

let namingProject: Project | null = null;
let renaming: Promise<boolean> | null = null;
let saving = false;
const nameInput = $<HTMLInputElement>("#project-name");
function endRename() {
  namingProject = null;
  nameInput.hidden = true;
  nameInput.disabled = false;
  $("#project-title").hidden = false;
}
function beginRename() {
  if (!project || busy || recordId || renaming || saving) return;
  pause();
  namingProject = project;
  nameInput.value = project.name;
  $("#project-title").hidden = true;
  nameInput.hidden = false;
  nameInput.focus();
  nameInput.select();
}
function commitRename(): Promise<boolean> {
  if (renaming) return renaming;
  const p = namingProject;
  if (!p) return Promise.resolve(true);
  const name = nameInput.value.trim();
  if (
    !name ||
    name.length > 120 ||
    /[/\\\x00-\x1f]/.test(name) ||
    /^\.+$/.test(name)
  ) {
    toast("Use a project name of 1–120 characters without slashes.", "error");
    nameInput.focus();
    return Promise.resolve(false);
  }
  if (name === p.name) {
    endRename();
    return Promise.resolve(true);
  }
  nameInput.disabled = true;
  renaming = (async () => {
    try {
      const result = await api.renameProject(p.id, name, p.revision);
      p.name = result.name;
      p.revision = result.revision;
      endRename();
      update();
      return true;
    } catch (e) {
      nameInput.disabled = false;
      nameInput.focus();
      error(e);
      return false;
    } finally {
      renaming = null;
    }
  })();
  return renaming;
}
$("#project-title").ondblclick = beginRename;
$("#project-title").onkeydown = (event) => {
  if (event.key === "Enter" || event.key === "F2") {
    event.preventDefault();
    event.stopPropagation();
    beginRename();
  }
};
nameInput.onblur = () => {
  if (!renaming && !nameInput.disabled) void commitRename();
};
nameInput.onkeydown = (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    endRename();
    $("#project-title").focus();
  } else if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    void commitRename();
  }
};
function showProjectsFolder(folder: string | null) {
  $("#projects-path").textContent = folder || "No folder selected yet";
  $("#choose-projects-folder").textContent = folder
    ? "Change folder"
    : "Choose folder";
}
$("#projects-folder").onclick = () =>
  task(async () => {
    if (busy || recordId) return;
    pause();
    showProjectsFolder(await api.projectsFolder());
    modal("#projects-dialog");
  });
$("#choose-projects-folder").onclick = () =>
  task(async () => {
    const button = $<HTMLButtonElement>("#choose-projects-folder");
    button.disabled = true;
    try {
      const folder = await api.chooseProjectsFolder();
      if (folder) showProjectsFolder(folder);
    } finally {
      button.disabled = false;
    }
  });

const timelineView = new TimelineView(icon);
const timelineScroll = $(".timeline-scroll"),
  timelineHead = $("#playhead");
const refreshTimelineViewport = frameLatest(() => renderTimeline());
let timelineLaneWidth = 0,
  timelineViewportWidth = 0,
  timelineScrollLeft = 0,
  timelineZoomingUntil = 0;
new ResizeObserver(([entry]) => {
  timelineViewportWidth = entry.contentRect.width;
  syncTimelineScaleControl();
  refreshTime();
}).observe(timelineScroll);
new ResizeObserver(([entry]) => {
  timelineLaneWidth = entry.contentRect.width;
  refreshTime();
  renderTimeline();
}).observe($("#screen-lane"));
timelineScroll.addEventListener(
  "scroll",
  () => {
    timelineScrollLeft = timelineScroll.scrollLeft;
    refreshTimelineViewport.push(null);
  },
  { passive: true },
);
function scrollTimeline(left: number) {
  timelineScrollLeft = Math.max(
    0,
    Math.min(left, timelineViewportWidth * (timelineScale - 1)),
  );
  timelineScroll.scrollLeft = timelineScrollLeft;
}
// Coalesce a high-frequency pointer stream into one edit per animation frame.
// Flush the final value synchronously on pointer-up so undo/save sees it.
function frameLatest<T>(apply: (value: T) => void) {
  let frame = 0,
    value: T;
  const flush = () => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
    apply(value);
  };
  return {
    push(next: T) {
      value = next;
      if (!frame) frame = requestAnimationFrame(flush);
    },
    flush,
  };
}
function toast(message: string, type = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = "visible " + type;
  setTimeout(() => el.classList.remove("visible"), 5500);
}
function error(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), "error");
}
async function task<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    error(e);
  }
}
function modal(id: string) {
  $<HTMLDialogElement>(id).showModal();
}
document.querySelectorAll(".close-dialog").forEach((b) =>
  b.addEventListener("click", () => {
    if (!busy) (b.closest("dialog") as HTMLDialogElement).close();
  }),
);
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  }),
);
function selectItem(kind: SelectionKind) {
  selectionKind = kind;
  if (kind !== "range") selectedRange = null;
  if (kind !== "audio") selectedAudio = null;
  if (kind !== "zoom") {
    selectedZoom = "";
    pickingZoomFocus = "";
  }
  if (kind !== "media") canvasMedia.clearSelection();
}
function normalizeSelection() {
  if (!edits) {
    selectionKind = "none";
    return;
  }
  selected = Math.min(selected, edits.segments.length - 1);
  if (selectionKind === "range" && !selectedRange) selectionKind = "none";
  if (selectionKind === "media" && !canvasMedia.selected)
    selectionKind = "none";
  if (
    selectionKind === "zoom" &&
    !edits.zooms?.some((z) => z.id === selectedZoom)
  )
    selectionKind = "none";
  if (selectionKind === "audio") {
    selectedAudio =
      audibleRanges(edits, edits.segments[selected]).find(
        (r) =>
          selectedAudio &&
          r.start < selectedAudio.end &&
          r.end > selectedAudio.start,
      ) || null;
    if (!selectedAudio) selectionKind = "none";
  }
}
function refreshDeleteControl() {
  normalizeSelection();
  const button = $<HTMLButtonElement>("#delete");
  button.disabled =
    !edits ||
    selectionKind === "none" ||
    (selectionKind === "clip" && edits.segments.length <= 1);
  const label =
    selectionKind === "media" && canvasMedia.selectedPart === "audio"
      ? "Mute selected take audio"
      : selectionKind === "range"
        ? "Cut selected time from all tracks"
        : `Delete selected ${selectionKind === "none" ? "item" : selectionKind}`;
  button.setAttribute("aria-label", label);
  button.title = `${label} · Delete`;
}
function recordHistory(snapshot = edits) {
  if (!snapshot) return;
  history.push(structuredClone(snapshot));
  if (history.length > 80) history.shift();
  future = [];
}
function changed(interactive = false) {
  dirty = true;
  if (!interactive || !edits || !project) {
    update();
    return;
  }
  redraw = true;
  $("#project-title").textContent = project.name + " •";
  $("#save-state").textContent = externalChange
    ? "Project updated on disk"
    : "Unsaved changes";
  $<HTMLButtonElement>("#undo").disabled = !history.length;
  $<HTMLButtonElement>("#redo").disabled = !future.length;
  updateClipFields();
  mediaInspector.update();
  updateMotion();
  renderTimeline();
  $<HTMLInputElement>("#scrubber").max = String(duration(edits));
  refreshTime();
}
function undo() {
  cancelTimelineGesture?.();
  if (!edits || !history.length) return;
  pause();
  future.push(structuredClone(edits));
  edits = history.pop()!;
  selectedRange = null;
  selected = Math.min(selected, edits.segments.length - 1);
  changed();
  syncMedia(true);
}
function redo() {
  cancelTimelineGesture?.();
  if (!edits || !future.length) return;
  pause();
  history.push(structuredClone(edits));
  edits = future.pop()!;
  selectedRange = null;
  changed();
  syncMedia(true);
}
function setStyle<K extends keyof Style>(
  key: K,
  value: Style[K],
  remember = true,
) {
  if (!edits) return;
  pause();
  if (remember) recordHistory();
  const oldSpeed = edits.style.speed;
  if (key === "speed" && selectionKind === "range") selectItem("none");
  edits.style = applyCanvasStyle(edits.style, { [key]: value });
  if (key === "cameraShape")
    edits.style.cameraRoundness = value === "circle" ? 1 : 0;
  if (key === "cameraRoundness")
    edits.style.cameraShape = value === 1 ? "circle" : "square";
  if (key === "speed") playhead = (playhead * oldSpeed) / edits.style.speed;
  changed();
  syncMedia(true);
}
async function save() {
  if (!edits || !project || saving || !(await commitRename())) return;
  const savingProject = project;
  const snapshot = JSON.stringify(edits);
  saving = true;
  let revision: string;
  try {
    revision = await api.save(edits, project.revision);
  } finally {
    saving = false;
  }
  if (project !== savingProject) return;
  project.revision = revision;
  dirty = JSON.stringify(edits) !== snapshot;
  externalChange = false;
  update();
  toast("Project saved");
}
async function canReplace() {
  if (!(await commitRename()) || saving) return false;
  if (!dirty) return true;
  return confirm("You have unsaved edits. Continue without saving them?");
}
async function load(p: Project | null) {
  if (!p) return;
  cancelTimelineGesture?.();
  cancelZoomDraft?.();
  pause();
  enhancedAudio.reset();
  endRename();
  project = p;
  selectedMediaTrack = "screen";
  externalChange = false;
  Object.values(cutMedia).forEach((track) => track.reset());
  playbackSegment = -1;
  edits = structuredClone(p.edits);
  selectedZoom = "";
  selectedAudio = null;
  selectedRange = null;
  selectionKind = "clip";
  redraw = true;
  playhead = scrubFrameTime = paintedPreviewTime = 0;
  setTimelineScale(1);
  selected = 0;
  history = [];
  future = [];
  dirty = false;
  thumbnailAbort.abort();
  thumbnailAbort = new AbortController();
  filmstrips = {};
  waveforms = { status: "loading", tracks: {} };
  if (p.tracks.screen.audio || p.tracks.microphone?.audio) {
    void api
      .waveforms(p.id)
      .then((tracks) => {
        if (project !== p) return;
        waveforms = { status: "ready", tracks };
        renderTimeline();
      })
      .catch(() => {
        if (project !== p) return;
        waveforms = { status: "error", tracks: {} };
        renderTimeline();
      });
  }
  previewMode = "combined";
  for (const key of ["screen", "camera"] as const) {
    const track = p.tracks[key];
    if (!track) continue;
    const signal = thumbnailAbort.signal;
    void loadFilmstrip(track.url, track.duration, signal)
      .then((frames) => {
        if (signal.aborted) return;
        filmstrips[key] = frames;
        renderTimeline();
      })
      .catch(() => {});
  }
  for (const key of ["screen", "camera", "microphone"] as const) {
    const track = p.tracks[key],
      el = media[key];
    el.pause();
    el.removeAttribute("src");
    if (track) el.src = track.url;
    el.load();
  }
  $("#welcome").hidden = true;
  $("#preview").classList.add("loaded");
  update();
  syncMedia(true);
}
function update() {
  redraw = true;
  canvasMedia.update();
  const has = Boolean(project && edits);
  $(".timeline-scroll").hidden = !has;
  $("#timeline-empty").hidden = has;
  const trackName = project?.tracks.screen.sourceKind ? "Media" : "Screen";
  if ($("#screen-track-name").textContent !== trackName)
    $("#screen-track-name").textContent = trackName;
  $("#camera-lane").closest<HTMLElement>(".track-row")!.hidden =
    !project?.tracks.camera;
  $("#audio-lane").closest<HTMLElement>(".track-row")!.hidden = !(
    project?.tracks.screen.audio || project?.tracks.microphone?.audio
  );
  for (const id of [
    "save",
    "export",
    "play",
    "back",
    "end",
    "split",
    "scrubber",
    "fit",
  ])
    $<HTMLButtonElement>("#" + id).disabled = !has;
  refreshDeleteControl();
  $<HTMLButtonElement>("#undo").disabled = !history.length;
  $<HTMLButtonElement>("#redo").disabled = !future.length;
  $("#settings").classList.toggle("disabled", !has && activePanel !== "media");
  $("#settings").inert = !has && activePanel !== "media";
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-preview]",
  )) {
    button.disabled =
      !has || (button.dataset.preview === "camera" && !project?.tracks.camera);
    button.classList.toggle("active", button.dataset.preview === previewMode);
    button.setAttribute(
      "aria-selected",
      String(button.dataset.preview === previewMode),
    );
    button.tabIndex = button.dataset.preview === previewMode ? 0 : -1;
  }
  $("#project-title").tabIndex = has ? 0 : -1;
  $("#project-title").setAttribute("aria-disabled", String(!has));
  $("#project-title").textContent = project
    ? project.name + (dirty ? " •" : "")
    : "Untitled recording";
  $("#save-state").textContent = project
    ? externalChange
      ? "Project updated on disk"
      : dirty
        ? "Unsaved changes"
        : "All changes saved"
    : "Ready when you are";
  $("#reload-project").hidden = !externalChange;
  if (!project || !edits) {
    mediaInspector.update();
    return;
  }
  const total = duration(edits);
  playhead = Math.min(playhead, total);
  const s = edits.style;
  enhancedAudio.configure(project, edits);
  updateEnhanceStatus();
  const previewTrack =
    previewMode === "camera" ? project.tracks.camera! : project.tracks.screen;
  const ratio =
    previewMode === "combined"
      ? compositionRatio(s, project.tracks.screen)
      : previewTrack.width / previewTrack.height;
  const preview = $<HTMLCanvasElement>("#preview");
  const previewSize =
    previewMode === "combined"
      ? compositionSize(s, 720, project.tracks.screen)
      : { width: Math.round(720 * ratio), height: 720 };
  if (preview.width !== previewSize.width) preview.width = previewSize.width;
  if (preview.height !== previewSize.height)
    preview.height = previewSize.height;
  preview.style.aspectRatio = String(ratio);
  const size = compositionSize(s, 1080, project.tracks.screen);
  $("#canvas-size").textContent = `${size.width} × ${size.height}`;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-ratio]",
  ))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.ratio === s.aspectRatio),
    );
  $("#color-value").textContent = s.background.toUpperCase();
  $("#volume").title = project.tracks.screen.audio
    ? "Audio from your screen recording."
    : "No audio in this screen recording.";
  $("#microphoneVolume").title = project.tracks.microphone?.audio
    ? "Your microphone recording."
    : "No microphone track in this project.";
  $<HTMLInputElement>("#volume").disabled = !project.tracks.screen.audio;
  $<HTMLInputElement>("#microphoneVolume").disabled =
    !project.tracks.microphone?.audio;
  for (const el of document.querySelectorAll<HTMLButtonElement>(
    "[data-shape], [data-corner]",
  )) {
    el.setAttribute(
      "aria-pressed",
      String(
        el.dataset.shape
          ? s.cameraRoundness === (el.dataset.shape === "circle" ? 1 : 0)
          : el.dataset.corner === s.cameraCorner,
      ),
    );
  }
  $("#clip-count").textContent =
    `${edits.segments.length} clip${edits.segments.length === 1 ? "" : "s"}`;
  for (const key of [
    "canvasTemplate",
    "screenFit",
    "padding",
    "zoom",
    "cameraSize",
    "cameraMargin",
    "cameraRoundness",
    "cameraOffset",
    "cursorSize",
    "cursorSmoothing",
    "speed",
    "volume",
    "microphoneVolume",
    "cameraShape",
    "cameraCorner",
    "background",
  ] as const)
    $<HTMLInputElement>("#" + key).value = String(s[key]);
  $<HTMLInputElement>("#showCamera").checked = s.showCamera;
  for (const key of [
    "padding",
    "cameraSize",
    "cameraMargin",
    "cameraRoundness",
    "volume",
    "microphoneVolume",
  ] as const)
    $("#" + key + "-value").textContent = `${Math.round(s[key] * 1000) / 10}%`;
  $("#zoom-value").textContent = Number(s.zoom.toFixed(2)) + "×";
  $<HTMLInputElement>("#cameraFlip").checked = s.cameraFlip;
  for (const el of document.querySelectorAll<HTMLInputElement>(
    ".settings input[type=range]",
  )) {
    el.style.setProperty(
      "--fill",
      `${((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100}%`,
    );
  }
  document.querySelectorAll<HTMLElement>(".swatch").forEach((el) => {
    el.classList.toggle("selected", el.dataset.color === s.background);
    el.setAttribute("aria-pressed", String(el.dataset.color === s.background));
  });
  updateClipFields();
  mediaInspector.update();
  updateMotion();
  renderTimeline();
  $<HTMLInputElement>("#scrubber").max = String(total);
  refreshTime();
}
function updateClipFields() {
  if (!edits) return;
  selected = Math.min(selected, edits.segments.length - 1);
  const clip = edits.segments[selected];
  $<HTMLInputElement>("#trim-start").value = clip.start.toFixed(2);
  $<HTMLInputElement>("#trim-end").value = clip.end.toFixed(2);
  $("#selected-clip-label").textContent = `Clip ${selected + 1}`;
}
function renderTimeline() {
  if (!project || !edits) return;
  refreshDeleteControl();
  const viewport = {
    left: timelineScrollLeft,
    width: Math.max(1, timelineViewportWidth - timelineInset),
  };
  syncTimelineScaleControl();
  canvasMedia.renderTimeline(viewport);
  timelineView.render(
    project,
    edits,
    selectionKind === "clip" ? selected : -1,
    selectionKind === "zoom" ? selectedZoom : "",
    filmstrips,
    trimTotal ?? duration(edits),
    trimTotal !== null,
    waveforms,
    timelineLaneWidth,
    selectionKind === "audio" ? selectedAudio : null,
    viewport,
  );
  renderRangeSelection();
}
function renderRangeSelection() {
  const range = selectionKind === "range" ? selectedRange : null;
  const overlay = $("#range-selection"),
    button = $("#remove-range");
  overlay.hidden = button.hidden = !range;
  if (!range || !edits) return;
  const total = duration(edits);
  overlay.style.left = `${(range.start / total) * 100}%`;
  overlay.style.width = `${((range.end - range.start) / total) * 100}%`;
  overlay.setAttribute(
    "aria-label",
    `Selected ${clock(range.start)} to ${clock(range.end)}`,
  );
  $("#range-duration").textContent =
    `Cut ${(range.end - range.start).toFixed(1)}s`;
}
function updateMotion() {
  if (!edits || !project) return;
  const z = edits.zooms?.find((z) => z.id === selectedZoom);
  if (!z) selectedZoom = "";
  if (z?.id !== pickingZoomFocus || z?.mode === "follow") pickingZoomFocus = "";
  canvas.classList.toggle("picking-focus", Boolean(pickingZoomFocus));
  timelineView.renderZoomSelector(edits, selectedZoom);
  $<HTMLFieldSetElement>("#zoom-settings").disabled = !z;
  $<HTMLButtonElement>("#remove-zoom").disabled = !z;
  if (z) {
    const followAvailable = canFollowCursor(project.cursor);
    $<HTMLSelectElement>("#zoom-mode").value = z.mode ?? "fixed";
    $<HTMLOptionElement>('#zoom-mode option[value="follow"]').disabled =
      !followAvailable;
    $("#zoom-mode").title =
      z.mode === "follow"
        ? "Smoothly follows the recorded mouse, even when the cursor is hidden."
        : !followAvailable
          ? "No recorded mouse data in this media. Choose a fixed focus in the preview."
          : "Stays focused on the point you choose in the preview.";
    const focusButton = $<HTMLButtonElement>("#pick-zoom-focus");
    focusButton.disabled = z.mode === "follow";
    focusButton.title =
      z.mode === "follow"
        ? "Switch to Fixed focus to choose a point"
        : pickingZoomFocus
          ? "Cancel focus selection · Esc"
          : "Choose focus in preview";
    focusButton.setAttribute("aria-label", focusButton.title);
    $("#pick-zoom-focus").setAttribute(
      "aria-pressed",
      String(Boolean(pickingZoomFocus)),
    );
    $<HTMLInputElement>("#section-zoom").value = String(z.zoom);
    $("#section-zoom-value").textContent = `${z.zoom.toFixed(2)}×`;
    $<HTMLInputElement>("#section-ease").value = String(z.ease);
    $("#section-ease-value").textContent = `${z.ease.toFixed(2)}s`;
    const ranges = sourceRanges(edits, z.start, z.end);
    const ramp = ranges.length
      ? Math.min(z.ease, (ranges.at(-1)!.end - ranges[0].start) / 2)
      : 0;
    $("#section-ease").title = !ranges.length
      ? "This zoom is outside the retained clips."
      : ramp < z.ease - 0.001
        ? `Fitted to ${ramp.toFixed(2)}s at each edge. Lengthen the section for a slower move.`
        : "Duration at each edge. Increase it for a slower, gentler move.";
    $<HTMLInputElement>("#zoom-start").value = z.start.toFixed(2);
    $<HTMLInputElement>("#zoom-end").value = z.end.toFixed(2);
  } else {
    for (const id of ["zoom-start", "zoom-end"])
      $<HTMLInputElement>("#" + id).value = "";
    $("#section-zoom-value").textContent = "—";
    $("#section-ease-value").textContent = "—";
    $("#pick-zoom-focus").setAttribute("aria-pressed", "false");
  }
  const clean = Boolean(project.cursor?.clean);
  $("#cursor-settings").title = clean
    ? "Editable pointer • smoothing keeps clicks on target."
    : "This video has no separate cursor data. Its recorded pointer cannot be changed.";
  $("#cursor-settings").inert = !clean;
  $("#cursor-settings").classList.toggle("disabled", !clean);
  $<HTMLInputElement>("#showCursor").disabled = !clean;
  $<HTMLInputElement>("#showCursor").checked = edits.style.showCursor;
  $<HTMLInputElement>("#cursorClicks").checked = edits.style.cursorClicks;
  $("#cursorSize-value").textContent = `${edits.style.cursorSize}×`;
  $("#cursorSmoothing-value").textContent =
    `${Math.round(edits.style.cursorSmoothing * 1000)}ms`;
}
function selectZoom(id: string, seekTo = true) {
  if (!edits) return;
  selectItem("zoom");
  selectedZoom = id;
  setPanel("motion");
  const z = edits.zooms?.find((z) => z.id === id);
  const ranges = z ? sourceRanges(edits, z.start, z.end) : [];
  if (seekTo && ranges.length) seek((ranges[0].start + ranges[0].end) / 2);
  update();
}
function addZoom() {
  if (!edits || !project) return;
  pause();
  const start = sourceTime(edits, playhead),
    next = (edits.zooms || []).find((z) => z.start > start);
  if (edits.zooms?.some((z) => start >= z.start && start < z.end))
    return toast("Choose a point outside an existing zoom.");
  const end = Math.min(
    project.duration,
    next?.start ?? Infinity,
    start + 3 * edits.style.speed,
  );
  if (end - start < 0.1)
    return toast("Move the playhead before the end of the recording.");
  createZoom(start, end);
}
function createZoom(start: number, end: number) {
  if (!edits || !project) return;
  if ((edits.zooms?.length ?? 0) >= 80)
    return toast("Keep at most 80 zoom sections.");
  recordHistory();
  const z: Zoom = {
    id: crypto.randomUUID(),
    mode: canFollowCursor(project.cursor) ? "follow" : "fixed",
    start,
    end,
    zoom: 2,
    focusX: 0.5,
    focusY: 0.5,
    ease: defaultZoomEase,
  };
  edits.zooms = [...(edits.zooms || []), z].sort((a, b) => a.start - b.start);
  selectedZoom = z.id;
  changed();
  selectZoom(z.id);
}
$("#add-zoom").onclick = addZoom;
$("#open-motion").onclick = () => setPanel("motion");
$("#zoom-mode").addEventListener("change", (event) => {
  const z = edits?.zooms?.find((z) => z.id === selectedZoom);
  if (!z || !project || !edits) return;
  const mode = (event.target as HTMLSelectElement).value as "fixed" | "follow";
  if (mode === "follow" && !canFollowCursor(project.cursor)) return;
  pause();
  recordHistory();
  // Freeze the current target when switching from tracking to a fixed shot.
  if (mode === "fixed" && z.mode === "follow") {
    const crop = cropAt(edits, paintedPreviewTime, project.cursor);
    z.focusX = crop.size < 1 ? crop.x / (1 - crop.size) : 0.5;
    z.focusY = crop.size < 1 ? crop.y / (1 - crop.size) : 0.5;
  }
  z.mode = mode;
  changed();
});
$("#pick-zoom-focus").onclick = () => {
  if (!selectedZoom) return;
  pause();
  pickingZoomFocus = pickingZoomFocus ? "" : selectedZoom;
  if (pickingZoomFocus) previewMode = "screen";
  update();
};
$("#zoom-lane").addEventListener("click", (e) => {
  if (suppressClipClick) return;
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-zoom-id]",
  );
  if (target) selectZoom(target.dataset.zoomId!);
  else if ((e.target as HTMLElement).closest("#lane-add-zoom")) addZoom();
});
$("#zoom-selector").addEventListener("change", () => {
  const id = $<HTMLSelectElement>("#zoom-selector").value;
  if (id) selectZoom(id);
});
function removeZoom() {
  if (!edits?.zooms?.some((z) => z.id === selectedZoom)) return;
  pause();
  recordHistory();
  edits.zooms = edits.zooms.filter((z) => z.id !== selectedZoom);
  selectedZoom = "";
  selectionKind = "none";
  changed();
}
$("#remove-zoom").onclick = removeZoom;

for (const [id, key] of [
  ["section-zoom", "zoom"],
  ["section-ease", "ease"],
] as const) {
  const el = $<HTMLInputElement>("#" + id);
  let gesture = false;
  el.addEventListener("input", () => {
    const z = edits?.zooms?.find((z) => z.id === selectedZoom);
    if (!z) return;
    if (!gesture) {
      pause();
      recordHistory();
      gesture = true;
    }
    z[key] = Number(el.value);
    changed();
  });
  for (const event of ["change", "blur"])
    el.addEventListener(event, () => (gesture = false));
}
for (const side of ["start", "end"] as const)
  $("#zoom-" + side).addEventListener("change", (e) => {
    if (!edits || !project) return;
    const list = edits.zooms || [],
      i = list.findIndex((z) => z.id === selectedZoom),
      z = list[i];
    if (!z) return;
    const value = Number((e.target as HTMLInputElement).value);
    const min = side === "start" ? (list[i - 1]?.end ?? 0) : z.start + 0.1;
    const max =
      side === "end" ? (list[i + 1]?.start ?? project.duration) : z.end - 0.1;
    if (!Number.isFinite(value) || value < min || value > max) {
      toast(
        "Keep zoom sections inside the recording, without overlap.",
        "error",
      );
      update();
      return;
    }
    pause();
    recordHistory();
    z[side] = value;
    changed();
  });
$("#zoom-lane").addEventListener("pointerdown", (e: PointerEvent) => {
  const handle = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-zoom-trim]",
  );
  if (!edits || !project || e.button !== 0) return;
  if (!handle) {
    if (!e.isPrimary) return;
    const zoom = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-zoom-id]",
    );
    if (zoom) beginZoomMove(e, zoom.dataset.zoomId!);
    else if (!(e.target as HTMLElement).closest("#lane-add-zoom"))
      beginZoomDrag(e);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  pause();
  const id = handle.closest<HTMLElement>("[data-zoom-id]")!.dataset.zoomId!;
  const list = edits.zooms!,
    index = list.findIndex((z) => z.id === id),
    z = list[index];
  const side = handle.dataset.zoomTrim as "start" | "end",
    original = z[side],
    origin = e.clientX;
  const bounds = $("#zoom-lane").getBoundingClientRect(),
    total = duration(edits);
  const min = side === "start" ? (list[index - 1]?.end ?? 0) : z.start + 0.1;
  const max =
    side === "end" ? (list[index + 1]?.start ?? project.duration) : z.end - 0.1;
  let moved = false;
  selectItem("zoom");
  selectedZoom = id;
  update();
  const batch = frameLatest((clientX: number) => {
    if (!moved && Math.abs(clientX - origin) < 2) return;
    if (!moved) {
      recordHistory();
      moved = true;
    }
    z[side] = Math.max(
      min,
      Math.min(
        max,
        sourceTime(
          edits!,
          Math.max(
            0,
            Math.min(total, ((clientX - bounds.left) / bounds.width) * total),
          ),
        ),
      ),
    );
    changed(true);
  });
  const move = (event: PointerEvent) => batch.push(event.clientX);
  const up = () => {
    batch.flush();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    suppressClipClick = moved;
    setTimeout(() => (suppressClipClick = false), 0);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
});
function beginZoomMove(event: PointerEvent, id: string) {
  cancelZoomDraft?.();
  cancelTimelineGesture?.();
  if (!edits) return;
  const state = edits,
    before = structuredClone(edits);
  const zoom = state.zooms?.find((z) => z.id === id);
  const original = before.zooms?.find((z) => z.id === id);
  if (!zoom || !original) return;
  event.preventDefault();
  event.stopPropagation();
  pause();
  selectZoom(id, false);
  const lane = $("#zoom-lane");
  cancelTimelineGesture = timelineDrag(
    event,
    lane,
    lane,
    $(".timeline-scroll"),
    duration(state),
    (anchor, time) => {
      Object.assign(zoom, moveZoomRange(before, original, time - anchor));
      lane.classList.add("moving-zoom");
      redraw = true;
      updateMotion();
      renderTimeline();
    },
    (commit, moved) => {
      cancelTimelineGesture = null;
      lane.classList.remove("moving-zoom");
      suppressClipClick = moved;
      setTimeout(() => (suppressClipClick = false), 0);
      if (
        commit &&
        (zoom.start !== original.start || zoom.end !== original.end)
      ) {
        recordHistory(before);
        changed();
      } else {
        Object.assign(zoom, original);
        redraw = true;
        if (commit && !moved) selectZoom(id);
        else update();
      }
    },
  );
}
function beginZoomDrag(event: PointerEvent) {
  cancelTimelineGesture?.();
  cancelZoomDraft?.();
  if (!edits || !project) return;
  if ((edits.zooms?.length ?? 0) >= 80)
    return toast("Keep at most 80 zoom sections.");
  event.preventDefault();
  pause();
  const state = edits,
    lane = $("#zoom-lane"),
    bounds = lane.getBoundingClientRect();
  const total = duration(state),
    scroll = $(".timeline-scroll"),
    originalScroll = scroll.scrollLeft;
  const outputAt = (x: number) =>
    Math.max(
      0,
      Math.min(
        total,
        ((x - bounds.left + scroll.scrollLeft - originalScroll) /
          bounds.width) *
          total,
      ),
    );
  const anchor = outputAt(event.clientX),
    origin = event.clientX;
  const ghost = document.createElement("span");
  ghost.className = "zoom-clip zoom-draft";
  ghost.setAttribute("aria-label", "New zoom range");
  let latest = origin,
    finished = false,
    moved = false,
    range: ReturnType<typeof zoomDragRange> = null;
  const batch = frameLatest((x: number) => {
    if (
      !moved &&
      Math.abs(x - origin) < 4 &&
      scroll.scrollLeft === originalScroll
    )
      return;
    moved = true;
    range = zoomDragRange(state, anchor, outputAt(x));
    const spans = range ? sourceRanges(state, range.start, range.end) : [];
    if (!range || !spans.length) {
      ghost.remove();
      return;
    }
    const start = spans[0].start,
      end = spans.at(-1)!.end;
    ghost.style.left = `${(start / total) * 100}%`;
    ghost.style.width = `${((end - start) / total) * 100}%`;
    ghost.textContent = `＋ ${(end - start).toFixed(1)}s`;
    lane.classList.add("adding-zoom");
    if (!ghost.isConnected) lane.append(ghost);
  });
  const move = (e: PointerEvent) => {
    if (e.pointerId === event.pointerId) {
      if (!(e.buttons & 1)) {
        cancel();
        return;
      }
      latest = e.clientX;
      batch.push(latest);
    }
  };
  const onScroll = () => batch.push(latest);
  const finish = (commit: boolean) => {
    if (finished) return;
    finished = true;
    batch.flush();
    ghost.remove();
    lane.classList.remove("adding-zoom");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", key, true);
    scroll.removeEventListener("scroll", onScroll);
    lane.removeEventListener("lostpointercapture", cancel);
    cancelZoomDraft = null;
    if (lane.hasPointerCapture(event.pointerId))
      lane.releasePointerCapture(event.pointerId);
    suppressClipClick = moved;
    setTimeout(() => (suppressClipClick = false), 0);
    if (
      commit &&
      moved &&
      range &&
      range.end - range.start >= 0.1 &&
      edits === state
    )
      createZoom(range.start, range.end);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    batch.push(e.clientX);
    finish(true);
  };
  const cancel = () => finish(false);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    }
  };
  lane.setPointerCapture(event.pointerId);
  cancelZoomDraft = cancel;
  lane.addEventListener("lostpointercapture", cancel);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", key, true);
  scroll.addEventListener("scroll", onScroll);
}
function syncTimelineScaleControl() {
  const input = $<HTMLInputElement>("#timeline-scale");
  const maximum = maxTimelineScale(
    edits ? duration(edits) : 0,
    timelineViewportWidth,
  );
  // A logarithmic slider makes both fit-to-window and deep zoom easy to reach.
  const maximumValue = String(Math.ceil(Math.log2(maximum) * 100) / 100);
  if (input.max !== maximumValue) input.max = maximumValue;
  const value =
    timelineScale >= maximum
      ? maximumValue
      : Math.log2(timelineScale).toFixed(2);
  if (Number(input.value) !== Number(value)) input.value = value;
  input.setAttribute("aria-valuetext", `${timelineScale.toFixed(1)} times`);
}
function setTimelineScale(next: number, pointer?: number) {
  const maximum = maxTimelineScale(
    edits ? duration(edits) : 0,
    timelineViewportWidth,
  );
  next = Math.max(1, Math.min(maximum, next));
  if (next === timelineScale) return;
  const anchored =
    pointer === undefined
      ? null
      : timelineZoomAt(
          timelineScale,
          next,
          timelineScroll.scrollLeft,
          timelineViewportWidth,
          pointer,
        );
  timelineScale = next;
  timelineZoomingUntil = performance.now() + 800;
  $(".timeline").style.width = `${timelineScale * 100}%`;
  timelineLaneWidth = Math.max(
    1,
    timelineViewportWidth * timelineScale - timelineInset,
  );
  const fraction = edits ? playhead / duration(edits) : 0;
  scrollTimeline(
    anchored ??
      timelineGutter + timelineLaneWidth * fraction - timelineViewportWidth / 2,
  );
  syncTimelineScaleControl();
  refreshTimelineViewport.push(null);
  refreshTime();
}
$("#timeline-scale").addEventListener("input", (e) => {
  setTimelineScale(2 ** Number((e.target as HTMLInputElement).value));
});
attachTimelinePinch(timelineScroll, {
  enabled: () =>
    !!edits && !recordId && !cancelTimelineGesture && !cancelZoomDraft,
  scale: () => timelineScale,
  maximum: () =>
    maxTimelineScale(edits ? duration(edits) : 0, timelineViewportWidth),
  zoom: setTimelineScale,
});
const panelScroll = new Map<string, number>();
function setPanel(id: string, focus = false) {
  const previous = activePanel;
  if (previous !== id) panelScroll.set(previous, $("#settings").scrollTop);
  if (id !== "motion" && pickingZoomFocus) {
    pickingZoomFocus = "";
    canvas.classList.remove("picking-focus");
    redraw = true;
  }
  if (id !== "media") canvasMedia.clearSelection();
  if (id === "media" && !canvasMedia.selected && !selectedMediaTrack)
    selectedMediaTrack = "screen";
  activePanel = id;
  $("#settings").classList.toggle("disabled", !project && id !== "media");
  $("#settings").inert = !project && id !== "media";
  if (id === "media") mediaInspector.update();
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    "[data-panel]",
  )) {
    const active = b.dataset.panel === id;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
    if (active) {
      if (focus) b.focus();
    }
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".settings-panel"))
    panel.hidden = panel.id !== "panel-" + id;
  if (previous !== id) $("#settings").scrollTop = panelScroll.get(id) || 0;
  refreshDeleteControl();
}
document.querySelectorAll<HTMLButtonElement>("[data-panel]").forEach((b) => {
  b.onclick = () => setPanel(b.dataset.panel!);
  b.onkeydown = (e) => {
    const tabs = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-panel]"),
    ];
    const i = tabs.indexOf(b);
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? (i + tabs.length - 1) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : -1;
    if (next >= 0) {
      e.preventDefault();
      setPanel(tabs[next].dataset.panel!, true);
    }
  };
});
document.querySelectorAll<HTMLButtonElement>("[data-preview]").forEach((b) => {
  b.onclick = () => {
    previewMode = b.dataset.preview as PreviewMode;
    pickingZoomFocus = "";
    syncMedia(true);
    update();
  };
  b.onkeydown = (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabs = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-preview]"),
    ].filter((t) => !t.disabled);
    const i = tabs.indexOf(b);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? tabs.length - 1
          : (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    e.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  };
});
document
  .querySelectorAll<HTMLElement>("[data-shape]")
  .forEach(
    (b) => (b.onclick = () => setStyle("cameraShape", b.dataset.shape!)),
  );
document
  .querySelectorAll<HTMLElement>("[data-corner]")
  .forEach(
    (b) => (b.onclick = () => setStyle("cameraCorner", b.dataset.corner!)),
  );
let suppressClipClick = false;
$(".timeline").addEventListener(
  "click",
  (e) => {
    if (suppressClipClick) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);
$(".timeline").addEventListener(
  "pointerdown",
  (e: PointerEvent) => {
    if (!edits || busy || recordId || !e.isPrimary || e.button !== 0) return;
    if (!e.metaKey) {
      if (selectionKind === "range") {
        selectItem("none");
        renderTimeline();
      }
      return;
    }
    const lane = $("#screen-lane"),
      bounds = lane.getBoundingClientRect();
    if (
      e.clientX <
        Math.max(
          bounds.left,
          $(".timeline-scroll").getBoundingClientRect().left + 112,
        ) ||
      e.clientX > bounds.right
    )
      return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelZoomDraft?.();
    cancelTimelineGesture?.();
    pause();
    const previous = selectedRange;
    selectItem("range");
    const timeline = $(".timeline");
    timeline.focus({ preventScroll: true });
    timeline.classList.add("selecting-range");
    cancelTimelineGesture = timelineDrag(
      e,
      timeline,
      lane,
      $(".timeline-scroll"),
      duration(edits),
      (anchor, time) => {
        selectedRange = {
          start: Math.min(anchor, time),
          end: Math.max(anchor, time),
        };
        selectionKind = "range";
        renderRangeSelection();
        refreshDeleteControl();
      },
      (commit, moved) => {
        cancelTimelineGesture = null;
        timeline.classList.remove("selecting-range");
        if (!commit) selectedRange = previous;
        else if (
          !moved ||
          !selectedRange ||
          selectedRange.end - selectedRange.start < 0.01
        )
          selectedRange = null;
        selectionKind = selectedRange ? "range" : "none";
        suppressClipClick = true;
        setTimeout(() => (suppressClipClick = false), 0);
        update();
      },
    );
  },
  true,
);
$(".timeline").addEventListener("click", (e) => {
  const clip = (e.target as HTMLElement).closest<HTMLElement>("[data-clip]");
  if (!clip || suppressClipClick) return;
  selectItem(clip.dataset.track === "audio" ? "audio" : "clip");
  selected = Number(clip.dataset.clip);
  if (selectionKind === "audio")
    selectedAudio = {
      start: Number(clip.dataset.audioStart),
      end: Number(clip.dataset.audioEnd),
    };
  selectedMediaTrack =
    clip.dataset.track === "camera"
      ? "camera"
      : clip.dataset.track === "audio" && !project?.tracks.screen.audio
        ? "microphone"
        : "screen";
  setPanel("media");
  const r = $("#screen-lane").getBoundingClientRect();
  const t =
    (e as MouseEvent).detail === 0
      ? edits!.segments
          .slice(0, selected)
          .reduce((n, s) => n + s.end - s.start, 0) / edits!.style.speed
      : (((e as MouseEvent).clientX - r.left) / r.width) * duration(edits!);
  seek(t);
  update();
});
$(".timeline").addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest("[data-clip]")) setPanel("clip");
});
$(".timeline").addEventListener("pointerdown", (event) => {
  const e = event as PointerEvent;
  const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-trim]");
  if (!handle || !project || !edits) return;
  e.preventDefault();
  pause();
  const clip = handle.closest<HTMLElement>("[data-clip]")!;
  const index = Number(clip.dataset.clip);
  selectItem(clip.dataset.track === "audio" ? "audio" : "clip");
  if (selectionKind === "audio")
    selectedAudio = {
      start: Number(clip.dataset.audioStart),
      end: Number(clip.dataset.audioEnd),
    };
  const side = handle.dataset.trim as "start" | "end";
  const original = structuredClone(edits);
  const segment = original.segments[index];
  const pixels = $("#screen-lane").getBoundingClientRect().width;
  const sourcePerPixel = (duration(edits) * edits.style.speed) / pixels;
  const origin = e.clientX;
  trimTotal = duration(edits);
  let moved = false;
  selected = index;
  selectedMediaTrack =
    clip.dataset.track === "camera"
      ? "camera"
      : clip.dataset.track === "audio" && !project.tracks.screen.audio
        ? "microphone"
        : "screen";
  setPanel("media");
  const batch = frameLatest((clientX: number) => {
    if (!edits || !project) return;
    if (!moved && Math.abs(clientX - origin) < 2) return;
    if (!moved) {
      recordHistory();
      moved = true;
    }
    const min =
      side === "start"
        ? original.segments[index - 1]?.end || 0
        : segment.start + 0.05;
    const max =
      side === "end"
        ? (original.segments[index + 1]?.start ?? project.duration)
        : segment.end - 0.05;
    edits.segments[index][side] = Math.max(
      min,
      Math.min(max, segment[side] + (clientX - origin) * sourcePerPixel),
    );
    const before =
      edits.segments.slice(0, index).reduce((n, s) => n + s.end - s.start, 0) /
      edits.style.speed;
    playhead =
      side === "start"
        ? before
        : before +
          (edits.segments[index].end - edits.segments[index].start) /
            edits.style.speed -
          0.001;
    changed(true);
    seekRequested = true;
  });
  const move = (event: PointerEvent) => batch.push(event.clientX);
  const up = () => {
    batch.flush();
    trimTotal = null;
    update();
    document.body.classList.remove("trimming");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    suppressClipClick = moved;
    setTimeout(() => {
      suppressClipClick = false;
    }, 0);
  };
  document.body.classList.add("trimming");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
});

let timeLabel = "",
  playLabel = "";
function refreshTime() {
  const total = edits ? duration(edits) : 0;
  const label = `${clock(playhead)} <em>/ ${clock(total)}</em>`;
  if (label !== timeLabel) {
    $("#timecode").innerHTML = label;
    timeLabel = label;
  }
  $<HTMLInputElement>("#scrubber").value = String(playhead);
  const head =
    112 + timelineLaneWidth * (total ? playhead / (trimTotal ?? total) : 0);
  timelineHead.style.transform = `translate3d(${head}px, 0, 0)`;
  const control = playing ? "Pause" : "Play";
  if (control !== playLabel) {
    $("#play").innerHTML = icon(playing ? "pause" : "play", 17);
    $("#play").setAttribute("aria-label", control);
    playLabel = control;
  }
  if (playing && performance.now() >= timelineZoomingUntil) {
    if (
      head > timelineScrollLeft + timelineViewportWidth - 25 ||
      head < timelineScrollLeft + 16
    )
      scrollTimeline(head - timelineViewportWidth / 3);
  }
}
function requestSeek(el: HTMLMediaElement, t: number) {
  Object.values(cutMedia)
    .find((track) => track.element === el)
    ?.seek(t);
}
let playbackSegment = -1;
function syncMedia(force = false, dispatchPaused = false) {
  if (!project || !edits) return;
  // While scrubbing, retain only the latest target. Start its seek after the
  // previous decoded frame has painted, rather than starving Canvas forever.
  if (!playing && !dispatchPaused) {
    seekRequested = true;
    return;
  }
  seekRequested = false;
  if (!playing) {
    scrubFrameTime = playhead;
  }
  const src = sourceTime(edits, playhead),
    s = edits.style;
  const seg = segmentAt(edits, playhead),
    cut =
      seg !== playbackSegment &&
      playbackSegment >= 0 &&
      (seg !== playbackSegment + 1 ||
        Math.abs(
          edits.segments[seg].start - edits.segments[playbackSegment].end,
        ) > 0.001);
  playbackSegment = seg;
  const microphone = project.tracks.microphone;
  const clock: typeof playbackMaster =
    (!project.tracks.screen.audio || s.volume === 0) &&
    microphone?.audio &&
    s.microphoneVolume > 0 &&
    src >= microphone.offset &&
    src < microphone.offset + microphone.duration
      ? "microphone"
      : "screen";
  const clockChanged = clock !== playbackMaster;
  playbackMaster = clock;
  if (force || cut || clockChanged) {
    playbackBase = playhead;
    playbackSourceBase = src - project.tracks[clock]!.offset;
    playbackStarted = performance.now();
  }
  const audioRemoved = audioRemovedAt(edits, src);
  const next = playing ? nextMediaCut(edits, playhead) : null;
  canvasMedia.sync(
    force || cut,
    next ? { source: next.source, remaining: next.time - playhead } : null,
  );
  for (const key of ["screen", "camera", "microphone"] as const) {
    const track = project.tracks[key],
      bank = cutMedia[key];
    if (!track) continue;
    const t = src - track.offset - (key === "camera" ? s.cameraOffset : 0),
      inRange = t >= 0 && t < track.duration;
    const cutKey = `${seg}:${edits.segments[seg].start}:${s.speed}:${key === "camera" ? s.cameraOffset : 0}`;
    const handed = playing && cut && bank.handoff(cutKey, t, s.speed);
    const el = bank.element;
    media[key] = el as HTMLVideoElement;
    if (handed && key === playbackMaster) {
      playbackBase = playhead;
      playbackSourceBase = el.currentTime;
      playbackStarted = performance.now();
    }
    if (
      (!playing || key === playbackMaster || force || cut) &&
      el.playbackRate !== s.speed
    )
      el.playbackRate = s.speed;
    const volume = audioRemoved
      ? 0
      : key === "screen"
        ? s.volume
        : key === "microphone"
          ? s.microphoneVolume
          : 0;
    bank.setVolume(enhancedAudio.has(key) ? 0 : volume);
    // The audible track's own clock drives playback, including audio startup
    // and buffering. Never chase a wall clock by repeatedly seeking that track.
    // Correct followers before a startup delay can leave a visible 250 ms gap.
    if (!handed && (force || cut || clockChanged)) requestSeek(el, t);
    else if (playing && key !== playbackMaster && inRange)
      bank.follow(t, s.speed);
    if (playing && inRange) {
      if (el.paused) void el.play().catch(() => {});
    } else if (!el.paused) el.pause();
    if (next) {
      const target =
        next.source - track.offset - (key === "camera" ? s.cameraOffset : 0);
      if (target < track.duration)
        bank.prepare(
          `${next.index}:${next.source}:${s.speed}:${key === "camera" ? s.cameraOffset : 0}`,
          target,
          next.time - playhead,
          s.speed,
        );
    } else bank.cancel();
  }
  enhancedAudio.sync(
    project,
    edits,
    playhead,
    playing,
    previewMode === "combined",
    force || cut,
  );
}
function pause() {
  enhancedAudio.pause();
  canvasMedia.pause();
  Object.values(cutMedia).forEach((track) => track.cancel());
  redraw = true;
  if (!playing) return;
  playing = false;
  scrubFrameTime = playhead;
  Object.values(media).forEach((v) => v.pause());
  refreshTime();
}
function togglePlay() {
  if (!edits) return;
  if (
    edits.style.enhanceAudio &&
    (enhancedAudio.pending || enhancedAudio.error)
  )
    return;
  if (pickingZoomFocus) {
    pickingZoomFocus = "";
    updateMotion();
    redraw = true;
  }
  if (playing) {
    pause();
    return;
  }
  if (playhead >= duration(edits) - 0.02) playhead = 0;
  playing = true;
  playbackBase = playhead;
  playbackStarted = performance.now();
  syncMedia(true);
  refreshTime();
}
function seek(t: number) {
  pause();
  playhead = Math.max(0, Math.min(edits ? duration(edits) : 0, t));
  redraw = true;
  seekRequested = true;
}
const canvas = $<HTMLCanvasElement>("#preview"),
  ctx = canvas.getContext("2d")!;
const canvasMedia = new CanvasMedia(
  canvas,
  {
    state: () => ({
      project,
      edits,
      source: edits ? sourceTime(edits, playhead) : 0,
      combined: previewMode === "combined",
      picking: !!pickingZoomFocus || activePanel === "motion",
      playing,
      enhancedAudio: enhancedAudio.ready,
    }),
    history: recordHistory,
    changed,
    redraw: () => {
      redraw = true;
    },
    pause,
    seek,
    select: () => {
      selectedMediaTrack = null;
      selectItem("media");
      previewMode = "combined";
      setPanel("media");
      update();
      mediaInspector.showProperties();
    },
    error: (message) => toast(message, "error"),
  },
  icon,
);
function selectSourceTrack(track: MediaTrack) {
  if (!project?.tracks[track]) return;
  selectedMediaTrack = track;
  selectItem(track === "microphone" ? "audio" : "clip");
  if (track === "microphone" && edits)
    selectedAudio = { ...edits.segments[selected] };
  setPanel("media");
  update();
  mediaInspector.showProperties();
}
const mediaInspector = new MediaInspector(
  {
    state: () => ({
      project,
      edits,
      track: selectedMediaTrack,
      layer: canvasMedia.selected,
      clip: selected,
    }),
    select: selectSourceTrack,
    style: setStyle,
    trim: trimClip,
    import: () => {
      void task(importProject);
    },
    camera: () => {
      void task(attachWebcam);
    },
  },
  icon,
);
function previewWaiting(time = playhead) {
  if (!project || !edits) return false;
  const source = sourceTime(edits, time);
  return (["screen", "camera"] as const).some((key) => {
    const visible =
      key === "screen"
        ? previewMode !== "camera"
        : previewMode === "camera" ||
          (previewMode === "combined" && edits!.style.showCamera);
    const track = project!.tracks[key];
    if (!visible || !track) return false;
    const t =
      key === "camera"
        ? cameraFrameTime(track, source, edits!.style.cameraOffset)
        : source - track.offset;
    return (
      t !== null &&
      t >= 0 &&
      t < track.duration &&
      (media[key].seeking || media[key].readyState < 2)
    );
  });
}
function paint() {
  requestAnimationFrame(paint);
  if (!project || !edits) return;
  if (!playing && seekRequested) refreshTime();
  try {
    paintFrame();
  } finally {
    if (!playing && seekRequested && !previewWaiting(scrubFrameTime))
      syncMedia(true, true);
  }
}
function paintFrame() {
  if (!project || !edits) return;
  if (playing) {
    // Let the browser buffer/seek without restarting its audio output pipeline.
    // A follower decoder must not pause the primary screen/audio clock.
    if (!cutMedia.screen.image()) {
      redraw = true;
      return;
    }
    const clockTrack = project.tracks[playbackMaster]!;
    const clockTime = sourceTime(edits, playhead) - clockTrack.offset;
    playhead =
      playbackBase +
      (clockTime >= 0 && clockTime < clockTrack.duration
        ? Math.max(0, media[playbackMaster].currentTime - playbackSourceBase) /
          edits.style.speed
        : (performance.now() - playbackStarted) / 1000);
    if (playhead >= duration(edits)) {
      playhead = duration(edits);
      pause();
      syncMedia(true);
    }
    syncMedia();
    refreshTime();
  }
  const frameTime = playing ? playhead : scrubFrameTime;
  if (playing ? !cutMedia.screen.image() : previewWaiting(frameTime)) {
    redraw = true;
    return;
  }
  if (!playing && !redraw) return;
  redraw = false;
  paintedPreviewTime = frameTime;
  const { width: w, height: h } = canvas,
    s = edits.style;
  const crop = pickingZoomFocus
    ? { x: 0, y: 0, size: 1 }
    : cropAt(edits, frameTime, project.cursor);
  if (previewMode !== "combined") {
    const image = cutMedia[previewMode].image();
    const track = project.tracks[previewMode]!;
    const source = sourceTime(edits, frameTime);
    const t =
      previewMode === "camera"
        ? cameraFrameTime(track, source, s.cameraOffset)
        : source - track.offset;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    if (t !== null && t >= 0 && t < track.duration && image) {
      const zoom = previewMode === "screen" ? 1 / crop.size : 1;
      const width =
          image instanceof HTMLVideoElement ? image.videoWidth : image.width,
        height =
          image instanceof HTMLVideoElement ? image.videoHeight : image.height;
      const cw = width / zoom,
        ch = height / zoom;
      ctx.save();
      if (previewMode === "camera" && s.cameraFlip) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(
        image,
        previewMode === "screen" ? width * crop.x : 0,
        previewMode === "screen" ? height * crop.y : 0,
        cw,
        ch,
        0,
        0,
        w,
        h,
      );
      ctx.restore();
    }
    if (previewMode === "screen") drawCursor(0, 0, w, h, crop, frameTime);
    if (pickingZoomFocus) {
      const zoom = edits.zooms?.find((z) => z.id === pickingZoomFocus);
      if (zoom) {
        const x = (1 - 1 / zoom.zoom) * zoom.focusX * w,
          y = (1 - 1 / zoom.zoom) * zoom.focusY * h;
        ctx.save();
        ctx.fillStyle = "#09090b99";
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.rect(x, y, w / zoom.zoom, h / zoom.zoom);
        ctx.fill("evenodd");
        ctx.strokeStyle = "#3a4bf8";
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w / zoom.zoom, h / zoom.zoom);
        ctx.restore();
      }
    }
    canvasMedia.paintSelection();
    drawLiveTake();
    return;
  }
  ctx.fillStyle = s.background;
  ctx.fillRect(0, 0, w, h);
  const video = cutMedia.screen.image(),
    sw =
      video instanceof HTMLVideoElement
        ? video.videoWidth
        : (video?.width ?? 0),
    sh =
      video instanceof HTMLVideoElement
        ? video.videoHeight
        : (video?.height ?? 0),
    layout = compositionLayout(s, w, h),
    { pad, innerWidth, innerHeight } = layout;
  if (sw && sh && video) {
    const scale = (s.screenFit === "fill" ? Math.max : Math.min)(
        innerWidth / sw,
        innerHeight / sh,
      ),
      dw = sw * scale,
      dh = sh * scale,
      cw = sw * crop.size,
      ch = sh * crop.size;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad, pad, innerWidth, innerHeight);
    ctx.clip();
    ctx.drawImage(
      video,
      sw * crop.x,
      sh * crop.y,
      cw,
      ch,
      (w - dw) / 2,
      (h - dh) / 2,
      dw,
      dh,
    );
    drawCursor((w - dw) / 2, (h - dh) / 2, dw, dh, crop, frameTime);
    ctx.restore();
  }
  if (project.tracks.camera && s.showCamera) {
    const v = cutMedia.camera.image(),
      t = cameraFrameTime(
        project.tracks.camera,
        sourceTime(edits, frameTime),
        s.cameraOffset,
      ),
      size = layout.cameraSize,
      gap = layout.cameraGap,
      x = s.cameraCorner.endsWith("right") ? w - size - gap : gap,
      y = s.cameraCorner.startsWith("bottom") ? h - size - gap : gap;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, (size * s.cameraRoundness) / 2);
    ctx.clip();
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, size, size);
    if (t !== null && v) {
      const width = v instanceof HTMLVideoElement ? v.videoWidth : v.width,
        height = v instanceof HTMLVideoElement ? v.videoHeight : v.height;
      const crop = Math.min(width, height);
      if (s.cameraFlip) {
        ctx.translate(2 * x + size, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(
        v,
        (width - crop) / 2,
        (height - crop) / 2,
        crop,
        crop,
        x,
        y,
        size,
        size,
      );
    }
    ctx.restore();
  }
  canvasMedia.draw(ctx, sourceTime(edits, frameTime));
  drawLiveTake();
}
function drawLiveTake() {
  if (!liveTakePreview.srcObject || liveTakePreview.readyState < 2 || !edits)
    return;
  const { width, height } = canvas,
    s = edits.style,
    { cameraSize: size, cameraGap: gap } = compositionLayout(s, width, height),
    x = s.cameraCorner.endsWith("right") ? width - size - gap : gap,
    y = s.cameraCorner.startsWith("bottom") ? height - size - gap : gap,
    side = Math.min(liveTakePreview.videoWidth, liveTakePreview.videoHeight);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, (size * s.cameraRoundness) / 2);
  ctx.clip();
  if (s.cameraFlip) {
    ctx.translate(2 * x + size, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(
    liveTakePreview,
    (liveTakePreview.videoWidth - side) / 2,
    (liveTakePreview.videoHeight - side) / 2,
    side,
    side,
    x,
    y,
    size,
    size,
  );
  ctx.restore();
}
requestAnimationFrame(paint);
const arrowPath = new Path2D(cursorPath);
function drawCursor(
  x: number,
  y: number,
  w: number,
  h: number,
  crop: { x: number; y: number; size: number },
  time: number,
) {
  if (!project || !edits) return;
  const p = cursorAt(project.cursor, sourceTime(edits, time), edits.style);
  if (!p) return;
  const scale = ((w / 1280) * edits.style.cursorSize) / crop.size;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(
    x + ((p.x - crop.x) / crop.size) * w,
    y + ((p.y - crop.y) / crop.size) * h,
  );
  ctx.scale(scale, scale);
  ctx.translate(-16, -16);
  if (p.pressed && edits.style.cursorClicks) {
    ctx.beginPath();
    ctx.arc(16, 16, 13, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(169,146,255,.3)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#b7a4ff";
    ctx.stroke();
  }
  ctx.fillStyle = "white";
  ctx.strokeStyle = "#17141f";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.fill(arrowPath);
  ctx.stroke(arrowPath);
  ctx.restore();
}
canvas.addEventListener("click", (e) => {
  if (!edits || !project) return;
  if (activePanel !== "motion" && !pickingZoomFocus) {
    let track: MediaTrack = previewMode === "camera" ? "camera" : "screen";
    if (
      previewMode === "combined" &&
      project.tracks.camera &&
      edits.style.showCamera
    ) {
      const rect = canvas.getBoundingClientRect();
      const { cameraSize: size, cameraGap: gap } = compositionLayout(
        edits.style,
        canvas.width,
        canvas.height,
      );
      const x = ((e.clientX - rect.left) / rect.width) * canvas.width,
        y = ((e.clientY - rect.top) / rect.height) * canvas.height;
      const left = edits.style.cameraCorner.endsWith("right")
          ? canvas.width - size - gap
          : gap,
        top = edits.style.cameraCorner.startsWith("bottom")
          ? canvas.height - size - gap
          : gap;
      if (x >= left && x <= left + size && y >= top && y <= top + size)
        track = "camera";
    }
    selectSourceTrack(track);
    return;
  }
  if (previewMode === "camera") return;
  const r = canvas.getBoundingClientRect(),
    sw = project.tracks.screen.width,
    sh = project.tracks.screen.height;
  const { pad, innerWidth, innerHeight } = compositionLayout(
    edits.style,
    canvas.width,
    canvas.height,
  );
  const scale =
    previewMode === "combined"
      ? (edits.style.screenFit === "fill" ? Math.max : Math.min)(
          innerWidth / sw,
          innerHeight / sh,
        )
      : canvas.width / sw;
  const dw = sw * scale,
    dh = sh * scale,
    x = ((e.clientX - r.left) / r.width) * canvas.width,
    y = ((e.clientY - r.top) / r.height) * canvas.height;
  if (
    previewMode === "combined" &&
    (x < pad || y < pad || x > canvas.width - pad || y > canvas.height - pad)
  )
    return;
  const nx = (x - (canvas.width - dw) / 2) / dw,
    ny = (y - (canvas.height - dh) / 2) / dh;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  const crop = pickingZoomFocus
    ? { x: 0, y: 0, size: 1 }
    : cropAt(edits, paintedPreviewTime, project.cursor);
  const target =
    (activePanel === "motion" &&
      (edits.zooms || []).find((z) => z.id === selectedZoom)) ||
    edits.style;
  if ("mode" in target && target.mode === "follow")
    return toast("Choose Fixed focus to set a point in the preview.");
  pause();
  recordHistory();
  const fx = crop.x + nx * crop.size,
    fy = crop.y + ny * crop.size;
  // focus is the crop's pan fraction; place the clicked source pixel at center.
  target.focusX =
    target.zoom > 1
      ? Math.max(
          0,
          Math.min(1, (fx - 0.5 / target.zoom) / (1 - 1 / target.zoom)),
        )
      : fx;
  target.focusY =
    target.zoom > 1
      ? Math.max(
          0,
          Math.min(1, (fy - 0.5 / target.zoom) / (1 - 1 / target.zoom)),
        )
      : fy;
  pickingZoomFocus = "";
  changed();
});
function resetZoom(all = false) {
  if (!edits) return;
  pause();
  recordHistory();
  if (all) {
    edits.zooms = [];
    selectedZoom = "";
  }
  Object.assign(edits.style, { zoom: 1, focusX: 0.5, focusY: 0.5 });
  changed();
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-ratio]",
))
  button.onclick = () =>
    setStyle("aspectRatio", button.dataset.ratio as Style["aspectRatio"]);
$("#canvasTemplate").onchange = () =>
  setStyle("canvasTemplate", $<HTMLSelectElement>("#canvasTemplate").value);
$("#screenFit").onchange = () =>
  setStyle(
    "screenFit",
    $<HTMLSelectElement>("#screenFit").value as Style["screenFit"],
  );
$("#fit").onclick = () => resetZoom(true);
$("#reset-zoom").onclick = () => resetZoom();
$("#play").onclick = togglePlay;
$("#back").onclick = () => seek(0);
$("#end").onclick = () => edits && seek(duration(edits));
$("#redo").onclick = redo;
$("#undo").onclick = undo;
$("#scrubber").addEventListener("input", (e) =>
  seek(Number((e.target as HTMLInputElement).value)),
);
$("#scrubber").addEventListener("pointerdown", (e: PointerEvent) => {
  if (!edits) return;
  e.preventDefault();
  const input = e.currentTarget as HTMLInputElement;
  input.focus();
  input.setPointerCapture(e.pointerId);
  const bounds = $("#screen-lane").getBoundingClientRect(),
    scrollOrigin = timelineScrollLeft;
  const move = (event: PointerEvent) => {
    seek(
      ((event.clientX - bounds.left + timelineScrollLeft - scrollOrigin) /
        bounds.width) *
        duration(edits!),
    );
  };
  const up = () => {
    input.removeEventListener("pointermove", move);
    input.removeEventListener("pointerup", up);
    input.removeEventListener("pointercancel", up);
  };
  move(e);
  input.addEventListener("pointermove", move);
  input.addEventListener("pointerup", up);
  input.addEventListener("pointercancel", up);
});
$("#save").onclick = () => task(save);
$("#reload-project").onclick = () =>
  task(async () => {
    if (await canReplace()) await load(await api.reload());
  });
let checkingRevision = false;
async function checkExternalChanges() {
  if (!api || !project || busy || checkingRevision || renaming || saving)
    return;
  const snapshot = project;
  checkingRevision = true;
  try {
    const revision = await api.projectRevision();
    if (project !== snapshot || renaming || saving) return;
    const changed = revision !== project.revision;
    if (changed !== externalChange) {
      externalChange = changed;
      update();
    }
  } catch {
    /* A temporarily unavailable project is reported when saved/opened. */
  } finally {
    checkingRevision = false;
  }
}
setInterval(() => void checkExternalChanges(), 3000);
window.addEventListener("focus", () => void checkExternalChanges());
$("#open").onclick = () =>
  task(async () => {
    if (await canReplace()) await load(await api.open());
  });
function split() {
  if (!edits) return;
  pause();
  const i = segmentAt(edits, playhead),
    t = sourceTime(edits, playhead),
    seg = edits.segments[i];
  if (t - seg.start < 0.05 || seg.end - t < 0.05)
    return toast("Move the playhead away from a clip edge.");
  recordHistory();
  edits.segments.splice(
    i,
    1,
    { start: seg.start, end: t },
    { start: t, end: seg.end },
  );
  selectItem("clip");
  selected = i + 1;
  changed();
}
function removeClip() {
  if (!edits || edits.segments.length < 2) return;
  pause();
  recordHistory();
  edits.segments.splice(selected, 1);
  selectItem("none");
  selected = Math.min(selected, edits.segments.length - 1);
  changed();
  syncMedia(true);
}
$("#split").onclick = split;
function removeSelected() {
  if (!edits || busy || recordId) return;
  normalizeSelection();
  if (selectionKind === "range" && selectedRange) {
    try {
      const next = removeTimelineRange(edits, selectedRange);
      if (next === edits) return;
      pause();
      recordHistory();
      playhead = Math.min(selectedRange.start, duration(next));
      edits = next;
      selectItem("none");
      changed();
      syncMedia(true);
    } catch (e) {
      error(e);
    }
    return;
  }
  if (selectionKind === "media") {
    canvasMedia.remove();
    return;
  }
  if (selectionKind === "zoom") {
    removeZoom();
    return;
  }
  if (selectionKind === "audio" && selectedAudio) {
    pause();
    recordHistory();
    edits.removedAudio = mergeRanges([
      ...(edits.removedAudio || []),
      selectedAudio,
    ]);
    selectItem("none");
    changed();
    syncMedia(true);
    return;
  }
  if (selectionKind === "clip") removeClip();
}
$("#delete").onclick = removeSelected;
$("#remove-range").onclick = removeSelected;
for (const key of [
  "padding",
  "zoom",
  "cameraSize",
  "cameraMargin",
  "cameraRoundness",
  "volume",
  "microphoneVolume",
  "cameraOffset",
  "cursorSize",
  "cursorSmoothing",
  "speed",
] as const) {
  const el = $<HTMLInputElement>("#" + key);
  if (el.type !== "range") {
    el.addEventListener("change", () => {
      const value = Number(el.value);
      if (Number.isFinite(value)) setStyle(key, value);
    });
    continue;
  }
  let gesturing = false;
  el.addEventListener("input", () => {
    if (!edits) return;
    if (!gesturing) {
      pause();
      recordHistory();
      gesturing = true;
    }
    if (key === "speed" && selectionKind === "range") selectItem("none");
    edits.style[key] = Number(el.value);
    if (key === "cameraRoundness")
      edits.style.cameraShape =
        edits.style.cameraRoundness === 1 ? "circle" : "square";
    changed();
    syncMedia();
  });
  el.addEventListener("change", () => {
    gesturing = false;
  });
  el.addEventListener("blur", () => {
    gesturing = false;
  });
}
for (const key of ["cameraShape", "cameraCorner", "background"] as const)
  $<HTMLInputElement>("#" + key).addEventListener("change", (e) =>
    setStyle(key, (e.target as HTMLInputElement).value),
  );
for (const key of [
  "showCursor",
  "cursorClicks",
  "cameraFlip",
  "enhanceAudio",
] as const)
  $("#" + key).addEventListener("change", (e) =>
    setStyle(key, (e.target as HTMLInputElement).checked),
  );
function updateEnhanceStatus() {
  if (!document.querySelector("#enhanceAudio")) return;
  const enabled = !!edits?.style.enhanceAudio;
  $<HTMLInputElement>("#enhanceAudio").checked = enabled;
  const model = audioModel(edits?.style.audioEnhancementModel);
  const modelSelect = $<HTMLSelectElement>("#audioEnhancementModel");
  modelSelect.value = model.id;
  modelSelect.disabled = !project;
  $("#audio-model-description").textContent = model.description;
  $<HTMLInputElement>("#enhanceAudio").disabled =
    !project ||
    !(
      project.tracks.screen.audio ||
      project.tracks.microphone?.audio ||
      Object.values(project.assets || {}).some((a) => a.audio && a.timeMap)
    );
  const status = $("#enhance-audio-status");
  status.hidden = !enabled || (!enhancedAudio.pending && !enhancedAudio.error);
  status.textContent = enhancedAudio.pending
    ? enhancedAudio.message || `Enhancing with ${model.name}…`
    : enhancedAudio.error
      ? /no space left|ENOSPC|disk space/i.test(enhancedAudio.error)
        ? "Not enough disk space. Free some space, then retry."
        : `Couldn't enhance with ${model.name}. Retry or choose another model.`
      : "";
  status.title = enhancedAudio.error;
  $("#retry-enhance-audio").hidden = !enabled || !enhancedAudio.error;
  $<HTMLButtonElement>("#play").disabled =
    !project || (enabled && (enhancedAudio.pending || !!enhancedAudio.error));
}
$("#audioEnhancementModel").addEventListener("change", (e) => {
  const model = audioModel(
    (e.target as HTMLSelectElement).value as Style["audioEnhancementModel"],
  );
  setStyle("audioEnhancementModel", model.id);
});
$("#retry-enhance-audio").onclick = () => {
  if (project && edits) {
    enhancedAudio.reset();
    enhancedAudio.configure(project, edits);
  }
};
$("#showCamera").addEventListener("change", (e) =>
  setStyle("showCamera", (e.target as HTMLInputElement).checked),
);
document
  .querySelectorAll<HTMLElement>(".swatch")
  .forEach(
    (el) => (el.onclick = () => setStyle("background", el.dataset.color!)),
  );
function trimClip(side: "start" | "end", value: number) {
  if (!edits || !project) return;
  const seg = edits.segments[selected];
  const start = side === "start" ? value : seg.start,
    end = side === "end" ? value : seg.end;
  if (
    !Number.isFinite(value) ||
    start < 0 ||
    end > project.duration ||
    end - start < 0.05 ||
    (selected > 0 && start < edits.segments[selected - 1].end) ||
    (selected < edits.segments.length - 1 &&
      end > edits.segments[selected + 1].start)
  ) {
    toast("Keep the clip within its neighboring source boundaries.", "error");
    update();
    return;
  }
  pause();
  recordHistory();
  seg[side] = value;
  changed();
  syncMedia(true);
}
for (const side of ["start", "end"] as const)
  $("#trim-" + side).addEventListener("change", (e) =>
    trimClip(side, Number((e.target as HTMLInputElement).value)),
  );
async function importProject() {
  if (busy || recordId || !(await canReplace())) return;
  pause();
  busy = true;
  const buttons = [
    "import",
    "welcome-import",
    "media-start",
    "record-use-media",
  ].map((id) => $<HTMLButtonElement>("#" + id));
  buttons.forEach((b) => (b.disabled = true));
  try {
    const p = await api.importMedia();
    if (p) {
      await load(p);
      setPanel("media");
    }
  } finally {
    busy = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}
$("#import").onclick = $("#welcome-import").onclick = () => task(importProject);
$("#record-use-media").onclick = () => {
  $<HTMLDialogElement>("#record-dialog").close();
  void task(importProject);
};
async function attachWebcam() {
  if (!project || busy || recordId || !(await commitRename())) return;
  const p = project,
    button = $<HTMLButtonElement>("#attach-camera");
  pause();
  busy = true;
  button.disabled = true;
  button.textContent = "Adding webcam…";
  try {
    const next = await api.attachCamera(p.id, p.revision);
    if (!next || project !== p) return;
    p.tracks = next.tracks;
    p.revision = next.revision;
    const camera = p.tracks.camera!;
    media.camera.src = camera.url;
    media.camera.load();
    const signal = thumbnailAbort.signal;
    void loadFilmstrip(camera.url, camera.duration, signal)
      .then((frames) => {
        if (project !== p || signal.aborted) return;
        filmstrips.camera = frames;
        renderTimeline();
      })
      .catch(() => {});
    selectSourceTrack("camera");
    syncMedia(true);
  } finally {
    busy = false;
    button.disabled = false;
    button.innerHTML = `${icon("camera", 15)}Add webcam video`;
  }
}
$("#demo").onclick = () =>
  task(async () => {
    if (!(await canReplace())) return;
    $<HTMLButtonElement>("#demo").disabled = true;
    $("#demo").textContent = "Preparing sample…";
    try {
      await load(await api.demo());
    } finally {
      $<HTMLButtonElement>("#demo").disabled = false;
      $("#demo").textContent = "Explore a sample project →";
    }
  });
let recordingDevices: MediaDeviceInfo[] = [];
let cameraPreviewStream: MediaStream | null = null;
let cameraPreviewGeneration = 0;
let cameraPreviewLoading = false;
let cameraPreviewTask: Promise<void> = Promise.resolve();
let previewClosing: Promise<void> = Promise.resolve();
function releaseCameraPreview() {
  ++cameraPreviewGeneration;
  cameraPreviewLoading = false;
  cameraPreviewStream?.getTracks().forEach((t) => t.stop());
  cameraPreviewStream = null;
  if (!recordId) {
    recordingPreview?.close();
    recordingPreview = null;
    previewClosing = api.closeRecordingPreview();
  }
}
async function openCameraPreview() {
  const generation = ++cameraPreviewGeneration;
  const id = $<HTMLSelectElement>("#record-camera").value;
  cameraPreviewStream?.getTracks().forEach((t) => t.stop());
  cameraPreviewStream = null;
  recordingPreview?.setStream(null);
  $("#record-camera-error").hidden = true;
  if (!id) {
    releaseCameraPreview();
    updateRecordingAvailability();
    return;
  }
  cameraPreviewLoading = true;
  updateRecordingAvailability();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: id === "default" ? undefined : { exact: id },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: 30,
      },
      audio: false,
    });
    await previewClosing;
    if (
      generation !== cameraPreviewGeneration ||
      !$<HTMLDialogElement>("#record-dialog").open
    ) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    cameraPreviewStream = stream;
    if (recordingPreview) recordingPreview.setStream(stream);
    else
      recordingPreview = createRecordingPreview(
        stream,
        () => void stopRecording(),
        () => void api.hideRecordingPreview(),
        (gesture) => api.resizeRecordingPreview(gesture),
        false,
      );
    await api.showRecordingPreview();
  } catch (e) {
    if (generation !== cameraPreviewGeneration) return;
    releaseCameraPreview();
    $("#record-camera-error").textContent =
      "Camera unavailable. Select it again to retry, or choose Off.";
    $("#record-camera-error").hidden = false;
  } finally {
    if (generation === cameraPreviewGeneration) cameraPreviewLoading = false;
    updateRecordingAvailability();
  }
}
$<HTMLDialogElement>("#record-dialog").addEventListener("close", () => {
  ++recordingDialogRequest;
  if (!recordId) releaseCameraPreview();
});
$<HTMLDialogElement>("#record-dialog").addEventListener("cancel", (e) => {
  if (busy) e.preventDefault();
});
$("#record-camera").onchange = () => {
  void saveRecordingPreferences({
    camera: devicePreference(
      $<HTMLSelectElement>("#record-camera").value,
      recordingDevices,
    ),
  }).catch(error);
  cameraPreviewTask = openCameraPreview();
};
$("#record-microphone").onchange = () =>
  void saveRecordingPreferences({
    microphone: devicePreference(
      $<HTMLSelectElement>("#record-microphone").value,
      recordingDevices,
    ),
  }).catch(error);
$("#record-system").onchange = () =>
  void saveRecordingPreferences({
    systemAudio: $<HTMLInputElement>("#record-system").checked,
  }).catch(error);
document.querySelectorAll<HTMLInputElement>("[data-auto-zoom]").forEach(
  (input) =>
    (input.onchange = () => {
      const autoZoom = Object.fromEntries(
        [
          ...document.querySelectorAll<HTMLInputElement>("[data-auto-zoom]"),
        ].map((i) => [i.dataset.autoZoom!, i.checked]),
      ) as AutoZoomOptions;
      void saveRecordingPreferences({ autoZoom }).catch(error);
    }),
);
let refreshingInteractionAccess = false,
  interactionReady = false,
  sourcesLoading = false,
  sourcesFailed = false,
  sourcesRequest = 0,
  devicesLoading = false,
  recordingDialogRequest = 0;
let sourceFilter: "screen" | "window" = "screen";
function updateRecordingAvailability() {
  const start = $<HTMLButtonElement>("#start-record");
  start.disabled =
    !sourceId ||
    sourcesLoading ||
    devicesLoading ||
    cameraPreviewLoading ||
    !interactionReady ||
    refreshingInteractionAccess ||
    busy;
  start.title = !sourceId
    ? "Choose a screen or window"
    : !interactionReady
      ? "Allow text tracking access before recording"
      : "Record · stop with ⌘⇧2";
  $("#record-status").textContent = sourcesLoading
    ? "Loading sources"
    : sources.find((s) => s.id === sourceId)?.name || "Choose a source";
}
async function refreshInteractionAccess(request = false) {
  if (refreshingInteractionAccess || recordId) return false;
  refreshingInteractionAccess = true;
  interactionReady = false;
  updateRecordingAvailability();
  const button = $<HTMLButtonElement>("#interaction-enable"),
    notice = $(".interaction-setup"),
    status = $("#interaction-access-status");
  button.disabled = true;
  try {
    const access = await api.interactionAccess(request);
    interactionReady =
      access.available && access.accessibility && access.inputMonitoring;
    notice.hidden = interactionReady;
    status.textContent = !access.available
      ? "Screen recording requires macOS 15+"
      : "Text tracking needs access";
    notice.title =
      "Automatic zooms require Accessibility and Input Monitoring. Clicks, typing and selections are always tracked; only timing and positions are saved.";
    button.hidden = !access.available || interactionReady;
    button.textContent = "Allow access";
    if (request && !interactionReady && access.available)
      toast(
        "Allow Open Record Studio in Privacy & Security, then return here.",
      );
  } catch {
    notice.hidden = false;
    status.textContent = "Access check failed";
    notice.title = "Could not check Accessibility and Input Monitoring access.";
    button.textContent = "Retry";
    button.hidden = false;
  } finally {
    button.disabled = false;
    refreshingInteractionAccess = false;
    updateRecordingAvailability();
  }
  return interactionReady;
}
$("#interaction-enable").onclick = () => void refreshInteractionAccess(true);
window.addEventListener("focus", () => {
  if ($<HTMLDialogElement>("#record-dialog").open)
    void refreshInteractionAccess();
});
function renderCaptureSources() {
  const list = $("#source-list");
  list.setAttribute("aria-busy", String(sourcesLoading));
  list.setAttribute("aria-labelledby", `capture-${sourceFilter}-tab`);
  document
    .querySelectorAll<HTMLButtonElement>("[data-source-filter]")
    .forEach((button) => {
      const selected = button.dataset.sourceFilter === sourceFilter;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  $<HTMLButtonElement>("#refresh-sources").disabled = sourcesLoading;
  $("#refresh-sources").hidden = sourcesFailed;
  if (sourcesLoading) {
    list.innerHTML =
      '<div class="source-skeleton" aria-hidden="true"></div><div class="source-skeleton" aria-hidden="true"></div>';
  } else if (sourcesFailed) {
    list.innerHTML = `<div class="capture-empty" role="status">${icon("screen", 26)}<span>Screen sources unavailable</span><div><button data-capture-retry>Retry</button><button data-capture-settings class="text-button" title="Open Screen Recording settings in macOS">Settings</button></div></div>`;
  } else {
    const visible = sources.filter((s) => s.id.startsWith(sourceFilter + ":"));
    list.innerHTML =
      visible
        .map(
          (s) =>
            `<button class="source ${s.id === sourceId ? "selected" : ""}" data-source="${escape(s.id)}" aria-pressed="${s.id === sourceId}" title="${escape(s.name)}"><div class="source-thumbnail"><img src="${s.thumbnail}" alt=""/><i>${icon("check", 12)}</i></div><span>${escape(s.name)}</span></button>`,
        )
        .join("") ||
      `<div class="capture-empty">${icon(sourceFilter === "screen" ? "screen" : "layers", 26)}<span>No ${sourceFilter === "screen" ? "screens" : "windows"} available</span></div>`;
  }
  updateRecordingAvailability();
}
$("#source-list").onclick = (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!target) return;
  if (target.hasAttribute("data-capture-retry"))
    return void refreshCaptureSources();
  if (target.hasAttribute("data-capture-settings"))
    return void task(() => api.openScreenSettings());
  if (target.dataset.source) {
    sourceId = target.dataset.source;
    // Preserve keyboard focus when changing the selected card.
    $("#source-list")
      .querySelectorAll<HTMLButtonElement>("[data-source]")
      .forEach((button) => {
        const selected = button === target;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
    updateRecordingAvailability();
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-source-filter]",
)) {
  button.onclick = () => {
    sourceFilter = button.dataset.sourceFilter as "screen" | "window";
    sourceId =
      sources.find((s) => s.id.startsWith(sourceFilter + ":"))?.id || "";
    renderCaptureSources();
  };
  button.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "screen"
        : event.key === "End"
          ? "window"
          : sourceFilter === "screen"
            ? "window"
            : "screen";
    const tab = $<HTMLButtonElement>(`#capture-${next}-tab`);
    tab.click();
    tab.focus();
  };
}
async function refreshCaptureSources() {
  if (busy || recordId) return;
  const request = ++sourcesRequest;
  sourcesLoading = true;
  sourcesFailed = false;
  renderCaptureSources();
  try {
    const available = await api.sources();
    if (request !== sourcesRequest) return;
    sources = available;
    sourcesFailed = !available.length;
    if (
      !sources.some(
        (s) => s.id === sourceId && s.id.startsWith(sourceFilter + ":"),
      )
    )
      sourceId =
        sources.find((s) => s.id.startsWith(sourceFilter + ":"))?.id || "";
  } catch {
    if (request !== sourcesRequest) return;
    sources = [];
    sourceId = "";
    sourcesFailed = true;
  } finally {
    if (request === sourcesRequest) {
      sourcesLoading = false;
      renderCaptureSources();
    }
  }
}
$("#refresh-sources").onclick = () => void refreshCaptureSources();
async function recordDialog() {
  if (recordId || busy) return;
  pause();
  sourceFilter = "screen";
  sourceId = "";
  sources = [];
  devicesLoading = true;
  const request = ++recordingDialogRequest;
  $(".interaction-setup").hidden = true;
  modal("#record-dialog");
  void refreshInteractionAccess();
  void refreshCaptureSources();
  for (const id of ["record-camera", "record-microphone"])
    $<HTMLSelectElement>("#" + id).disabled = true;
  try {
    const [devices, preferences] = await Promise.all([
      navigator.mediaDevices.enumerateDevices(),
      loadRecordingPreferences(),
    ]);
    if (request !== recordingDialogRequest) return;
    recordingDevices = devices;
    populateDevices(
      $("#record-camera"),
      devices,
      "videoinput",
      preferences.camera,
      "Camera",
    );
    populateDevices(
      $("#record-microphone"),
      devices,
      "audioinput",
      preferences.microphone,
      "Microphone",
    );
    $<HTMLInputElement>("#record-system").checked = preferences.systemAudio;
    document
      .querySelectorAll<HTMLInputElement>("[data-auto-zoom]")
      .forEach(
        (input) =>
          (input.checked =
            preferences.autoZoom[
              input.dataset.autoZoom as keyof AutoZoomOptions
            ]),
      );
    cameraPreviewTask = openCameraPreview();
    await cameraPreviewTask;
  } catch {
    if (request !== recordingDialogRequest) return;
    for (const id of ["record-camera", "record-microphone"])
      $<HTMLSelectElement>("#" + id).replaceChildren(new Option("Off", ""));
  } finally {
    if (request === recordingDialogRequest) {
      devicesLoading = false;
      for (const id of ["record-camera", "record-microphone"])
        $<HTMLSelectElement>("#" + id).disabled = false;
      updateRecordingAvailability();
    }
  }
}
$("#new-recording").onclick = () => {
  if (!project) return void task(recordDialog);
  if (busy || recordId || saving) return;
  $("#record-webcam-time").textContent = clock(playhead);
  const menu = $("#record-menu"),
    rect = $("#new-recording").getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, innerWidth - 280)}px`;
  menu.style.top = `${rect.bottom + 8}px`;
  menu.showPopover();
};
$("#record-new-screen").onclick = () => {
  $("#record-menu").hidePopover();
  void task(recordDialog);
};
$("#record-webcam-here").onclick = () => {
  $("#record-menu").hidePopover();
  void task(() => webcamTake.open());
};
$("#welcome-record").onclick = () => task(recordDialog);
async function startRecording() {
  if (!sourceId || !(await canReplace()) || !(await refreshInteractionAccess()))
    return;
  busy = true;
  for (const el of document.querySelectorAll<HTMLInputElement>(
    "#record-dialog select, #record-dialog input, #record-dialog .close-dialog, #record-use-media",
  ))
    el.disabled = true;
  $<HTMLButtonElement>("#start-record").disabled = true;
  recorders = [];
  streams = [];
  recordMetadata = {};
  recordError = "";
  writeQueue = Promise.resolve();
  try {
    // Always capture an editable pointer when supported; appearance belongs in the editor.
    nativeRecording = (await api.status()).nativeCapture;
    if (!nativeRecording)
      throw new Error(
        "Screen recording with text tracking requires macOS 15 or later.",
      );
    await api.selectSource(sourceId);
    const cameraId = $<HTMLSelectElement>("#record-camera").value,
      micId = $<HTMLSelectElement>("#record-microphone").value;
    const captures: Record<string, MediaStream> = {};
    await cameraPreviewTask;
    await flushRecordingPreferences();
    if (cameraId) {
      if (
        !cameraPreviewStream
          ?.getVideoTracks()
          .some((t) => t.readyState === "live")
      )
        throw new Error(
          "Select your camera again to reconnect it before recording.",
        );
      captures.camera = cameraPreviewStream;
      cameraPreviewStream = null; // MediaRecorder owns this stream until Stop.
      streams.push(captures.camera);
    }
    if (micId) {
      captures.microphone = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: micId === "default" ? undefined : { exact: micId },
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
      streams.push(captures.microphone);
    }
    if (!nativeRecording) {
      captures.screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: $<HTMLInputElement>("#record-system").checked,
      });
      streams.push(captures.screen);
    }
    const session = await api.begin();
    if (!session) {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      releaseCameraPreview();
      cameraPreviewTask = openCameraPreview();
      return;
    }
    recordId = session.id;
    recordingPreview?.setRecording(true);
    const byTrack: Record<string, MediaRecorder> = {};
    for (const key of ["screen", "camera", "microphone"]) {
      const stream = captures[key];
      if (!stream) continue;
      const types =
        key === "microphone"
          ? ["audio/webm;codecs=opus", "audio/webm"]
          : [
              "video/webm;codecs=vp9,opus",
              "video/webm;codecs=vp8,opus",
              "video/webm",
            ];
      const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
      if (!mimeType)
        throw new Error("This runtime has no supported recording codec");
      const recorder = new MediaRecorder(stream, {
        mimeType,
        ...(key === "microphone"
          ? { audioBitsPerSecond: 192000 }
          : { videoBitsPerSecond: key === "screen" ? 18000000 : 8000000 }),
      });
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        const id = recordId;
        writeQueue = writeQueue
          .then(async () => {
            await api.append(id, key, await e.data.arrayBuffer());
          })
          .catch((e) => {
            recordError = String(e);
            if (!busy) void stopRecording();
          });
      };
      recorder.onerror = () => {
        recordError =
          "The recorder encountered an error. Captured media has been kept for recovery.";
        if (!busy) void stopRecording();
      };
      recorders.push(recorder);
      byTrack[key] = recorder;
    }
    const startTrack = async (key: string) => {
      if (byTrack[key]) recordMetadata[key] = await startRecorder(byTrack[key]);
    };
    // Establish camera/microphone coverage before the screen clock begins.
    // Negative track offsets retain synchronization and trim only preroll.
    await Promise.all([startTrack("camera"), startTrack("microphone")]);
    if (nativeRecording)
      recordMetadata.screen = await api.startNative(
        recordId,
        $<HTMLInputElement>("#record-system").checked,
      );
    else await startTrack("screen");
    if (recordError) throw new Error(recordError);
    recordStarted = recordMetadata.screen.startedAt;
    if (captures.screen)
      captures.screen.getVideoTracks()[0].onended = () => void stopRecording();
    $<HTMLDialogElement>("#record-dialog").close();
    $("#recording-banner").hidden = false;
    timer = setInterval(() => {
      const elapsed = (Date.now() - recordStarted) / 1000;
      $("#record-clock").textContent = clock(elapsed);
      recordingPreview?.tick(elapsed);
    }, 100);
    await api.recordingReady();
  } catch (e) {
    recordingPreview?.close();
    recordingPreview = null;
    if (timer) clearInterval(timer);
    timer = null;
    $("#recording-banner").hidden = true;
    for (const recorder of recorders) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    await writeQueue;
    if (recordId) await api.abort(recordId);
    recordId = "";
    nativeRecording = false;
    releaseCameraPreview();
    error(e);
    if ($<HTMLDialogElement>("#record-dialog").open)
      cameraPreviewTask = openCameraPreview();
  } finally {
    busy = false;
    for (const el of document.querySelectorAll<HTMLInputElement>(
      "#record-dialog select, #record-dialog input, #record-dialog .close-dialog, #record-use-media",
    ))
      el.disabled = false;
    updateRecordingAvailability();
  }
}
async function stopRecording() {
  if (recordingStartup) await recordingStartup;
  if (!recordId || stopping) return;
  stopping = true;
  const id = recordId;
  recordingPreview?.close();
  recordingPreview = null;
  $("#record-clock").textContent = "Saving…";
  try {
    const nativeStopped = nativeRecording
      ? api.stopNative(id)
      : Promise.resolve();
    await Promise.all(
      recorders.map(
        (r) =>
          new Promise<void>((resolve) => {
            if (r.state === "inactive") return resolve();
            r.addEventListener("stop", () => resolve(), { once: true });
            r.stop();
          }),
      ),
    );
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    await Promise.all([writeQueue, nativeStopped]);
    if (recordError) {
      await api.abort(id);
      throw new Error(recordError);
    }
    const recorded = await api.finish(id, recordMetadata);
    await load(recorded);
    const zoomCount = recorded.edits.zooms?.length ?? 0;
    toast(
      recorded.interactions
        ? zoomCount
          ? `Recording saved with ${zoomCount} automatic zoom${zoomCount === 1 ? "" : "s"}.`
          : "Recording saved. Your interaction metadata is ready."
        : "Recording saved. Your tracks are ready to edit.",
    );
  } catch (e) {
    await api.abort(id).catch(() => {});
    error(e);
  } finally {
    if (timer) clearInterval(timer);
    recordId = "";
    nativeRecording = false;
    stopping = false;
    $("#recording-banner").hidden = true;
  }
}
const webcamTake = new WebcamTake({
  state: () => ({
    project,
    time: playhead,
    total: edits ? duration(edits) : 0,
    playing,
    layerCount: edits?.layers?.length || 0,
  }),
  prepare: async () => {
    if (saving) throw new Error("Wait for the project to finish saving");
    await save();
    if (dirty) throw new Error("Save the project before recording");
  },
  play: () => {
    if (!playing) togglePlay();
  },
  pause,
  preview: (stream) => {
    liveTakePreview.srcObject = stream;
    if (stream) void liveTakePreview.play().catch(error);
    else liveTakePreview.pause();
    redraw = true;
  },
  block: (active) => {
    busy = active;
    $(".workspace").inert = active;
    $(".titlebar").inert = active;
  },
  commit: (next, layerId, time) => {
    recordHistory();
    project = next;
    edits = structuredClone(next.edits);
    dirty = false;
    externalChange = false;
    update();
    canvasMedia.select(layerId);
    seek(time);
    update();
    toast("Webcam take added at " + clock(time));
  },
  error,
});
let recordingStartup: Promise<void> | null = null;
let recordingPreview: ReturnType<typeof createRecordingPreview> | null = null;
$("#start-record").onclick = () =>
  task(async () => {
    recordingStartup = startRecording();
    try {
      await recordingStartup;
    } finally {
      recordingStartup = null;
    }
  });
const stopAnyRecording = () =>
  webcamTake.active ? webcamTake.stop() : stopRecording();
$("#stop-record").onclick = () => task(stopAnyRecording);
api?.onStop(() => void stopAnyRecording());
function refreshExportControls() {
  const gif = $<HTMLSelectElement>("#export-format").value === "gif";
  $("#export-audio-row").hidden = gif;
  $<HTMLInputElement>("#export-audio").disabled = busy || gif;
  $("#export-format-note").textContent = gif
    ? "Loops continuously · No audio"
    : "Video with optional audio.";
  $("#combined-export-label").textContent = gif
    ? "Combined GIF"
    : "Combined video";
  $("#separate-export-description").textContent =
    `Full-frame screen and webcam ${gif ? "GIFs" : "MP4s"}.`;
  $("#start-export").innerHTML =
    `${icon("upload")}Export ${gif ? "GIF" : "video"}`;
  $("#export-summary").textContent =
    `${edits ? clock(duration(edits)) + " · " : ""}${gif ? "Animated GIF" : "H.264 · MP4"}`;
  for (const id of ["separate-card", "both-card"]) {
    const el = $("#" + id);
    el.classList.toggle("unavailable", !project?.tracks.camera);
    el.querySelector<HTMLInputElement>("input")!.disabled =
      busy || !project?.tracks.camera;
  }
  if (!project?.tracks.camera)
    $<HTMLInputElement>("[name=mode][value=combined]").checked = true;
  if (project && edits) {
    const size = compositionSize(
      edits.style,
      Number($<HTMLSelectElement>("#export-height").value),
      project.tracks.screen,
    );
    $("#export-dimensions").textContent =
      `Composition: ${size.width} × ${size.height} px · ${edits.style.aspectRatio === "source" ? "Source ratio" : edits.style.aspectRatio}`;
    for (const option of $<HTMLSelectElement>("#export-height").options) {
      const dimensions = compositionSize(
        edits.style,
        Number(option.value),
        project.tracks.screen,
      );
      option.textContent = `${option.value === "2160" ? "4K" : option.value} · ${dimensions.width} × ${dimensions.height}`;
    }
  }
  const combined = $<HTMLInputElement>("[name=mode][value=combined]").checked;
  $("#export-audio-label").textContent = combined
    ? "Include audio"
    : "Audio: system → screen · microphone → webcam";
}
let exportFormat: ExportOptions["format"] = "mp4";
const exportSelections = {
  mp4: { height: 1080, fps: 60 },
  gif: { height: 480, fps: 20 },
};
$("#export-format").addEventListener("change", () => {
  const height = $<HTMLSelectElement>("#export-height"),
    fps = $<HTMLSelectElement>("#export-fps");
  exportSelections[exportFormat] = {
    height: Number(height.value),
    fps: Number(fps.value),
  };
  exportFormat = $<HTMLSelectElement>("#export-format")
    .value as ExportOptions["format"];
  const settings = exportFormats[exportFormat];
  height.innerHTML = settings.heights
    .map((h) => `<option value="${h}">${h === 2160 ? "4K" : h + "p"}</option>`)
    .join("");
  fps.innerHTML = settings.frameRates
    .map((f) => `<option value="${f}">${f} fps</option>`)
    .join("");
  height.value = String(exportSelections[exportFormat].height);
  fps.value = String(exportSelections[exportFormat].fps);
  refreshExportControls();
});
for (const el of document.querySelectorAll<HTMLInputElement>(
  "[name=mode], #export-audio, #export-height",
))
  el.addEventListener("change", refreshExportControls);
$("#export").onclick = () =>
  task(async () => {
    if (!edits || !project || !(await commitRename())) return;
    pause();
    refreshExportControls();
    $("#export-progress").hidden = true;
    modal("#export-dialog");
  });
api?.onProgress((p) => {
  $("#export-progress").hidden = false;
  $("#export-progress .progress-track div").style.width =
    `${Math.round(p.ratio * 100)}%`;
  const text = exportProgressText(p);
  $("#export-progress-label").textContent = text.label;
  $("#export-progress-time").textContent = text.time;
});
$("#start-export").onclick = () =>
  task(async () => {
    if (!edits) return;
    busy = true;
    $<HTMLButtonElement>("#start-export").disabled = true;
    $("#cancel-export").hidden = false;
    document
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "#export-dialog input, #export-dialog select",
      )
      .forEach((e) => (e.disabled = true));
    const options: ExportOptions = {
      format: exportFormat,
      mode: $<HTMLInputElement>("[name=mode]:checked")
        .value as ExportOptions["mode"],
      height: Number($<HTMLSelectElement>("#export-height").value),
      fps: Number($<HTMLSelectElement>("#export-fps").value),
      quality: $<HTMLSelectElement>("#export-quality").value,
      audio:
        exportFormat === "mp4" && $<HTMLInputElement>("#export-audio").checked,
    };
    try {
      const result = await api.export(edits, options);
      if (result) {
        $<HTMLDialogElement>("#export-dialog").close();
        toast(
          `Exported ${result.files.length} ${options.format === "gif" ? "GIF" : "video"}${result.files.length === 1 ? "" : "s"} successfully.`,
        );
        await api.reveal();
      }
    } finally {
      busy = false;
      $<HTMLButtonElement>("#start-export").disabled = false;
      $("#cancel-export").hidden = true;
      document
        .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          "#export-dialog input, #export-dialog select",
        )
        .forEach((e) => (e.disabled = false));
      refreshExportControls();
    }
  });
$("#cancel-export").onclick = () => task(() => api.cancelExport());
document.addEventListener("keydown", (e) => {
  if (webcamTake.active) {
    e.preventDefault();
    if ((e.code === "Space" || e.key === "Escape") && !e.repeat)
      void webcamTake.stop();
    return;
  }
  const target = e.target instanceof HTMLElement ? e.target : document.body;
  if (
    e.defaultPrevented ||
    e.isComposing ||
    document.querySelector("dialog[open]") ||
    target.isContentEditable
  )
    return;
  if (cancelTimelineGesture) {
    e.preventDefault();
    return;
  }
  if (e.key === "Escape" && pickingZoomFocus) {
    e.preventDefault();
    pickingZoomFocus = "";
    update();
    return;
  }
  if (e.key === "Escape" && selectionKind === "range") {
    e.preventDefault();
    selectItem("none");
    update();
    return;
  }
  // Clips are buttons and scrubbing focuses a range input. Space remains the
  // transport shortcut in both cases, rather than activating the focused UI.
  if (
    e.code === "Space" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey
  ) {
    if (
      !edits ||
      busy ||
      recordId ||
      target.closest('input:not([type="range"]), select, textarea')
    )
      return;
    e.preventDefault();
    if (!e.repeat) togglePlay();
    return;
  }
  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  ) {
    if (
      busy ||
      recordId ||
      target.closest(
        'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), select, textarea',
      )
    )
      return;
    e.preventDefault();
    if (!e.repeat) removeSelected();
    return;
  }
  if (/INPUT|SELECT|TEXTAREA/.test(target.tagName)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    void task(save);
  } else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (e.key === "s") split();
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (!edits) return;
    e.preventDefault();
    seek(
      Math.max(
        0,
        Math.min(
          duration(edits),
          playhead +
            (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 1 / 30),
        ),
      ),
    );
  } else if (e.key === "Escape" && activePanel !== "appearance")
    setPanel("appearance");
});
update();
if (api)
  void task(async () => {
    const status = await api.status();
    if (!status.ffmpeg)
      toast(
        "FFmpeg is required for recording and export. Install it with Homebrew.",
        "error",
      );
    if (status.project) await load(status.project);
  });
else
  toast(
    "Launch Open Record Studio as a desktop app to record, import, and export.",
  );
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
