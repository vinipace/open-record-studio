import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { autoZoomOptions } from "./recording-options.mjs";
const file = (profile) => path.join(profile, "recording-preferences.json");
const device = (value) =>
  value && typeof value.deviceId === "string"
    ? Object.fromEntries(
        ["deviceId", "label", "groupId"].map((key) => [
          key,
          typeof value[key] === "string" ? value[key].slice(0, 512) : "",
        ]),
      )
    : null;
const normalize = (value) => ({
  camera: device(value?.camera),
  microphone: device(value?.microphone),
  systemAudio: value?.systemAudio === true,
  autoZoom: autoZoomOptions(value?.autoZoom),
});
export async function recordingPreferences(profile) {
  try {
    return normalize(JSON.parse(await fs.readFile(file(profile), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError)
      return normalize();
    throw error;
  }
}
const pending = new Map();
export function updateRecordingPreferences(profile, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("Invalid recording preferences");
  const job = (pending.get(profile) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const previous = await recordingPreferences(profile);
      const next = normalize({
        ...previous,
        ...patch,
        autoZoom: { ...previous.autoZoom, ...patch.autoZoom },
      });
      await fs.mkdir(profile, { recursive: true });
      const temp = `${file(profile)}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(next, null, 2) + "\n", {
          flag: "wx",
        });
        await fs.rename(temp, file(profile));
      } finally {
        await fs.rm(temp, { force: true });
      }
      return next;
    });
  pending.set(profile, job);
  void job
    .finally(() => {
      if (pending.get(profile) === job) pending.delete(profile);
    })
    .catch(() => {});
  return job;
}
