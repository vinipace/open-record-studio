// Shared pointer lifetime for moving zooms and selecting time. Updates run once
// per frame, include scroll movement, and flush at release. Escape rolls back.
export function timelineDrag(
  event: PointerEvent,
  owner: HTMLElement,
  lane: HTMLElement,
  scroll: HTMLElement,
  total: number,
  update: (anchor: number, time: number) => void,
  finish: (commit: boolean, moved: boolean) => void,
) {
  const bounds = lane.getBoundingClientRect();
  const scrollStart = scroll.scrollLeft,
    origin = event.clientX;
  const at = (x: number) =>
    Math.max(
      0,
      Math.min(
        total,
        ((x - bounds.left + scroll.scrollLeft - scrollStart) / bounds.width) *
          total,
      ),
    );
  const anchor = at(origin);
  let latest = origin,
    frame = 0,
    moved = false,
    done = false,
    lastFrame = performance.now();
  const paint = () => {
    if (
      !moved &&
      Math.abs(latest - origin) + Math.abs(scroll.scrollLeft - scrollStart) < 4
    )
      return;
    moved = true;
    update(anchor, at(latest));
  };
  const tick = (now: number) => {
    frame = 0;
    const elapsed = Math.min(32, now - lastFrame);
    lastFrame = now;
    const viewport = scroll.getBoundingClientRect();
    const edge =
      latest < viewport.left + 32
        ? latest - viewport.left - 32
        : latest > viewport.right - 32
          ? latest - viewport.right + 32
          : 0;
    if (moved && edge)
      scroll.scrollLeft += Math.max(-1, Math.min(1, edge / 32)) * elapsed * 0.6;
    paint();
    if (moved && edge) schedule();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    if (!(e.buttons & 1)) return end(false);
    latest = e.clientX;
    lastFrame = performance.now();
    schedule();
  };
  const end = (commit: boolean) => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    if (commit) paint();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", key, true);
    owner.removeEventListener("lostpointercapture", cancel);
    scroll.removeEventListener("scroll", schedule);
    if (owner.hasPointerCapture(event.pointerId))
      owner.releasePointerCapture(event.pointerId);
    finish(commit, moved);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    latest = e.clientX;
    end(true);
  };
  const cancel = () => end(false);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    }
  };
  owner.setPointerCapture(event.pointerId);
  owner.addEventListener("lostpointercapture", cancel);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", key, true);
  scroll.addEventListener("scroll", schedule);
  return cancel;
}
