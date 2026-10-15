export const defaultAutoZoom = Object.freeze({
  click: false,
  typing: true,
  selection: true,
  scroll: false,
  drag: false,
});
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
