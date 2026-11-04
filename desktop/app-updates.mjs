import fs from "node:fs/promises";
import path from "node:path";
import {
  releasesAPI,
  selectUpdate,
  validateUpdateManifest,
} from "./update-feed.mjs";

export async function readUpdatePreferences(directory) {
  const value = await fs
    .readFile(path.join(directory, "updates.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  // Existing public builds use the preview channel. Users can opt into stable-only.
  return { includePreviews: value?.includePreviews !== false };
}
export async function saveUpdatePreferences(directory, includePreviews) {
  if (typeof includePreviews !== "boolean")
    throw new Error("Invalid update preference");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "updates.json");
  await fs.writeFile(file + ".tmp", JSON.stringify({ includePreviews }) + "\n");
  await fs.rename(file + ".tmp", file);
}

async function fetchJSON(url, signal, fetcher) {
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: {
      Accept: "application/json",
      "User-Agent": "Open-Record-Studio-Updater",
    },
  });
  if (!response.ok)
    throw new Error(`Update request failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4 * 1024 * 1024)
        throw new Error("Update response is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createAppUpdater({
  nativeUpdater,
  version,
  supported = true,
  includePreviews = true,
  getBlocker = () => "",
  onChange = () => {},
  fetcher = fetch,
  logger = console,
}) {
  let state = {
    status: supported ? "idle" : "unsupported",
    currentVersion: version,
    includePreviews,
  };
  let candidate = null,
    request = null,
    disposed = false;
  const listeners = [];
  const emit = (patch) => {
    if (disposed) return;
    state = { ...state, ...patch };
    onChange({ ...state });
  };
  const fail = (error) => {
    logger.warn("App update:", error?.message || error);
    emit({
      status: "error",
      message:
        "Couldn't download or verify the update. Check your connection and try again.",
    });
  };
  const listen = (event, fn) => {
    nativeUpdater.on(event, fn);
    listeners.push([event, fn]);
  };
  listen("error", (error) => {
    if (state.status === "downloading" || state.status === "installing")
      fail(error);
  });
  listen("update-downloaded", () => {
    if (state.status === "downloading")
      emit({ status: "ready", message: "The update is ready to install." });
  });
  listen("update-not-available", () => {
    if (state.status === "downloading")
      emit({
        status: "error",
        message:
          "This release is no longer available. Check for updates again.",
      });
  });
  function requireIdle() {
    if (!supported)
      throw new Error(
        "In-app updates require the installed Apple silicon Mac app.",
      );
    const reason = getBlocker();
    if (reason) throw new Error(reason);
  }
  return {
    getState: () => ({ ...state }),
    setIncludePreviews(value) {
      if (typeof value !== "boolean")
        throw new Error("Invalid update preference");
      if (["downloading", "ready", "installing"].includes(state.status))
        throw new Error("Finish the current update before changing channels.");
      request?.abort();
      request = null;
      candidate = null;
      emit({
        status: supported ? "idle" : "unsupported",
        includePreviews: value,
        version: undefined,
        releaseURL: undefined,
        message: undefined,
      });
    },
    async check() {
      requireIdle();
      if (
        ["checking", "downloading", "ready", "installing"].includes(
          state.status,
        )
      )
        return { ...state };
      const controller = new AbortController();
      request = controller;
      emit({
        status: "checking",
        message: undefined,
        version: undefined,
        releaseURL: undefined,
      });
      try {
        const releases = await fetchJSON(
          releasesAPI,
          controller.signal,
          fetcher,
        );
        if (request !== controller || disposed) return { ...state };
        candidate = selectUpdate(releases, version, state.includePreviews);
        emit(
          candidate
            ? {
                status: "available",
                version: candidate.version,
                releaseURL: candidate.releaseURL,
                preview: candidate.preview,
                automatic: candidate.automatic,
              }
            : { status: "idle" },
        );
      } catch (error) {
        if (request === controller && !disposed) {
          logger.warn("Update check:", error?.message || error);
          emit({
            status: "error",
            message:
              "Couldn't check for updates. Check your connection and try again.",
          });
        }
      } finally {
        if (request === controller) request = null;
      }
      return { ...state };
    },
    async download() {
      requireIdle();
      if (state.status !== "available" || !candidate?.automatic)
        throw new Error("Check for an available in-app update first.");
      const controller = new AbortController();
      request = controller;
      emit({ status: "downloading", message: "Downloading update…" });
      try {
        const feed = await fetchJSON(
          candidate.feedURL,
          controller.signal,
          fetcher,
        );
        if (disposed) return;
        validateUpdateManifest(feed, candidate);
        requireIdle();
        nativeUpdater.setFeedURL({
          url: candidate.feedURL,
          serverType: "json",
        });
        nativeUpdater.checkForUpdates();
      } catch (error) {
        if (!disposed) fail(error);
      } finally {
        if (request === controller) request = null;
      }
      return { ...state };
    },
    install() {
      requireIdle();
      if (state.status !== "ready")
        throw new Error("Download the update before restarting.");
      emit({ status: "installing", message: "Restarting to update…" });
      try {
        nativeUpdater.quitAndInstall();
      } catch (error) {
        emit({ status: "ready" });
        throw error;
      }
    },
    dispose() {
      disposed = true;
      request?.abort();
      for (const [event, fn] of listeners)
        nativeUpdater.removeListener(event, fn);
    },
  };
}
