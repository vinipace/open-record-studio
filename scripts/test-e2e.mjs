import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { packageFingerprint } from "./package-fingerprint.mjs";

if (process.platform !== "darwin")
  throw new Error("Packaged E2E currently targets the macOS app.");
const root = path.resolve(import.meta.dirname, "..");
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`E2E command exited with ${code}`)),
    );
  });
}
// Package before testing so the test target cannot silently be an older build.
const evidence = path.join(root, "evidence/release-e2e.json");
await fs.rm(evidence, { force: true });
await run("npm", ["run", "package"]);
const app = path.join(root, "release/Open Record Studio.app");
await run(process.execPath, ["scripts/test-packaged-mcp.mjs"]);
await run(
  process.execPath,
  [
    path.join(root, "node_modules/@playwright/test/cli.js"),
    "test",
    "--reporter=list,json",
  ],
  {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(root, "evidence/packaged-ui.json"),
    FRAME_MCP_COMMAND: path.join(
      app,
      "Contents/Resources/bin/open-record-studio-mcp",
    ),
    FRAME_EXECUTABLE: path.join(
      root,
      "release/Open Record Studio.app/Contents/MacOS/Electron",
    ),
  },
);
const ui = JSON.parse(
  await fs.readFile(path.join(root, "evidence/packaged-ui.json")),
);
assert(
  ui.stats.expected > 0 &&
    ui.stats.unexpected === 0 &&
    ui.stats.flaky === 0 &&
    ui.stats.skipped === 0,
  "Release E2E must pass without skipped or flaky tests",
);
const mcp = JSON.parse(
  await fs.readFile(path.join(root, "evidence/packaged-mcp.json")),
);
const fingerprint = await packageFingerprint(app);
assert.deepEqual(mcp.fingerprint, fingerprint);
await fs.writeFile(
  evidence,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      fingerprint,
      mcpPassed: mcp.passed,
      uiPassed: ui.stats.expected,
    },
    null,
    2,
  ) + "\n",
);
