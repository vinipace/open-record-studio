import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureAppIdentity } from "../desktop/app-identity.mjs";
import {
  recordingPreferences,
  updateRecordingPreferences,
} from "../desktop/recording-preferences.mjs";
import {
  projectsFolder,
  setProjectsFolder,
} from "../desktop/project-library.mjs";

test("renamed app continues to read existing camera, microphone and projects folder preferences", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "record-studio-identity-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyData = path.join(root, "Frame Studio");
  const projects = path.join(root, "Projects");
  await fs.mkdir(projects);
  const camera = { deviceId: "camera-1", label: "Camera", groupId: "cam" };
  const microphone = { deviceId: "microphone-1", label: "Mic", groupId: "mic" };
  await updateRecordingPreferences(legacyData, { camera, microphone });
  await setProjectsFolder(legacyData, projects);
  const app = {
    name: "Frame Studio",
    dataDirectory: legacyData,
    setName(name) {
      this.name = name;
      this.dataDirectory = path.join(root, name);
    },
    getPath(key) {
      assert.equal(key, "appData");
      return root;
    },
    setPath(key, value) {
      assert.equal(key, "userData");
      this.dataDirectory = value;
    },
  };
  configureAppIdentity(app, "");
  assert.equal(app.name, "Open Record Studio");
  assert.equal(app.dataDirectory, legacyData);
  assert.deepEqual(
    (await recordingPreferences(app.dataDirectory)).camera,
    camera,
  );
  assert.deepEqual(
    (await recordingPreferences(app.dataDirectory)).microphone,
    microphone,
  );
  assert.equal(
    await projectsFolder(app.dataDirectory),
    await fs.realpath(projects),
  );
  const isolated = path.join(root, "isolated");
  configureAppIdentity(app, isolated);
  assert.equal(app.dataDirectory, isolated);
  assert((await fs.stat(isolated)).isDirectory());
});
