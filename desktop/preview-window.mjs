// Keep the opposite corner fixed while projecting the pointer onto a square's
// resize diagonal. Coordinates are screen DIP, including on Retina displays.
export function resizePreviewBounds(bounds, corner, dx, dy, area) {
  const left = corner.endsWith("w"),
    top = corner.startsWith("n");
  const anchorX = left ? bounds.x + bounds.width : bounds.x;
  const anchorY = top ? bounds.y + bounds.height : bounds.y;
  const available = Math.min(
    left ? anchorX - area.x : area.x + area.width - anchorX,
    top ? anchorY - area.y : area.y + area.height - anchorY,
    640,
  );
  const minimum = Math.min(192, Math.max(1, available));
  const size = Math.round(
    Math.max(
      minimum,
      Math.min(
        Math.max(minimum, available),
        bounds.width + ((left ? -dx : dx) + (top ? -dy : dy)) / 2,
      ),
    ),
  );
  return {
    x: left ? anchorX - size : anchorX,
    y: top ? anchorY - size : anchorY,
    width: size,
    height: size,
  };
}
