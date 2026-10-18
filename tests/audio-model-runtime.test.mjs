import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAudioProcess } from "../desktop/audio-model-runtime.mjs";

test("cancelling a model terminates its inference child and reports only structured progress", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-model-cancel-"));
  const marker = path.join(root, "pid");
  const controller = new AbortController();
  const messages = [];
  const running = runAudioProcess(
    process.execPath,
    [
      "-e",
      `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    fs.writeFileSync(process.argv[1], String(child.pid));
    console.log('unstructured library output');
    process.stdout.write('studio-progress:{"message":"Ready",');
    setTimeout(() => console.log('"progress":0.5}'), 10);
    setInterval(() => {}, 1000);
  `,
      marker,
    ],
    {
      signal: controller.signal,
      onMessage: (message) => {
        messages.push(message);
        controller.abort();
      },
    },
  );
  try {
    await assert.rejects(running, /abort/i);
    assert.deepEqual(messages, [{ message: "Ready", progress: 0.5 }]);
    const pid = Number(await fs.readFile(marker, "utf8"));
    // Allow launchd to reap the grandchild after the group is killed.
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("Inference child survived cancellation");
  } finally {
    controller.abort();
    await fs.rm(root, { recursive: true, force: true });
  }
});
