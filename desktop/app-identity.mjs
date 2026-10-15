import path from "node:path";
import { mkdirSync } from "node:fs";

export const productName = "Open Record Studio";
// Keep this identity stable so existing macOS privacy grants remain usable.
export const bundleIdentifier = "local.framestudio.editor";

export function configureAppIdentity(
  app,
  dataDirectory = process.env.FRAME_DATA_DIR,
) {
  app.setName(productName);
  // Renaming the product must not move saved device choices, projects folder,
  // browser storage, or the user's sample project to a fresh directory.
  const directory =
    dataDirectory || path.join(app.getPath("appData"), "Frame Studio");
  mkdirSync(directory, { recursive: true });
  app.setPath("userData", directory);
}
