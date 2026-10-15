export const timelineGutter = 112;
export const timelineInset = timelineGutter + 20;
export type TimelineViewport = { left: number; width: number };

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

// Four pixels per 60 fps frame, even on a long recording. Keep the CSS width
// comfortably below Chromium's layout limit for unusually long projects.
export function maxTimelineScale(duration: number, viewportWidth: number) {
  const width = Math.max(timelineInset + 1, viewportWidth);
  return Math.min(
    8_000_000 / width,
    Math.max(16, (duration * 240 + timelineInset) / width),
  );
}

export function timelineZoomAt(
  scale: number,
  nextScale: number,
  scrollLeft: number,
  viewportWidth: number,
  pointer: number,
) {
  const anchor = clamp(pointer, timelineGutter, viewportWidth - 20);
  const fraction = clamp(
    (scrollLeft + anchor - timelineGutter) /
      Math.max(1, viewportWidth * scale - timelineInset),
    0,
    1,
  );
  return clamp(
    timelineGutter +
      fraction * (viewportWidth * nextScale - timelineInset) -
      anchor,
    0,
    viewportWidth * (nextScale - 1),
  );
}

// Quantized overscan avoids repainting peaks/thumbnails on every scroll pixel.
// Fractions always refer to the original clip, so cuts and speed keep their
// source-time mapping while the small canvas moves through the timeline.
export function timelineSlice(
  left: number,
  width: number,
  viewport: TimelineViewport,
) {
  width = Math.max(1, width);
  const tile = 512;
  const start = clamp(
    Math.floor(viewport.left / tile) * tile - tile - left,
    0,
    width,
  );
  const end = clamp(
    Math.ceil((viewport.left + viewport.width) / tile) * tile + tile - left,
    0,
    width,
  );
  return {
    offset: start,
    width: end - start,
    from: start / width,
    to: end / width,
  };
}

export function timelineTicks(
  total: number,
  laneWidth: number,
  viewport: TimelineViewport,
) {
  const pixelsPerSecond = laneWidth / Math.max(0.001, total);
  const target = 100 / Math.max(0.001, pixelsPerSecond);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = Math.max(
    0.01,
    [1, 2, 5, 10].find((n) => n * magnitude >= target)! * magnitude,
  );
  const first = Math.max(0, Math.floor(viewport.left / pixelsPerSecond / step));
  const last = Math.min(
    Math.floor(total / step),
    Math.ceil((viewport.left + viewport.width) / pixelsPerSecond / step),
  );
  const ticks = [];
  for (let i = first; i <= last; i++) {
    const time = i * step;
    const minutes = Math.floor(time / 60);
    const seconds = (time - minutes * 60).toFixed(
      step < 0.1 ? 2 : step < 1 ? 1 : 0,
    );
    ticks.push({
      left: time * pixelsPerSecond,
      label: `${String(minutes).padStart(2, "0")}:${seconds.padStart(step < 0.1 ? 5 : step < 1 ? 4 : 2, "0")}`,
    });
  }
  return { ticks, spacing: step * pixelsPerSecond };
}

export function attachTimelinePinch(
  element: HTMLElement,
  hooks: {
    enabled(): boolean;
    scale(): number;
    maximum(): number;
    zoom(scale: number, pointer: number): void;
  },
) {
  let frame = 0,
    delta = 0,
    pointer = 0;
  const wheel = (event: WheelEvent) => {
    // Chromium emits trackpad pinch as ctrl+wheel. Ordinary two-finger scroll
    // stays native; Command+wheel is also available to mouse users.
    if (!(event.ctrlKey || event.metaKey) || !hooks.enabled()) return;
    event.preventDefault();
    pointer = event.clientX - element.getBoundingClientRect().left;
    delta += clamp(
      event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientWidth
            : 1),
      -240,
      240,
    );
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (hooks.enabled())
          hooks.zoom(
            clamp(hooks.scale() * Math.exp(-delta * 0.01), 1, hooks.maximum()),
            pointer,
          );
        delta = 0;
      });
  };
  element.addEventListener("wheel", wheel, { passive: false });
  return () => {
    cancelAnimationFrame(frame);
    element.removeEventListener("wheel", wheel);
  };
}
