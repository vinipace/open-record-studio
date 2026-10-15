import { compositionSize } from "./composition.mjs";
import { sourceRanges } from "./motion.mjs";

// Preserve a source pixel for every output pixel at the deepest retained zoom.
// There is no benefit in transforming a 5K frame into another 5K frame when
// even the deepest crop will only occupy 1080p in the exported file.
export function screenRenderSize(project, edits, options) {
  const source = project.tracks.screen;
  const zoom = Math.max(
    edits.style.zoom,
    ...(edits.zooms || [])
      .filter((z) => sourceRanges(edits, z.start, z.end).length)
      .map((z) => z.zoom),
  );
  let scale = options.height / source.height;
  if (options.mode !== "separate" && options.mode !== "screen") {
    const canvas = compositionSize(edits.style, options.height, source);
    // The full canvas is a conservative upper bound for the inset screen.
    const fit = edits.style.screenFit === "fill" ? Math.max : Math.min;
    scale = Math.max(
      scale,
      fit(canvas.width / source.width, canvas.height / source.height),
    );
  }
  scale = Math.min(1, scale * zoom);
  return {
    width: Math.min(source.width, Math.ceil((source.width * scale) / 2) * 2),
    height: Math.min(source.height, Math.ceil((source.height * scale) / 2) * 2),
  };
}

const capabilities = new Map();
export async function selectVideoEncoder(command, run, signal) {
  if (process.platform !== "darwin") return "libx264";
  if (capabilities.has(command)) return capabilities.get(command);
  let encoder = "libx264";
  try {
    await run(
      command,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=s=64x64:d=0.1",
        "-frames:v",
        "1",
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "0",
        "-f",
        "null",
        "-",
      ],
      { signal },
    );
    encoder = "h264_videotoolbox";
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  capabilities.set(command, encoder);
  return encoder;
}

export function videoEncodingArgs(options) {
  return options.encoder === "h264_videotoolbox"
    ? [
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "0",
        "-q:v",
        options.quality === "high" ? "80" : "65",
        "-profile:v",
        "high",
        "-coder",
        "cabac",
      ]
    : [
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        options.quality === "high" ? "18" : "23",
      ];
}
