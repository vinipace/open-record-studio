export const defaultAutoZoom = Object.freeze({
  click: false,
  typing: true,
  selection: true,
  scroll: false,
  drag: false,
});
export const defaultCapture = Object.freeze({ height: 2160, fps: 30 });
export function captureOptions(value) {
  return {
    height: [0, 720, 1080, 2160].includes(value?.height)
      ? value.height
      : defaultCapture.height,
    fps: [30, 60].includes(value?.fps) ? value.fps : defaultCapture.fps,
  };
}
export function cameraRecordingType(supported, audio = false) {
  // H.264 is supported by the Mac's media engine; VP9 recording used CPU cores.
  const suffix = audio ? ",mp4a.40.2" : "";
  const type = ["avc1.640028", "avc1.42001f"]
    .map((codec) => `video/mp4;codecs=${codec}${suffix}`)
    .find(supported);
  if (!type)
    throw new Error(
      "H.264 camera recording is unavailable. Update the app or record with the camera off.",
    );
  return type;
}
export function recordingExtension(mimeType = "video/webm") {
  const type = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (type === "video/mp4") return "mp4";
  if (type === "video/webm" || type === "audio/webm") return "webm";
  throw new Error("Unsupported recording container");
}
export function autoZoomOptions(value) {
  return Object.fromEntries(
    Object.entries(defaultAutoZoom).map(([kind, fallback]) => [
      kind,
      typeof value?.[kind] === "boolean" ? value[kind] : fallback,
    ]),
  );
}
// IDs can change after reconnecting a USB device. Match its label/group before
// falling back to Off; never silently switch to a different camera or mic.
export function preferredDevice(devices, preference, fallback = "") {
  if (!preference) return fallback;
  if (!preference.deviceId) return "";
  return (
    devices.find((d) => d.deviceId === preference.deviceId)?.deviceId ||
    devices.find(
      (d) =>
        preference.label &&
        d.label === preference.label &&
        preference.groupId &&
        d.groupId === preference.groupId,
    )?.deviceId ||
    devices.find((d) => preference.label && d.label === preference.label)
      ?.deviceId ||
    ""
  );
}
