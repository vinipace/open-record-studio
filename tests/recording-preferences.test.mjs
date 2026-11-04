import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  recordingPreferences,
  updateRecordingPreferences,
} from "../desktop/recording-preferences.mjs";
import {
  preferredDevice,
  defaultAutoZoom,
  defaultCapture,
  cameraRecordingType,
  recordingExtension,
} from "../desktop/recording-options.mjs";
import {
  automaticZooms,
  validateInteractions,
} from "../desktop/interactions.mjs";
import { validateEdits, defaults } from "../desktop/media.mjs";

test("camera, mic, system audio and zoom policy survive reload and concurrent writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-preferences-"));
  try {
    assert.deepEqual(
      (await recordingPreferences(root)).autoZoom,
      defaultAutoZoom,
    );
    const camera = {
      deviceId: "camera",
      label: "USB camera",
      groupId: "camera-group",
    };
    const microphone = {
      deviceId: "mic",
      label: "USB mic",
      groupId: "mic-group",
    };
    await Promise.all([
      updateRecordingPreferences(root, { camera }),
      updateRecordingPreferences(root, { microphone, systemAudio: true }),
      updateRecordingPreferences(root, {
        autoZoom: { click: true, typing: false },
      }),
    ]);
    const loaded = await recordingPreferences(root);
    assert.deepEqual(loaded, {
      camera,
      microphone,
      systemAudio: true,
      autoZoom: { ...defaultAutoZoom, click: true, typing: false },
      capture: defaultCapture,
    });
    await updateRecordingPreferences(root, {
      camera: { deviceId: "", label: "", groupId: "" },
    });
    assert.equal((await recordingPreferences(root)).camera.deviceId, "");
    assert.equal((await recordingPreferences(root)).microphone.deviceId, "mic");
    assert.equal((await fs.readdir(root)).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("old profiles gain balanced capture defaults and saved quality survives reload", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "frame-capture-preferences-"),
  );
  try {
    await fs.writeFile(
      path.join(root, "recording-preferences.json"),
      JSON.stringify({ systemAudio: true }),
    );
    assert.deepEqual((await recordingPreferences(root)).capture, {
      height: 2160,
      fps: 30,
    });
    await updateRecordingPreferences(root, { capture: { height: 0, fps: 60 } });
    assert.deepEqual((await recordingPreferences(root)).capture, {
      height: 0,
      fps: 60,
    });
    await updateRecordingPreferences(root, { capture: { height: 1080 } });
    assert.deepEqual((await recordingPreferences(root)).capture, {
      height: 1080,
      fps: 60,
    });
    await updateRecordingPreferences(root, {
      capture: { height: 999, fps: 240 },
    });
    assert.deepEqual((await recordingPreferences(root)).capture, {
      height: 2160,
      fps: 30,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("camera selects H.264 with the matching audio codec and never silently returns VP9", () => {
  assert.equal(
    cameraRecordingType(() => true),
    "video/mp4;codecs=avc1.640028",
  );
  assert.equal(
    cameraRecordingType((t) => t.includes("42001f"), true),
    "video/mp4;codecs=avc1.42001f,mp4a.40.2",
  );
  assert.throws(
    () => cameraRecordingType((t) => t.includes("vp9")),
    /H.264 camera recording is unavailable/,
  );
  assert.equal(recordingExtension(cameraRecordingType(() => true)), "mp4");
  assert.equal(recordingExtension("audio/webm;codecs=opus"), "webm");
  assert.throws(() => recordingExtension("../../screen.mp4"), /Unsupported/);
});
test("device reconnects match remembered identity and missing devices do not select an unrelated device", () => {
  const devices = [
    { deviceId: "new-id", label: "USB camera", groupId: "group" },
    { deviceId: "other", label: "Other", groupId: "other" },
  ];
  assert.equal(
    preferredDevice(devices, {
      deviceId: "old-id",
      label: "USB camera",
      groupId: "old-group",
    }),
    "new-id",
  );
  assert.equal(
    preferredDevice(devices, {
      deviceId: "old-id",
      label: "Missing camera",
      groupId: "missing",
    }),
    "",
  );
  assert.equal(
    preferredDevice(devices, { deviceId: "", label: "", groupId: "" }),
    "",
  );
});
test("every zoom trigger can be disabled without losing metadata; clicks default off", () => {
  const events = ["click", "typing", "selection", "scroll", "drag"].map(
    (type, i) => ({
      id: type,
      type,
      t: i * 5 + 1,
      end: i * 5 + 2,
      x: 0.3,
      y: 0.4,
    }),
  );
  const interactions = validateInteractions({ version: 1, events }, 30);
  const before = structuredClone(interactions);
  assert.deepEqual(
    automaticZooms(interactions, 30).map((z) => z.trigger),
    ["typing", "selection"],
  );
  const none = Object.fromEntries(
    Object.keys(defaultAutoZoom).map((k) => [k, false]),
  );
  assert.deepEqual(automaticZooms(interactions, 30, null, none), []);
  for (const kind of Object.keys(defaultAutoZoom)) {
    const zooms = automaticZooms(
      interactions,
      30,
      { clean: true },
      { ...none, [kind]: true },
    );
    assert.deepEqual(
      zooms.map((z) => z.trigger),
      [kind],
    );
    validateEdits(
      { segments: [{ start: 0, end: 30 }], style: defaults, zooms },
      30,
    );
  }
  assert.deepEqual(interactions, before);
});
