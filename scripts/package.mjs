import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createPackage } from "@electron/asar";
import { sign } from "@electron/osx-sign";
import { writeLicenseBundle, verifyLicenseBundle } from "./licenses.mjs";
import { productName, bundleIdentifier } from "../desktop/app-identity.mjs";
import { writeMcpBundle, verifyMcpBundle } from "./mcp-bundle.mjs";

execFileSync(process.execPath, ["scripts/build-native.mjs"], {
  stdio: "inherit",
});
const root = process.cwd(),
  release = path.join(root, "release"),
  final = path.join(release, `${productName}.app`);
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
if (pkg.productName !== productName)
  throw new Error("Package and app product names differ");
await fs.mkdir(release, { recursive: true });
const buildRoot = await fs.mkdtemp(path.join(release, ".build-"));
const target = path.join(buildRoot, `${productName}.app`);
const staging = path.join(buildRoot, "app-source");
if (
  await fs.stat(final).then(
    () => true,
    () => false,
  )
) {
  const identifier = execFileSync(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      path.join(final, "Contents/Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
  if (identifier !== bundleIdentifier)
    throw new Error("Refusing to replace an unrelated app bundle");
}
await fs.cp(
  path.join(root, "node_modules/electron/dist/Electron.app"),
  target,
  { recursive: true, verbatimSymlinks: true },
);
await writeLicenseBundle(root, path.join(target, "Contents/Resources"));
await verifyLicenseBundle(root, path.join(target, "Contents/Resources"));
await fs.mkdir(staging, { recursive: true });
for (const dir of ["desktop", "dist"])
  await fs.cp(path.join(root, dir), path.join(staging, dir), {
    recursive: true,
  });
await fs.writeFile(
  path.join(staging, "package.json"),
  JSON.stringify({
    name: pkg.name,
    productName,
    version: pkg.version,
    main: "desktop/main.mjs",
    type: "module",
    license: pkg.license,
  }),
);
await createPackage(staging, path.join(target, "Contents/Resources/app.asar"));
// A new resource name invalidates macOS's per-icon cache when artwork changes.
const icon = await fs.readFile(
  path.join(root, "desktop/assets/open-record-studio.icns"),
);
const iconName = `open-record-studio-${createHash("sha256").update(icon).digest("hex").slice(0, 12)}.icns`;
await fs.writeFile(path.join(target, "Contents/Resources", iconName), icon);
for (const helper of ["frame-capture", "frame-cursor", "frame-render"])
  await fs.copyFile(
    path.join(root, "native/bin", helper),
    path.join(target, "Contents/Resources", helper),
  );
await writeMcpBundle(root, path.join(target, "Contents/Resources"));
await verifyMcpBundle(root, path.join(target, "Contents/Resources"));
const plist = path.join(target, "Contents/Info.plist");
for (const [key, value] of Object.entries({
  CFBundleDisplayName: productName,
  CFBundleIconFile: iconName,
  CFBundleName: productName,
  CFBundleIdentifier: bundleIdentifier,
  CFBundleShortVersionString: pkg.version,
  CFBundleVersion: pkg.version,
  LSMinimumSystemVersion: "15.0",
  NSCameraUsageDescription:
    "Record your webcam on its own editable video track.",
  NSMicrophoneUsageDescription:
    "Record microphone audio for your screen recordings.",
  NSAudioCaptureUsageDescription: "Record system audio with your screen video.",
  NSHumanReadableCopyright:
    "Copyright © 2026 Vin Pacheco and contributors. MIT license.",
})) {
  execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
}
await fs.rm(path.join(target, "Contents/Resources/default_app.asar"), {
  force: true,
});
// Ad-hoc signing pins macOS privacy grants to a changing binary hash. Prefer a
// stable Developer ID when available so rebuilding does not invalidate TCC.
let signingIdentity = process.env.FRAME_SIGNING_IDENTITY;
if (!signingIdentity) {
  const identities = execFileSync(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8" },
  );
  const matches = [
    ...identities.matchAll(
      /\b([A-F0-9]{40}) "Developer ID Application: [^"]+"/g,
    ),
  ];
  if (matches.length > 1)
    throw new Error(
      "Set FRAME_SIGNING_IDENTITY to choose a Developer ID certificate",
    );
  signingIdentity = matches[0]?.[1] || "-";
}
console.log(
  signingIdentity === "-"
    ? "Ad-hoc signing: updates may require renewed macOS permissions"
    : "Signing with a stable Developer ID identity",
);
if (signingIdentity === "-") {
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", target],
    {
      stdio: "inherit",
    },
  );
} else {
  await sign({
    app: target,
    identity: signingIdentity,
    platform: "darwin",
    type: "distribution",
    preEmbedProvisioningProfile: false,
    optionsForFile: (file) => ({
      hardenedRuntime: true,
      entitlements: ["frame-capture", "frame-cursor", "frame-render"].includes(
        path.basename(file),
      )
        ? []
        : [
            "com.apple.security.cs.allow-jit",
            "com.apple.security.device.camera",
            "com.apple.security.device.audio-input",
          ],
    }),
  });
}
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", target], {
  stdio: "inherit",
});
const previous = path.join(buildRoot, "previous.app");
let backedUp = false;
try {
  await fs.rename(final, previous);
  backedUp = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  await fs.rename(target, final);
} catch (error) {
  if (backedUp) await fs.rename(previous, final);
  throw error;
}
await fs.rm(buildRoot, { recursive: true, force: true });
console.log(final);
