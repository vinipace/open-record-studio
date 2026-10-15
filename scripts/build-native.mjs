import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
await fs.mkdir("native/bin", { recursive: true });
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-O",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx15.0`,
    "native/Capture.swift",
    "native/Interactions.swift",
    "-o",
    "native/bin/frame-capture",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "/usr/bin/codesign",
  ["--force", "--sign", "-", "native/bin/frame-capture"],
  { stdio: "inherit" },
);
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-O",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx15.0`,
    "native/CursorRender.swift",
    "-o",
    "native/bin/frame-cursor",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "/usr/bin/codesign",
  ["--force", "--sign", "-", "native/bin/frame-cursor"],
  { stdio: "inherit" },
);
// Rebuilding must not alter the signed inode of an active export helper.
const stage = await fs.mkdtemp("native/bin/.render-build-");
try {
  const output = path.join(stage, "frame-render");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-O",
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx15.0`,
      "native/ScreenRender.swift",
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", output], {
    stdio: "inherit",
  });
  await fs.rename(output, "native/bin/frame-render");
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
