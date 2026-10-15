import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

async function licenseFiles(root) {
  const pkg = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const files = [
    {
      source: "LICENSE",
      file: "PROJECT-LICENSE.txt",
      component: pkg.productName,
      version: pkg.version,
    },
    {
      source: "THIRD_PARTY_NOTICES.md",
      file: "THIRD_PARTY_NOTICES.md",
      component: "Acknowledgements",
    },
    {
      source: "node_modules/electron/dist/LICENSE",
      file: "Electron-LICENSE.txt",
      component: "Electron",
      version: lock.packages["node_modules/electron"].version,
    },
    {
      source: "node_modules/electron/dist/LICENSES.chromium.html",
      file: "LICENSES.chromium.html",
      component: "Chromium and bundled components",
    },
    {
      source: "desktop/models/NOTICE.md",
      file: "MODEL-NOTICE.md",
      component: "Audio model",
    },
    {
      source: "desktop/models/RNNOISE-MODELS.md",
      file: "RNNOISE-MODELS.md",
      component: "Audio model source and rights",
    },
  ];
  // Include the complete upstream notices, not only the package's SPDX label.
  for (const [location, info] of Object.entries(lock.packages).sort()) {
    if (!location || info.dev) continue;
    if (
      !/^node_modules\/[\w@./-]+$/.test(location) ||
      location.split("/").includes("..")
    )
      throw new Error("Invalid dependency location in package lock");
    const notices = (
      await fs.readdir(path.join(root, location), { withFileTypes: true })
    )
      .filter(
        (entry) =>
          entry.isFile() &&
          /^(license|licence|notice|copying)(\.|$)/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    if (!notices.length)
      throw new Error(`Missing upstream license: ${location}`);
    for (const name of notices)
      files.push({
        source: `${location}/${name}`,
        file: `dependencies/${location.replace(/^node_modules\//, "")}/${name}`,
        component: location.replace(/^node_modules\//, ""),
        version: info.version,
      });
  }
  for (const file of files) {
    file.bytes = await fs.readFile(path.join(root, file.source));
    if (!file.bytes.length) throw new Error(`Empty license: ${file.source}`);
  }
  return { pkg, files };
}

export async function writeLicenseBundle(root, resources) {
  const { pkg, files } = await licenseFiles(root);
  const directory = path.join(resources, "licenses");
  const manifest = {
    version: 1,
    product: pkg.productName,
    productVersion: pkg.version,
    files: files.map(({ file, component, version, bytes }) => ({
      file,
      component,
      ...(version ? { version } : {}),
      sha256: hash(bytes),
    })),
  };
  for (const { file, bytes } of files) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(directory, "index.html"),
    `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(pkg.productName)} — Licenses</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:800px;margin:48px auto;padding:0 24px;background:#09090b;color:#e4e4e7}a{color:#a5b4fc}li{margin:12px 0}small{color:#a1a1aa}</style>
<h1>Licenses &amp; acknowledgements</h1><p>${escape(pkg.productName)} ${escape(pkg.version)}</p>
<p>The project's own code is licensed under ${escape(pkg.license)}. Third-party components retain their original terms.</p>
<ul>${manifest.files.map((f) => `<li><a href="${escape(f.file)}">${escape(f.component)}</a>${f.version ? ` <small>${escape(f.version)}</small>` : ""}</li>`).join("\n")}</ul>
<p>FFmpeg and ffprobe are installed separately and are not bundled with this application.</p>
<p><a href="manifest.json">Versions and SHA-256 checksums</a></p></html>\n`,
  );
  return manifest;
}

export async function verifyLicenseBundle(root, resources) {
  const { pkg, files } = await licenseFiles(root);
  const directory = path.join(resources, "licenses");
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.version !== 1 ||
    manifest.product !== pkg.productName ||
    manifest.productVersion !== pkg.version ||
    manifest.files.length !== files.length
  )
    throw new Error("License manifest does not match this build");
  for (const { file, bytes, component, version } of files) {
    const installed = await fs.readFile(path.join(directory, file));
    const entry = manifest.files.find((item) => item.file === file);
    if (
      !bytes.equals(installed) ||
      entry?.sha256 !== hash(bytes) ||
      entry.component !== component ||
      entry.version !== version
    )
      throw new Error(`Packaged license differs: ${file}`);
  }
  const index = await fs.readFile(path.join(directory, "index.html"), "utf8");
  for (const { file } of files)
    if (!index.includes(`href="${escape(file)}"`))
      throw new Error(`License link missing: ${file}`);
  return manifest;
}
