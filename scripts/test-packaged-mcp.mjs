import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { verifyMcpBundle } from "./mcp-bundle.mjs";
import { packageFingerprint } from "./package-fingerprint.mjs";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const source =
  process.env.FRAME_TEST_APP ||
  path.join(root, "release/Open Record Studio.app");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json")));
const temporary = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "Open Record MCP E2E ")),
);
const app = path.join(temporary, "Custom Applications/Open Record Studio.app");
const evidence = path.join(root, "evidence/packaged-mcp.json");
await fs.rm(evidence, { force: true });
try {
  await fs.mkdir(path.dirname(app));
  await exec("/usr/bin/ditto", [source, app]);
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  await verifyMcpBundle(root, path.join(app, "Contents/Resources"));
  assert.deepEqual(
    await packageFingerprint(app),
    await packageFingerprint(source),
  );
  const launcher = path.join(
    app,
    "Contents/Resources/bin/open-record-studio-mcp",
  );
  const bin = path.join(temporary, "bin");
  await fs.mkdir(bin);
  const linked = path.join(bin, "open-record-studio-mcp");
  // Exercise Homebrew's absolute symlink plus an additional relative link.
  await fs.symlink(launcher, path.join(bin, "mcp-target"));
  await fs.symlink("mcp-target", linked);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: temporary,
    NODE_OPTIONS: "--require=/does-not-exist.cjs",
    NODE_PATH: "/does-not-exist",
  };
  await assert.rejects(exec("node", ["--version"], { cwd: temporary, env }), {
    code: "ENOENT",
  });
  for (const command of [launcher, linked]) {
    const version = await exec(command, ["--version"], { cwd: temporary, env });
    assert.equal(
      version.stdout.trim(),
      `Open Record Studio MCP ${pkg.version}`,
    );
    assert.equal(version.stderr, "");
    const config = await exec(command, ["--print-config"], {
      cwd: temporary,
      env,
    });
    assert.deepEqual(JSON.parse(config.stdout), {
      mcpServers: { "open-record-studio": { command: launcher, args: [] } },
    });
    assert.equal(config.stderr, "");
  }
  assert.match(
    (await exec(linked, ["--help"], { cwd: temporary, env })).stdout,
    /stdin\/stdout/,
  );
  await assert.rejects(
    exec(linked, ["--unknown"], { cwd: temporary, env }),
    (error) =>
      error.code === 1 &&
      error.stdout === "" &&
      /Unknown arguments/.test(error.stderr),
  );
  let output = "";
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", "--test-reporter=tap", "tests/mcp.test.mjs"],
      {
        cwd: root,
        env: {
          ...process.env,
          FRAME_MCP_COMMAND: linked,
          FRAME_MCP_CWD: temporary,
          FRAME_AUDIO_CACHE: path.join(temporary, "audio-cache"),
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Packaged MCP tests exited ${code}`)),
    );
  });
  const passed = Number(output.match(/# pass (\d+)/)?.[1]);
  assert(passed >= 9, "All MCP workflows must execute");
  await fs.mkdir(path.dirname(evidence), { recursive: true });
  await fs.writeFile(
    evidence,
    JSON.stringify(
      {
        passed,
        version: pkg.version,
        date: new Date().toISOString(),
        relocated: true,
        noExternalNode: true,
        symlinkLauncher: true,
        fingerprint: await packageFingerprint(source),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
