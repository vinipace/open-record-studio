// Canvas layers use source time, so cuts and speed changes affect every layer together.
import { layerDuration } from "./webcam-take.mjs";
export function layerRect(layer, asset, width, height) {
  const w = Math.max(2, Math.round((layer.width * width) / 2) * 2);
  const h =
    layer.roundness !== undefined
      ? w
      : Math.max(2, Math.round((w * asset.height) / asset.width / 2) * 2);
  return {
    x: Math.round(layer.x * width - w / 2),
    y: Math.round(layer.y * height - h / 2),
    width: w,
    height: h,
  };
}
export function validateLayers(layers, assets, duration) {
  if (layers === undefined) return [];
  if (!Array.isArray(layers) || layers.length > 16)
    throw new Error("Keep at most 16 canvas layers");
  const ids = new Set();
  const number = (value, min, max, label) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    )
      throw new Error(`Invalid layer ${label}`);
    return value;
  };
  return layers.map((layer) => {
    if (
      !layer ||
      typeof layer.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(layer.id) ||
      ids.has(layer.id)
    )
      throw new Error("Invalid canvas layer ID");
    ids.add(layer.id);
    const asset = Object.hasOwn(assets, layer.assetId) && assets[layer.assetId];
    if (!asset) throw new Error("Canvas layer media is missing");
    const start = number(layer.start, 0, duration, "start");
    const end = number(layer.end, 0, duration + 0.001, "end");
    const mediaStart = number(
      layer.mediaStart ?? 0,
      0,
      asset.sourceKind === "image" ? 0 : layerDuration(asset),
      "media start",
    );
    if (
      end - start < 0.05 ||
      (asset.sourceKind !== "image" &&
        end - start + mediaStart > layerDuration(asset) + 0.001)
    )
      throw new Error(
        "Layer timing must fit its media and last at least 0.05 seconds",
      );
    return {
      id: layer.id,
      assetId: layer.assetId,
      start,
      end,
      mediaStart,
      x: number(layer.x, 0, 1, "horizontal position"),
      y: number(layer.y, 0, 1, "vertical position"),
      width: number(layer.width, 0.03, 2, "size"),
      opacity: number(layer.opacity ?? 1, 0, 1, "opacity"),
      visible: layer.visible !== false,
      ...(layer.roundness !== undefined
        ? { roundness: number(layer.roundness, 0, 1, "roundness") }
        : {}),
      ...(layer.flip !== undefined ? { flip: Boolean(layer.flip) } : {}),
      ...(layer.volume !== undefined
        ? { volume: number(layer.volume, 0, 1, "volume") }
        : {}),
    };
  });
}
