import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// CodeResources seals the entire app, including Electron and the unpacked MCP.
export async function packageFingerprint(app) {
  const files = [
    "Contents/_CodeSignature/CodeResources",
    "Contents/Resources/app.asar",
    "Contents/Resources/mcp-runtime/manifest.json",
    "Contents/Resources/frame-capture",
    "Contents/Resources/frame-cursor",
    "Contents/Resources/frame-render",
  ];
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await fs.readFile(path.join(app, file)))
          .digest("hex"),
      ]),
    ),
  );
}
