// Capture latency is different from a deliberate synchronization adjustment.
// Hold the first camera frame across the former; retain blank padding for the
// latter. Neither operation shifts any subsequent camera frames or audio.
export function cameraStartHold(track, adjustment = 0) {
  const offset = track.offset || 0;
  return Math.max(0, Math.min(offset, offset + adjustment));
}

export function cameraFrameTime(track, source, adjustment = 0) {
  const offset = (track.offset || 0) + adjustment;
  const blank = Math.max(0, offset) - cameraStartHold(track, adjustment);
  const time = Math.max(0, source - offset);
  return source < blank || time >= track.duration ? null : time;
}
