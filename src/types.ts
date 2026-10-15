export type Track = {
  sourceKind?: "image" | "video";
  name?: string;
  file: string;
  url: string;
  offset: number;
  duration: number;
  width: number;
  height: number;
  audio: boolean;
  video: boolean;
};
export type Style = {
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:5" | "4:3" | "3:4" | "source";
  canvasTemplate: string;
  screenFit: "fit" | "fill";
  background: string;
  padding: number;
  cameraSize: number;
  cameraMargin: number;
  cameraCorner: string;
  cameraShape: string;
  cameraRoundness: number;
  cameraFlip: boolean;
  showCamera: boolean;
  zoom: number;
  focusX: number;
  focusY: number;
  speed: number;
  volume: number;
  microphoneVolume: number;
  enhanceAudio: boolean;
  cameraOffset: number;
  showCursor: boolean;
  cursorSize: number;
  cursorSmoothing: number;
  cursorClicks: boolean;
};
export type Zoom = {
  id: string;
  trigger?: "click" | "typing" | "selection" | "scroll" | "drag" | "event";
  mode?: "follow" | "fixed";
  start: number;
  end: number;
  zoom: number;
  focusX: number;
  focusY: number;
  ease: number;
};
export type Cursor = {
  clean: true;
  samples: {
    t: number;
    x: number;
    y: number;
    visible: boolean;
    pressed: boolean;
  }[];
};
export type TakeSample = { output: number; media: number };
export type TakeSpan = {
  start: number;
  end: number;
  mediaStart: number;
  rate: number;
};
export type CanvasAsset = {
  audio?: boolean;
  timeMap?: TakeSpan[];
  file: string;
  url: string;
  name: string;
  sourceKind: "image" | "video";
  width: number;
  height: number;
  duration: number;
};
export type CanvasLayer = {
  roundness?: number;
  flip?: boolean;
  volume?: number;
  id: string;
  assetId: string;
  start: number;
  end: number;
  mediaStart: number;
  x: number;
  y: number;
  width: number;
  opacity: number;
  visible: boolean;
};
export type TimeRange = { start: number; end: number };
export type Edits = {
  removedAudio?: TimeRange[];
  layers?: CanvasLayer[];
  zooms?: Zoom[];
  segments: { start: number; end: number }[];
  style: Style;
};
export type Project = {
  id: string;
  revision: string;
  name: string;
  duration: number;
  directory: string;
  cursor?: Cursor;
  interactions?: {
    version: 1;
    capabilities: Record<string, boolean>;
    permissions: { accessibility: boolean; inputMonitoring: boolean };
    truncated: boolean;
    events: {
      id: string;
      type: string;
      t: number;
      end: number;
      x: number;
      y: number;
      count?: number;
      origin?: "cursor";
    }[];
  };
  assets?: Record<string, CanvasAsset>;
  tracks: { screen: Track; camera?: Track; microphone?: Track };
  edits: Edits;
};
export type Source = {
  id: string;
  name: string;
  thumbnail: string;
  displayId: string;
};
export type ExportOptions = {
  format: "mp4" | "gif";
  mode: "combined" | "separate" | "both";
  height: number;
  fps: number;
  quality: string;
  audio: boolean;
  /** Deprecated: separate output routing follows audio automatically. */
  cameraAudio?: boolean;
};
export type Progress = {
  ratio: number;
  track: string;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  encoder?: string;
};
export type PreviewResize = {
  phase: "start" | "move" | "end" | "cancel";
  corner: "nw" | "ne" | "sw" | "se";
  screenX: number;
  screenY: number;
};
declare global {
  interface Window {
    studio: {
      enhanceAudio: (id: string) => Promise<Record<string, string>>;
      cancelEnhanceAudio: (id: string) => Promise<void>;
      waveforms: (id: string) => Promise<import("./waveform").WaveformTracks>;
      assetWaveform: (
        id: string,
        assetId: string,
      ) => Promise<import("./waveform").Waveform>;
      status: () => Promise<{
        ffmpeg: boolean;
        nativeCapture: boolean;
        screenPermission: string;
        cameraPermission: string;
        microphonePermission: string;
        project: Project | null;
      }>;
      sources: () => Promise<Source[]>;
      openScreenSettings: () => Promise<void>;
      interactionAccess: (request?: boolean) => Promise<{
        available: boolean;
        accessibility: boolean;
        inputMonitoring: boolean;
      }>;
      selectSource: (id: string) => Promise<void>;
      recordingPreferences: () => Promise<
        import("../desktop/recording-options.mjs").RecordingPreferences
      >;
      updateRecordingPreferences: (
        patch: Partial<
          import("../desktop/recording-options.mjs").RecordingPreferences
        >,
      ) => Promise<
        import("../desktop/recording-options.mjs").RecordingPreferences
      >;
      showRecordingPreview: () => Promise<void>;
      closeRecordingPreview: () => Promise<void>;
      begin: () => Promise<{ id: string } | null>;
      beginTake: (
        projectId: string,
        revision: string,
      ) => Promise<{ id: string }>;
      finishTake: (
        id: string,
        samples: TakeSample[],
      ) => Promise<{ project: Project; layerId: string }>;
      startNative: (
        id: string,
        audio: boolean,
      ) => Promise<{ startedAt: number }>;
      stopNative: (id: string) => Promise<void>;
      recordingReady: () => Promise<void>;
      hideRecordingPreview: () => Promise<void>;
      resizeRecordingPreview: (gesture: PreviewResize) => Promise<void>;
      append: (id: string, track: string, bytes: ArrayBuffer) => Promise<void>;
      finish: (
        id: string,
        metadata: Record<string, { startedAt: number }>,
      ) => Promise<Project>;
      abort: (id: string) => Promise<void>;
      importMedia: (
        camera?: boolean,
        imageDuration?: number,
      ) => Promise<Project | null>;
      attachCamera: (
        projectId: string,
        revision: string,
      ) => Promise<Project | null>;
      addMedia: (
        projectId: string,
        remaining: number,
      ) => Promise<Record<string, CanvasAsset> | null>;
      open: () => Promise<Project | null>;
      save: (edits: Edits, revision: string) => Promise<string>;
      renameProject: (
        id: string,
        name: string,
        revision: string,
      ) => Promise<{ name: string; revision: string }>;
      projectsFolder: () => Promise<string | null>;
      chooseProjectsFolder: () => Promise<string | null>;
      projectRevision: () => Promise<string | null>;
      reload: () => Promise<Project>;
      demo: () => Promise<Project>;
      export: (
        edits: Edits,
        options: ExportOptions,
      ) => Promise<{ directory: string; files: string[] } | null>;
      cancelExport: () => Promise<void>;
      reveal: () => Promise<void>;
      onProgress: (fn: (p: Progress) => void) => () => void;
      onStop: (fn: () => void) => () => void;
    };
  }
}
