import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startCapture } from "../desktop/native-capture.mjs";
function fake() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    child.emit("exit", null);
    child.emit("close", null);
  };
  return child;
}
test("native helper handshake, fragmented messages and finalized stop", async () => {
  const child = fake();
  let called;
  const session = startCapture(
    "/helper",
    {
      source: "screen:1",
      output: "/project/screen.mp4",
      audio: true,
      excludeApplicationPIDs: [12345],
    },
    (file, args) => {
      called = { file, args };
      return child;
    },
  );
  child.stdout.write('{"event":"started",');
  child.stdout.write('"startedAt":12345}\n');
  assert.equal((await session.ready).startedAt, 12345);
  assert.deepEqual(called.args, [
    "--source",
    "screen:1",
    "--output",
    "/project/screen.mp4",
    "--audio",
    "--exclude-apps",
    "12345",
  ]);
  let resolved = false;
  const stop = session.stop().then(() => (resolved = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false);
  child.stdout.write('{"event":"finished"}\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false);
  child.emit("exit", 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false);
  child.emit("close", 0);
  await stop;
  assert.equal(resolved, true);
  await session.stop();
});
test("native permission failure and unexpected exit reject without hanging", async () => {
  for (const kind of ["permission", "exit"]) {
    const child = fake();
    const session = startCapture(
      "/helper",
      { source: "window:2:0", output: "/project/screen.mp4" },
      () => child,
    );
    if (kind === "permission")
      child.stdout.write('{"event":"error","message":"permission denied"}\n');
    else {
      child.emit("exit", 1);
      child.emit("close", 1);
    }
    await assert.rejects(session.ready);
    await assert.rejects(session.done);
    session.abort();
    session.abort();
    await new Promise((r) => setImmediate(r));
  }
});
