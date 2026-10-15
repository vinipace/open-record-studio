import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractFile } from "@electron/asar";
import { productName, bundleIdentifier } from "../desktop/app-identity.mjs";
import { verifyLicenseBundle } from "./licenses.mjs";

const exec = promisify(execFile);
const run = async (command, args) =>
  (await exec(command, args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const root = process.cwd();
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
const preview = process.argv.includes("--preview");
const profile = process.env.NOTARYTOOL_PROFILE;
const repo = "vinipace/open-record-studio";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error(
    "The current downloadable release targets Apple silicon macOS only",
  );
if (!/^\d+\.\d+\.\d+$/.test(pkg.version))
  throw new Error("Release version must be x.y.z");
if (!preview && !profile)
  throw new Error(
    "Set NOTARYTOOL_PROFILE for notarization, or explicitly use --preview",
  );
if (await run("git", ["status", "--porcelain"]))
  throw new Error("Commit changes before building a release");
const sourceCommit = await run("git", ["rev-parse", "HEAD"]);
const tag = `v${pkg.version}`;
const output = path.join(root, "release", tag, "macos-arm64");
if (await fs.stat(output).catch(() => null))
  throw new Error(`Release already exists: ${output}`);
const app = path.join(root, "release", `${productName}.app`);
const resources = path.join(app, "Contents/Resources");
const plist = path.join(app, "Contents/Info.plist");
const value = (key) => run("/usr/bin/plutil", ["-extract", key, "raw", plist]);
if (
  (await value("CFBundleIdentifier")) !== bundleIdentifier ||
  (await value("CFBundleShortVersionString")) !== pkg.version
)
  throw new Error("App identity/version differs from package metadata");
if ((await value("LSMinimumSystemVersion")) !== "15.0")
  throw new Error("Unexpected minimum macOS version");
const asar = path.join(resources, "app.asar");
const bundledPackage = JSON.parse(extractFile(asar, "package.json"));
if (
  bundledPackage.version !== pkg.version ||
  bundledPackage.productName !== productName
)
  throw new Error("Packaged code differs from release metadata");
// Every packaged runtime source must match this commit, including the renderer.
for (const file of (await run("git", ["ls-files", "desktop"])).split("\n")) {
  if (!(await fs.readFile(file)).equals(extractFile(asar, file)))
    throw new Error(`Stale packaged source: ${file}`);
}
for (const entry of await fs.readdir("dist", {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile()) continue;
  const source = path.join(entry.parentPath, entry.name);
  const relative = path.relative(root, path.resolve(source));
  if (!(await fs.readFile(source)).equals(extractFile(asar, relative)))
    throw new Error(`Stale packaged frontend: ${relative}`);
}
await verifyLicenseBundle(root, resources);
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const signature = (await exec("/usr/bin/codesign", ["-dvv", app])).stderr;
if (
  !signature.includes("Authority=Developer ID Application:") ||
  !signature.includes("runtime") ||
  !signature.includes("Timestamp=")
)
  throw new Error(
    "Releases require a timestamped Developer ID signature with Hardened Runtime",
  );
const identity = signature.match(
  /^Authority=(Developer ID Application:.+)$/m,
)?.[1];
for (const executable of [
  "Contents/MacOS/Electron",
  ...["frame-capture", "frame-cursor", "frame-render"].map(
    (n) => `Contents/Resources/${n}`,
  ),
]) {
  if (
    (await run("/usr/bin/lipo", ["-archs", path.join(app, executable)])) !==
    "arm64"
  )
    throw new Error(`Unexpected architecture: ${executable}`);
}

const stage = await fs.mkdtemp(path.join(root, "release", ".distribution-"));
const artifacts = path.join(stage, "artifacts");
await fs.mkdir(artifacts);
const basename = `Open-Record-Studio-${pkg.version}-macOS-arm64`;
const zip = path.join(artifacts, `${basename}.zip`);
const dmg = path.join(artifacts, `${basename}.dmg`);
const notarize = async (file) => {
  console.log(`Submitting ${path.basename(file)} for Apple notarization…`);
  const result = JSON.parse(
    await run("xcrun", [
      "notarytool",
      "submit",
      file,
      "--keychain-profile",
      profile,
      "--output-format",
      "json",
      "--wait",
      "--timeout",
      "20m",
    ]),
  );
  if (result.status !== "Accepted")
    throw new Error(
      `Apple notarization ${result.status}; submission ${result.id}`,
    );
  return result.id;
};
try {
  const submissions = [];
  if (!preview) {
    const submission = path.join(stage, "notary-app.zip");
    await run("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      app,
      submission,
    ]);
    submissions.push(await notarize(submission));
    await run("xcrun", ["stapler", "staple", app]);
    await run("xcrun", ["stapler", "validate", app]);
  }
  console.log("Creating ZIP and drag-to-Applications disk image…");
  await run("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    app,
    zip,
  ]);
  const imageRoot = path.join(stage, "disk-image");
  await fs.mkdir(imageRoot);
  await fs.cp(app, path.join(imageRoot, `${productName}.app`), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await fs.symlink("/Applications", path.join(imageRoot, "Applications"));
  const installation = `${productName} ${pkg.version}\n\nRequires an Apple silicon Mac and macOS 15 or later.\n\n1. Drag ${productName}.app into Applications.\n2. Install the media tools with Homebrew: brew install ffmpeg\n3. Open ${productName} from Applications. No Node.js or source build is needed.\n\n${preview ? "This preview is Developer ID signed but NOT notarized by Apple. macOS may block its first launch. Review the source and signing identity before deciding whether to allow it in System Settings > Privacy & Security. Do not disable Gatekeeper.\n" : "This build is Developer ID signed and notarized by Apple.\n"}\nThe app requests screen/camera/microphone access as needed. Screen interaction tracking also requires Accessibility and Input Monitoring.\n\nSource, license and installation help: https://github.com/${repo}\n`;
  await fs.writeFile(path.join(imageRoot, "INSTALL.txt"), installation);
  await fs.writeFile(path.join(artifacts, "INSTALL.txt"), installation);
  await run("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    imageRoot,
    "-format",
    "UDZO",
    "-fs",
    "HFS+",
    dmg,
  ]);
  await run("/usr/bin/codesign", ["--sign", identity, "--timestamp", dmg]);
  await run("hdiutil", ["verify", dmg]);
  if (!preview) {
    submissions.push(await notarize(dmg));
    await run("xcrun", ["stapler", "staple", dmg]);
    await run("xcrun", ["stapler", "validate", dmg]);
    await run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=2",
      app,
    ]);
  }
  const sha256 = async (file) =>
    createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  const cask = `cask "open-record-studio" do\n  version "${pkg.version}"\n  sha256 "${await sha256(dmg)}"\n\n  url "https://github.com/${repo}/releases/download/v#{version}/Open-Record-Studio-#{version}-macOS-arm64.dmg"\n  name "Open Record Studio"\n  desc "Local screen and webcam recorder with synchronized video editing"\n  homepage "https://github.com/${repo}"\n\n  depends_on formula: "ffmpeg"\n  depends_on macos: :sequoia\n  depends_on arch: :arm64\n\n  app "Open Record Studio.app"\n${preview ? '\n  caveats "This preview is signed but not notarized. macOS may block its first launch."\n' : ""}end\n`;
  await fs.writeFile(path.join(artifacts, "open-record-studio.rb"), cask);
  const manifest = {
    product: productName,
    version: pkg.version,
    tag,
    sourceCommit,
    platform: "darwin",
    architecture: "arm64",
    minimumMacOS: "15.0",
    developerIDSigned: true,
    notarized: !preview,
    notarizationSubmissions: submissions,
    appAsarSha256: await sha256(asar),
    files: await Promise.all(
      (await fs.readdir(artifacts))
        .sort()
        .map(async (name) => ({
          name,
          bytes: (await fs.stat(path.join(artifacts, name))).size,
          sha256: await sha256(path.join(artifacts, name)),
        })),
    ),
  };
  await fs.writeFile(
    path.join(artifacts, "release.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const checksums = await Promise.all(
    (await fs.readdir(artifacts))
      .sort()
      .map(
        async (name) => `${await sha256(path.join(artifacts, name))}  ${name}`,
      ),
  );
  await fs.writeFile(
    path.join(artifacts, "SHA256SUMS.txt"),
    checksums.join("\n") + "\n",
  );
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.rename(artifacts, output);
  console.log(
    JSON.stringify({ output, tag, sourceCommit, notarized: !preview }),
  );
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
