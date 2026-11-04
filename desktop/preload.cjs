const { contextBridge, ipcRenderer } = require("electron");
const invoke =
  (name) =>
  (...args) =>
    ipcRenderer.invoke("frame:" + name, ...args);
contextBridge.exposeInMainWorld(
  "studio",
  Object.freeze({
    status: invoke("status"),
    appUpdateState: invoke("appUpdateState"),
    checkAppUpdate: invoke("checkAppUpdate"),
    installAppUpdate: invoke("installAppUpdate"),
    onAppUpdate: (fn) => {
      const listener = (_, data) => fn(data);
      ipcRenderer.on("frame:update-state", listener);
      return () => ipcRenderer.removeListener("frame:update-state", listener);
    },
    onInstallAppUpdate: (fn) => {
      const listener = () => fn();
      ipcRenderer.on("frame:install-update", listener);
      return () => ipcRenderer.removeListener("frame:install-update", listener);
    },
    transcribe: invoke("transcribe"),
    cancelTranscription: invoke("cancelTranscription"),
    copyTranscript: invoke("copyTranscript"),
    onTranscriptProgress: (fn) => {
      const listener = (_, data) => fn(data);
      ipcRenderer.on("frame:transcript-progress", listener);
      return () =>
        ipcRenderer.removeListener("frame:transcript-progress", listener);
    },
    waveforms: invoke("waveforms"),
    assetWaveform: invoke("assetWaveform"),
    enhanceAudio: invoke("enhanceAudio"),
    cancelEnhanceAudio: invoke("cancelEnhanceAudio"),
    onEnhanceProgress: (fn) => {
      const listener = (_, data) => fn(data);
      ipcRenderer.on("frame:enhance-progress", listener);
      return () =>
        ipcRenderer.removeListener("frame:enhance-progress", listener);
    },
    sources: invoke("sources"),
    openScreenSettings: invoke("openScreenSettings"),
    interactionAccess: invoke("interactionAccess"),
    selectSource: invoke("selectSource"),
    recordingPreferences: invoke("recordingPreferences"),
    updateRecordingPreferences: invoke("updateRecordingPreferences"),
    showRecordingPreview: invoke("showRecordingPreview"),
    closeRecordingPreview: invoke("closeRecordingPreview"),
    begin: invoke("begin"),
    beginTake: invoke("beginTake"),
    finishTake: invoke("finishTake"),
    startNative: invoke("startNative"),
    stopNative: invoke("stopNative"),
    recordingReady: invoke("recordingReady"),
    hideRecordingPreview: invoke("hideRecordingPreview"),
    resizeRecordingPreview: invoke("resizeRecordingPreview"),
    append: invoke("append"),
    finish: invoke("finish"),
    abort: invoke("abort"),
    importMedia: invoke("importMedia"),
    attachCamera: invoke("attachCamera"),
    addMedia: invoke("addMedia"),
    open: invoke("open"),
    save: invoke("save"),
    renameProject: invoke("renameProject"),
    projectsFolder: invoke("projectsFolder"),
    chooseProjectsFolder: invoke("chooseProjectsFolder"),
    projectRevision: invoke("projectRevision"),
    reload: invoke("reload"),
    export: invoke("export"),
    cancelExport: invoke("cancelExport"),
    reveal: invoke("reveal"),
    demo: invoke("demo"),
    onProgress: (fn) => {
      const listener = (_, data) => fn(data);
      ipcRenderer.on("frame:progress", listener);
      return () => ipcRenderer.removeListener("frame:progress", listener);
    },
    onStop: (fn) => {
      const listener = () => fn();
      ipcRenderer.on("frame:stop", listener);
      return () => ipcRenderer.removeListener("frame:stop", listener);
    },
  }),
);
