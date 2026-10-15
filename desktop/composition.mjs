export const aspectRatios = [
  "16:9",
  "9:16",
  "1:1",
  "4:5",
  "4:3",
  "3:4",
  "source",
];
export const canvasTemplates = [
  { id: "instagram-reels", name: "Instagram Reels", ratio: "9:16" },
  { id: "instagram-story", name: "Instagram Story", ratio: "9:16" },
  { id: "instagram-portrait", name: "Instagram portrait", ratio: "4:5" },
  { id: "instagram-square", name: "Instagram square", ratio: "1:1" },
  { id: "tiktok", name: "TikTok", ratio: "9:16" },
  { id: "youtube", name: "YouTube", ratio: "16:9" },
  { id: "youtube-shorts", name: "YouTube Shorts", ratio: "9:16" },
  { id: "presentation", name: "Presentation", ratio: "4:3" },
];

export function compositionRatio(style, screen) {
  if (style.aspectRatio === "source") return screen.width / screen.height;
  const [w, h] = (style.aspectRatio || "16:9").split(":").map(Number);
  return w / h;
}

// Resolution is the short edge for portrait/square compositions, and the
// vertical height for landscape. Separate tracks retain their source ratio.
export function compositionSize(style, resolution, screen) {
  const ratio = compositionRatio(style, screen);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1
    ? { width: even(resolution * ratio), height: even(resolution) }
    : { width: even(resolution), height: even(resolution / ratio) };
}

export function compositionLayout(style, width, height) {
  // Preserve existing 16:9 layouts while keeping overlays inside ultrawide
  // source-ratio canvases.
  const basis = Math.min(width, (height * 16) / 9);
  const pad = Math.round((basis * style.padding) / 2) * 2;
  const cameraSize = Math.round((basis * style.cameraSize) / 2) * 2;
  // Use the same resolution-independent basis as camera size, preserving the
  // previous 3.5% inset for older projects. Large margins must stay on canvas.
  const cameraGap = Math.max(
    0,
    Math.min(
      Math.round(basis * (style.cameraMargin ?? 0.035)),
      Math.min(width, height) - cameraSize,
    ),
  );
  return {
    pad,
    innerWidth: width - 2 * pad,
    innerHeight: height - 2 * pad,
    cameraSize,
    cameraGap,
  };
}

export function applyCanvasStyle(style, changes) {
  const next = { ...style, ...changes };
  if (changes.canvasTemplate && changes.canvasTemplate !== "custom") {
    const template = canvasTemplates.find(
      (t) => t.id === changes.canvasTemplate,
    );
    if (!template) throw new Error("Invalid canvas template");
    if (changes.aspectRatio && changes.aspectRatio !== template.ratio)
      throw new Error("Canvas template and aspect ratio do not match");
    next.aspectRatio = template.ratio;
  } else if (changes.aspectRatio) next.canvasTemplate = "custom";
  return next;
}
