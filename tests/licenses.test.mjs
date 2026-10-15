import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeLicenseBundle,
  verifyLicenseBundle,
} from "../scripts/licenses.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "record-studio-licenses-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sources = {
    "package.json": JSON.stringify({
      productName: "Open Record Studio",
      version: "0.1.0",
      license: "MIT",
    }),
    "package-lock.json": JSON.stringify({
      packages: {
        "": {},
        "node_modules/electron": { version: "44.7.2", dev: true },
        "node_modules/@example/runtime": { version: "1.2.3" },
        "node_modules/dev-only": { version: "9.0.0", dev: true },
      },
    }),
    LICENSE: "Project MIT license\n",
    "THIRD_PARTY_NOTICES.md": "Third-party terms are retained.\n",
    "node_modules/electron/dist/LICENSE": "Electron copyright and license\r\n",
    "node_modules/electron/dist/LICENSES.chromium.html":
      "<html>All bundled Chromium notices</html>\n",
    "node_modules/@example/runtime/LICENSE":
      "Upstream license — including legacy contributions\r\n",
    "node_modules/@example/runtime/NOTICE.txt": "Additional upstream notice\n",
    "desktop/models/NOTICE.md": "Model provenance\n",
    "desktop/models/RNNOISE-MODELS.md": "Model rights summary and source\n",
  };
  for (const [file, content] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return {
    root,
    resources: path.join(root, "app/Contents/Resources"),
    sources,
  };
}

test("packaging preserves full upstream licenses and notices byte for byte", async (t) => {
  const { root, resources, sources } = await fixture(t);
  const manifest = await writeLicenseBundle(root, resources);
  assert.deepEqual(await verifyLicenseBundle(root, resources), manifest);
  assert.equal(manifest.files.length, 8);
  for (const name of ["LICENSE", "NOTICE.txt"]) {
    const source = `node_modules/@example/runtime/${name}`;
    const file = `dependencies/@example/runtime/${name}`;
    assert.equal(
      await fs.readFile(path.join(resources, "licenses", file), "utf8"),
      sources[source],
    );
    assert.equal(
      manifest.files.find((item) => item.file === file).version,
      "1.2.3",
    );
  }
  assert.equal(
    await fs.readFile(
      path.join(resources, "licenses/Electron-LICENSE.txt"),
      "utf8",
    ),
    sources["node_modules/electron/dist/LICENSE"],
  );
});

test("missing mandatory or production dependency notices block packaging", async (t) => {
  const { root, resources } = await fixture(t);
  await fs.rm(
    path.join(root, "node_modules/electron/dist/LICENSES.chromium.html"),
  );
  await assert.rejects(writeLicenseBundle(root, resources), /ENOENT/);
  await fs.rm(path.join(root, "node_modules/@example/runtime/LICENSE"));
  await fs.rm(path.join(root, "node_modules/@example/runtime/NOTICE.txt"));
  await assert.rejects(
    writeLicenseBundle(root, resources),
    /Missing upstream license/,
  );
});

test("verification rejects altered or missing packaged notices and incomplete links", async (t) => {
  const { root, resources } = await fixture(t);
  await writeLicenseBundle(root, resources);
  await fs.writeFile(
    path.join(resources, "licenses/Electron-LICENSE.txt"),
    "SPDX label only",
  );
  await assert.rejects(
    verifyLicenseBundle(root, resources),
    /Packaged license differs/,
  );
  await writeLicenseBundle(root, resources);
  await fs.rm(path.join(resources, "licenses/LICENSES.chromium.html"));
  await assert.rejects(verifyLicenseBundle(root, resources), /ENOENT/);
  await writeLicenseBundle(root, resources);
  await fs.writeFile(path.join(resources, "licenses/index.html"), "No links");
  await assert.rejects(
    verifyLicenseBundle(root, resources),
    /License link missing/,
  );
});

test("verification rejects a manifest with a wrong component version", async (t) => {
  const { root, resources } = await fixture(t);
  const manifest = await writeLicenseBundle(root, resources);
  manifest.files.find((entry) => entry.component === "Electron").version =
    "0.0.0";
  await fs.writeFile(
    path.join(resources, "licenses/manifest.json"),
    JSON.stringify(manifest),
  );
  await assert.rejects(
    verifyLicenseBundle(root, resources),
    /Packaged license differs/,
  );
});
