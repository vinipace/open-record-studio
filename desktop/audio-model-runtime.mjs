import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const uvVersion = "0.12.6";
const uvHash =
  "14b459d51ea2e71eeba28c45a268c922bdf8607fc6455e3f40b4e082895d160d";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Kill the entire process group: uv launches Python, which must not continue
// downloading or consuming CPU after the user switches models or closes a project.
export function runAudioProcess(
  command,
  args,
  { signal, cwd, env, onMessage = () => {} } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error,
      stderr = "",
      pending = "";
    const abort = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          if (e.code !== "ESRCH") error = e;
        }
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", (e) => {
      error = e;
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-12000);
    });
    child.stdout.on("data", (data) => {
      pending += data;
      const lines = pending.split("\n");
      pending = lines.pop().slice(-12000);
      for (const line of lines) {
        if (!line.startsWith("studio-progress:")) continue;
        try {
          onMessage(JSON.parse(line.slice(16)));
        } catch {}
      }
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else if (error || code !== 0)
        reject(
          error ||
            new Error(
              stderr.slice(-2500) || `Audio processing exited with ${code}`,
            ),
        );
      else resolve();
    });
  });
}

async function prepareUv(root, { signal, onStatus }) {
  const executable = path.join(root, `uv-${uvVersion}`, "uv");
  if ((await stat(executable).catch(() => null))?.size) return executable;
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Additional audio models require an Apple silicon Mac.");
  onStatus("Downloading local audio tools…");
  const temp = await mkdtemp(path.join(root, ".uv-"));
  try {
    const response = await fetch(
      `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-aarch64-apple-darwin.tar.gz`,
      { signal },
    );
    if (!response.ok)
      throw new Error(
        `Audio tools download failed (${response.status}). Check your connection and retry.`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== uvHash)
      throw new Error(
        "Audio tools download failed verification. Please retry.",
      );
    const archive = path.join(temp, "uv.tar.gz");
    await writeFile(archive, bytes);
    await runAudioProcess("/usr/bin/tar", ["-xzf", archive, "-C", temp], {
      signal,
    });
    signal?.throwIfAborted();
    await rename(
      path.join(temp, "uv-aarch64-apple-darwin"),
      path.dirname(executable),
    ).catch(async (error) => {
      if (!(await stat(executable).catch(() => null))?.size) throw error;
    });
    return executable;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function audioRuntimeVersion() {
  const [script, requirements] = await Promise.all([
    readFile(new URL("./models/enhance.py", import.meta.url)),
    readFile(new URL("./models/requirements-audio.txt", import.meta.url)),
  ]);
  return {
    script,
    requirements,
    hash: hash(Buffer.concat([script, requirements])),
  };
}

export async function runAudioModel(
  model,
  input,
  output,
  { signal, onProgress = () => {}, onStatus = () => {} } = {},
) {
  const root =
    process.env.FRAME_AUDIO_MODELS ||
    path.join(
      os.homedir(),
      "Library/Application Support/Open Record Studio/audio-models",
    );
  await mkdir(root, { recursive: true });
  const runtime = await audioRuntimeVersion();
  // External Python cannot read inside app.asar. Materialize versioned sources
  // in Application Support; identical files are safe across preview and exports.
  const sourceRoot = path.join(root, runtime.hash);
  await mkdir(sourceRoot, { recursive: true });
  for (const [name, bytes] of [
    ["enhance.py", runtime.script],
    ["requirements.txt", runtime.requirements],
  ]) {
    const destination = path.join(sourceRoot, name);
    const existing = await readFile(destination).catch(() => null);
    if (existing?.equals(bytes)) continue;
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const uv = await prepareUv(root, { signal, onStatus });
  onStatus(
    "Preparing local audio engine. First use downloads several hundred MB…",
  );
  const scratch = await mkdtemp(path.join(root, ".worker-"));
  try {
    await runAudioProcess(
      uv,
      [
        "run",
        "--no-project",
        "--link-mode",
        "hardlink",
        "--python",
        "3.11.13",
        "--with-requirements",
        path.join(sourceRoot, "requirements.txt"),
        "python",
        path.join(sourceRoot, "enhance.py"),
        model,
        input,
        output,
        root,
      ],
      {
        signal,
        cwd: root,
        env: {
          ...process.env,
          UV_PYTHON_PREFERENCE: "only-managed",
          UV_NO_CONFIG: "1",
          PYTHONNOUSERSITE: "1",
          PYTHONUNBUFFERED: "1",
          STUDIO_AUDIO_TEMP: scratch,
          NUMBA_CACHE_DIR: path.join(root, "numba"),
          HF_HUB_DISABLE_TELEMETRY: "1",
          OMP_NUM_THREADS: "2",
          MKL_NUM_THREADS: "2",
        },
        onMessage: ({ message, progress }) => {
          if (typeof message === "string") onStatus(message);
          if (Number.isFinite(progress))
            onProgress(Math.max(0, Math.min(1, progress)));
        },
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
