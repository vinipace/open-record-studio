export const exportFormats = {
  mp4: {
    heights: [720, 1080, 2160],
    frameRates: [30, 60],
    height: 1080,
    fps: 60,
  },
  gif: {
    heights: [360, 480, 720, 1080],
    frameRates: [10, 15, 20, 30],
    height: 480,
    fps: 20,
  },
};

export function normalizeExportOptions(options) {
  const format = options.format ?? "mp4";
  if (!Object.hasOwn(exportFormats, format))
    throw new Error("Invalid export format");
  const settings = exportFormats[format];
  const height = options.height ?? settings.height,
    fps = options.fps ?? settings.fps;
  const quality = options.quality ?? "standard";
  if (
    !settings.heights.includes(height) ||
    !settings.frameRates.includes(fps) ||
    !["combined", "separate", "both"].includes(options.mode) ||
    !["high", "standard"].includes(quality)
  )
    throw new Error(`Invalid ${format.toUpperCase()} export options`);
  return {
    ...options,
    format,
    height,
    fps,
    quality,
    audio: format === "mp4" && Boolean(options.audio),
    // Compatibility field for older clients; source routing is automatic now.
    cameraAudio: format === "mp4" && Boolean(options.audio),
  };
}
