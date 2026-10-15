import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test(
  "native typing and selection survive missing caret geometry",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frame-geometry-"));
    try {
      const binary = path.join(dir, "geometry");
      execFileSync("xcrun", [
        "swiftc",
        "native/Interactions.swift",
        "tests/fixtures/InteractionGeometry.swift",
        "-o",
        binary,
      ]);
      assert.match(execFileSync(binary, { encoding: "utf8" }), /checks passed/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
