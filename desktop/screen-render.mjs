import { writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compositionSize } from "./composition.mjs";
import { cropAt, cursorAt, cursorPolygon, sourceAt } from "./motion.mjs";

export const screenRenderer = import.meta.url.includes("app.asar/")
  ? path.join(process.resourcesPath, "frame-render")
  : fileURLToPath(new URL("../native/bin/frame-render", import.meta.url));

export async function canRenderScreen(project, options) {
  return (
    process.platform === "darwin" &&
    options.format === "mp4" &&
    project.tracks.screen.sourceKind !== "image" &&
    /\.(mp4|mov|m4v)$/i.test(project.tracks.screen.file) &&
    (await access(screenRenderer).then(
      () => true,
      () => false,
    ))
  );
}

export function screenOutputSize(project, edits, options) {
  const source = project.tracks.screen;
  let scale = options.height / source.height;
  if (options.mode !== "separate") {
    const canvas = compositionSize(edits.style, options.height, source);
    const fit = edits.style.screenFit === "fill" ? Math.max : Math.min;
    scale = Math.max(
      scale,
      fit(canvas.width / source.width, canvas.height / source.height),
    );
  }
  return {
    width: Math.ceil((source.width * scale) / 2) * 2,
    height: Math.ceil((source.height * scale) / 2) * 2,
  };
}

export async function prepareScreen(
  project,
  edits,
  options,
  temp,
  run,
  { signal, onProgress } = {},
) {
  const duration =
    edits.segments.reduce((sum, s) => sum + s.end - s.start, 0) /
    edits.style.speed;
  const { width, height } = screenOutputSize(project, edits, options);
  const frames = [];
  for (let i = 0; i < Math.ceil(duration * options.fps); i++) {
    if (signal?.aborted) throw signal.reason;
    const time = i / options.fps,
      source = sourceAt(edits, time);
    const pointer = cursorAt(project.cursor, source, edits.style);
    frames.push({
      source: source - (project.tracks.screen.offset || 0),
      ...cropAt(edits, time, project.cursor),
      cursor: pointer
        ? { ...pointer, pressed: pointer.pressed && edits.style.cursorClicks }
        : null,
    });
    // Long recordings must not block cancellation or the desktop event loop.
    if (i % 2048 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const job = path.join(temp, "screen-render.json"),
    movie = path.join(temp, "screen-render.mp4");
  await writeFile(
    job,
    JSON.stringify({
      input: path.join(project.directory, project.tracks.screen.file),
      width,
      height,
      fps: options.fps,
      duration,
      quality: options.quality,
      cursorScale: (width / 1280) * edits.style.cursorSize,
      polygon: cursorPolygon,
      frames,
    }),
  );
  const stalled = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, stalled.signal])
    : stalled.signal;
  let timer;
  const heartbeat = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stalled.abort(), 30000);
    timer.unref();
  };
  heartbeat();
  try {
    await run(screenRenderer, [job, movie], {
      signal: combinedSignal,
      onProgress: (seconds) => {
        heartbeat();
        onProgress?.(seconds / duration);
      },
    });
  } catch (error) {
    if (stalled.signal.aborted && !signal?.aborted)
      throw new Error(
        "The screen renderer stopped responding. Please retry the export.",
        { cause: error },
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { job, movie, width, height };
}
