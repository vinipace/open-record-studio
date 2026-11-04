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
  capture: CaptureOptions;
};
export type CaptureOptions = { height: 0 | 720 | 1080 | 2160; fps: 30 | 60 };
export const defaultCapture: Readonly<CaptureOptions>;
export function captureOptions(value?: Partial<CaptureOptions>): CaptureOptions;
export function cameraRecordingType(
  supported: (type: string) => boolean,
  audio?: boolean,
): string;
export function recordingExtension(mimeType?: string): "mp4" | "webm";
export const defaultAutoZoom: Readonly<AutoZoomOptions>;
export function autoZoomOptions(
  value?: Partial<AutoZoomOptions>,
): AutoZoomOptions;
export function preferredDevice(
  devices: { deviceId: string; label: string; groupId: string }[],
  preference?: DevicePreference | null,
  fallback?: string,
): string;
