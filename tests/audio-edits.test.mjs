import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  audibleRanges,
  audioRemovedAt,
  validateRemovedAudio,
} from "../desktop/audio-edits.mjs";
import {
  validateEdits,
  readProject,
  saveProject,
  exportProject,
  probe,
} from "../desktop/media.mjs";
import { layersFixture } from "./layers-fixture.mjs";
import { audioEnergy } from "./media-checks.mjs";
import { connectMcp, call } from "./mcp-client.mjs";

test("removed audio normalizes ranges, preserves visible fragments and validates saved edits", () => {
  const removedAudio = validateRemovedAudio(
    [
      { start: 2, end: 3 },
      { start: 1, end: 2.5 },
      { start: 3, end: 4 },
    ],
    6,
  );
  assert.deepEqual(removedAudio, [{ start: 1, end: 4 }]);
  const edits = validateEdits(
    { segments: [{ start: 0, end: 6 }], removedAudio },
    6,
  );
  assert.deepEqual(audibleRanges(edits, edits.segments[0]), [
    { start: 0, end: 1 },
    { start: 4, end: 6 },
  ]);
  assert.equal(audioRemovedAt(edits, 1), true);
  assert.equal(audioRemovedAt(edits, 4), false);
  assert.deepEqual(audibleRanges(edits, { start: 2, end: 3 }), []);
  for (const bad of [
    null,
    [{ start: -1, end: 2 }],
    [{ start: 1, end: NaN }],
    [{ start: 2, end: 1 }],
    [{ start: 0, end: 7 }],
    [{ start: 6.0001, end: 6.0002 }],
  ])
    assert.throws(() =>
      validateEdits({ segments: [{ start: 0, end: 6 }], removedAudio: bad }, 6),
    );
});

test(
  "audio deletion survives MCP edits/reopen and silences both sources across cuts, speed and separate exports",
  { timeout: 60000 },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "frame-audio-delete-"),
    );
    try {
      const { project, directory } = await layersFixture(root);
      project.tracks.microphone = { ...project.tracks.screen, offset: 0.2 };
      project.edits.segments = [
        { start: 0.25, end: 1.75 },
        { start: 2.25, end: 3.75 },
      ];
      project.edits.style.speed = 1.5;
      project.edits.removedAudio = [
        { start: 0.5, end: 1.5 },
        { start: 2.5, end: 3.5 },
      ];
      await saveProject(project);
      const before = await fs.readFile(path.join(directory, "screen.mp4"));
      const connection = await connectMcp();
      try {
        const args = { project_path: directory },
          current = await call(connection.client, "get_project", args);
        assert.deepEqual(current.removed_audio, project.edits.removedAudio);
        await call(connection.client, "update_style", {
          ...args,
          expected_revision: current.revision,
          changes: { volume: 0.8 },
        });
      } finally {
        await connection.client.close();
      }
      const reopened = await readProject(directory);
      assert.deepEqual(reopened.edits.removedAudio, project.edits.removedAudio);
      const output = await exportProject(
        reopened,
        reopened.edits,
        { mode: "both", height: 720, fps: 30, audio: true, cameraAudio: true },
        root,
      );
      for (const name of ["combined", "screen", "camera"]) {
        const file = path.join(output.directory, `${name}.mp4`);
        assert.ok(Math.abs((await probe(file)).duration - 2) < 0.05);
        assert.ok(
          (await audioEnergy(file, 0.3)) < 0.0001,
          `${name}: first deleted range`,
        );
        assert.ok(
          (await audioEnergy(file, 1.3)) < 0.0001,
          `${name}: second deleted range`,
        );
        assert.ok(
          (await audioEnergy(file, 0.9)) > 0.02,
          `${name}: audio retained between deletions`,
        );
      }
      assert.deepEqual(
        await fs.readFile(path.join(directory, "screen.mp4")),
        before,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
