import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const launcherPath = "bin/open-record-studio-mcp";
const helpers = ["frame-cursor", "frame-render"];

async function bundleSources(root) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json")));
  const lock = JSON.parse(
    await fs.readFile(path.join(root, "package-lock.json")),
  );
  const directories = ["mcp", "desktop"];
  const dependencies = {};
  // Copy only locked production packages, not the developer's node_modules tree.
  for (const [location, info] of Object.entries(lock.packages).sort()) {
    if (!location || info.dev) continue;
    if (
      !/^node_modules\/[\w@./-]+$/.test(location) ||
      location.split("/").includes("..")
    )
      throw new Error("Invalid runtime dependency path");
    const installed = JSON.parse(
      await fs.readFile(path.join(root, location, "package.json")),
    );
    if (installed.version !== info.version)
      throw new Error(
        `Run npm ci: runtime dependency differs from lockfile: ${location}`,
      );
    directories.push(location);
    dependencies[location] = info.version;
  }
  const sources = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(path.join(root, directory), {
      withFileTypes: true,
    })) {
      // Nested dependencies are copied from their own lockfile entries.
      if (entry.name === "node_modules") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) sources.push(file);
      else throw new Error(`Unexpected symlink in MCP runtime source: ${file}`);
    }
  }
  for (const directory of directories) await visit(directory);
  const files = await Promise.all(
    sources.sort().map(async (source) => ({
      file: `mcp-runtime/${source}`,
      bytes: await fs.readFile(path.join(root, source)),
    })),
  );
  files.push(
    {
      file: "mcp-runtime/package.json",
      bytes: Buffer.from(
        JSON.stringify(
          {
            name: pkg.name,
            productName: pkg.productName,
            version: pkg.version,
            type: "module",
            license: pkg.license,
            dependencies: pkg.dependencies,
          },
          null,
          2,
        ) + "\n",
      ),
    },
    {
      file: launcherPath,
      bytes: await fs.readFile(path.join(root, "scripts/mcp-launcher.sh")),
    },
  );
  return { pkg, files, dependencies };
}

export async function writeMcpBundle(root, resources) {
  const { pkg, files, dependencies } = await bundleSources(root);
  for (const { file, bytes } of files) {
    const destination = path.join(resources, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
  }
  await fs.chmod(path.join(resources, launcherPath), 0o755);
  const native = path.join(resources, "mcp-runtime/native/bin");
  await fs.mkdir(native, { recursive: true });
  for (const helper of helpers)
    await fs.symlink(`../../../${helper}`, path.join(native, helper));
  // The unpacked ESM runtime retains normal Node module/resource resolution;
  // its native helpers point to the same signed executables as the desktop app.
  await fs.writeFile(
    path.join(resources, "mcp-runtime/manifest.json"),
    JSON.stringify(
      {
        version: 1,
        productVersion: pkg.version,
        launcher: launcherPath,
        dependencies,
        files: files.map(({ file, bytes }) => ({ file, sha256: hash(bytes) })),
      },
      null,
      2,
    ) + "\n",
  );
}

export async function verifyMcpBundle(root, resources) {
  const { pkg, files, dependencies } = await bundleSources(root);
  const manifest = JSON.parse(
    await fs.readFile(path.join(resources, "mcp-runtime/manifest.json")),
  );
  if (
    manifest.version !== 1 ||
    manifest.productVersion !== pkg.version ||
    manifest.launcher !== launcherPath ||
    manifest.files.length !== files.length ||
    JSON.stringify(manifest.dependencies) !== JSON.stringify(dependencies)
  )
    throw new Error("MCP bundle manifest differs from this build");
  for (const { file, bytes } of files) {
    const packed = await fs.readFile(path.join(resources, file));
    if (
      !packed.equals(bytes) ||
      manifest.files.find((entry) => entry.file === file)?.sha256 !==
        hash(packed)
    )
      throw new Error(`Packaged MCP runtime differs: ${file}`);
  }
  const launcher = await fs.stat(path.join(resources, launcherPath));
  if (!(launcher.mode & 0o111))
    throw new Error("MCP launcher is not executable");
  for (const helper of helpers) {
    const link = path.join(resources, "mcp-runtime/native/bin", helper);
    if (
      (await fs.readlink(link)) !== `../../../${helper}` ||
      (await fs.realpath(link)) !==
        (await fs.realpath(path.join(resources, helper)))
    )
      throw new Error(`MCP native helper points outside the app: ${helper}`);
  }
  return manifest;
}
