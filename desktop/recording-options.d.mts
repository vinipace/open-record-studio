export type AutoZoomOptions = Record<
  "click" | "typing" | "selection" | "scroll" | "drag",
  boolean
>;
export type DevicePreference = {
  deviceId: string;
  label: string;
  groupId: string;
};
export type RecordingPreferences = {
  camera: DevicePreference | null;
  microphone: DevicePreference | null;
  systemAudio: boolean;
  autoZoom: AutoZoomOptions;
};
export const defaultAutoZoom: Readonly<AutoZoomOptions>;
export function autoZoomOptions(
  value?: Partial<AutoZoomOptions>,
): AutoZoomOptions;
export function preferredDevice(
  devices: { deviceId: string; label: string; groupId: string }[],
  preference?: DevicePreference | null,
  fallback?: string,
): string;
