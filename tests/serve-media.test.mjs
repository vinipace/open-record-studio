import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { byteRange, serveMedia } from "../desktop/serve-media.mjs";
test("media ranges support seeking, suffix requests and invalid-range rejection", async () => {
  assert.deepEqual(byteRange("bytes=10-19", 100), {
    start: 10,
    end: 19,
    partial: true,
  });
  assert.deepEqual(byteRange("bytes=20-", 100), {
    start: 20,
    end: 99,
    partial: true,
  });
  assert.deepEqual(byteRange("bytes=-10", 100), {
    start: 90,
    end: 99,
    partial: true,
  });
  for (const value of [
    "bytes=100-",
    "bytes=9-2",
    "bytes=0-2,8-9",
    "bytes=-0",
    "invalid",
  ])
    assert.equal(byteRange(value, 100), null);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-ranges-")),
    file = path.join(root, "screen.mp4");
  try {
    await fs.writeFile(
      file,
      Buffer.from(Array.from({ length: 100 }, (_, i) => i)),
    );
    const response = await serveMedia(
      file,
      new Request("https://local/screen", {
        headers: { Range: "bytes=10-19" },
      }),
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 10-19/100");
    assert.equal(response.headers.get("content-length"), "10");
    assert.deepEqual(
      [...new Uint8Array(await response.arrayBuffer())],
      Array.from({ length: 10 }, (_, i) => i + 10),
    );
    const full = await serveMedia(file, new Request("https://local/screen"));
    assert.equal(full.status, 200);
    assert.equal((await full.arrayBuffer()).byteLength, 100);
    const head = await serveMedia(
      file,
      new Request("https://local/screen", { method: "HEAD" }),
    );
    assert.equal(head.headers.get("content-length"), "100");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const bad = await serveMedia(
      file,
      new Request("https://local/screen", { headers: { Range: "bytes=100-" } }),
    );
    assert.equal(bad.status, 416);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
