import {
  preferredDevice,
  type RecordingPreferences,
  type DevicePreference,
} from "../desktop/recording-options.mjs";
let saving: Promise<unknown> = Promise.resolve();
export async function loadRecordingPreferences() {
  await saving;
  return window.studio.recordingPreferences();
}
export function saveRecordingPreferences(patch: Partial<RecordingPreferences>) {
  const job = saving
    .catch(() => {})
    .then(() => window.studio.updateRecordingPreferences(patch));
  saving = job;
  return job;
}
export async function flushRecordingPreferences() {
  await saving;
}
export function devicePreference(
  value: string,
  devices: MediaDeviceInfo[],
): DevicePreference {
  const device = devices.find((d) => d.deviceId === value);
  return {
    deviceId: value,
    label: device?.label || "",
    groupId: device?.groupId || "",
  };
}
export function populateDevices(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  preference: DevicePreference | null,
  label: string,
  requireCamera = false,
) {
  const available = devices.filter((d) => d.kind === kind);
  select.replaceChildren();
  if (!requireCamera) select.add(new Option("Off", ""));
  for (const [i, d] of available.entries())
    select.add(
      new Option(d.label || `${label} ${i + 1}`, d.deviceId || "default"),
    );
  const chosen = preferredDevice(
    available,
    preference,
    requireCamera ? available[0]?.deviceId || "default" : "",
  );
  if (requireCamera && !available.length)
    select.add(new Option("Default camera", "default"));
  if (!chosen && preference?.deviceId) {
    const missing = new Option(
      `${preference.label || label} — unavailable`,
      "",
    );
    missing.disabled = true;
    select.add(missing);
    select.selectedIndex = select.options.length - 1;
  } else if (requireCamera && !chosen)
    select.value = available[0]?.deviceId || "default";
  else select.value = chosen;
}
