import { spawn } from "node:child_process";
import path from "node:path";

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
await run("npm", ["run", "package"]);
await run(
  process.execPath,
  [path.join(root, "node_modules/@playwright/test/cli.js"), "test"],
  {
    ...process.env,
    FRAME_EXECUTABLE: path.join(
      root,
      "release/Open Record Studio.app/Contents/MacOS/Electron",
    ),
  },
);
