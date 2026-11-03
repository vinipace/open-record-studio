import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { binary, run, exportArgs, validateEdits } from "./media.mjs";
import { prepareUv, runAudioProcess } from "./audio-model-runtime.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function transcriptEdits(project, edits) {
  const snapshot = validateEdits(edits, project.duration, project.assets);
  // Recognize speech at its original speed. Cuts, removed audio, volume and
  // webcam takes still follow the edited video; text itself has no timestamps.
  return {
    ...snapshot,
    style: { ...snapshot.style, speed: 1, enhanceAudio: false },
  };
}
export async function runTranscription(
  input,
  output,
  root,
  { signal, onStatus = () => {} } = {},
) {
  input = path.resolve(input);
  output = path.resolve(output);
  root = path.resolve(root);
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Local transcription requires an Apple silicon Mac");
  const [script, requirements] = await Promise.all([
    readFile(new URL("./models/transcribe.py", import.meta.url)),
    readFile(new URL("./models/requirements-transcript.txt", import.meta.url)),
  ]);
  const source = path.join(root, hash(Buffer.concat([script, requirements])));
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "transcribe.py"), script);
  await writeFile(path.join(source, "requirements.txt"), requirements);
  const uv = await prepareUv(root, { signal, onStatus });
  onStatus("Preparing local transcription. First use downloads speech tools…");
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
      path.join(source, "requirements.txt"),
      "python",
      path.join(source, "transcribe.py"),
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
        HF_HUB_DISABLE_TELEMETRY: "1",
        HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
        HF_HUB_DISABLE_XET: "1",
        OMP_NUM_THREADS: "2",
        MKL_NUM_THREADS: "2",
        NUMBA_CACHE_DIR: path.join(root, "numba"),
      },
      onMessage: ({ message }) => {
        if (typeof message === "string") onStatus(message);
      },
    },
  );
}

export async function transcribeProject(
  project,
  edits,
  {
    signal,
    onStatus = () => {},
    root = process.env.FRAME_TRANSCRIPT_ROOT ||
      path.join(
        os.homedir(),
        "Library/Application Support/Open Record Studio/transcription",
      ),
    transcribe = runTranscription,
  } = {},
) {
  signal?.throwIfAborted();
  const snapshot = transcriptEdits(project, edits);
  const sources = [
    ...Object.values(project.tracks),
    ...Object.values(project.assets || {}),
  ];
  const files = await Promise.all(
    sources.map(async (source) => {
      const file = path.join(project.directory, source.file);
      const info = await stat(file);
      return [file, info.size, info.mtimeMs];
    }),
  );
  const engine = await Promise.all(
    ["transcribe.py", "requirements-transcript.txt"].map((file) =>
      readFile(new URL(`./models/${file}`, import.meta.url)),
    ),
  );
  const key = hash(
    JSON.stringify([
      "transcript-v1",
      hash(Buffer.concat(engine)),
      snapshot,
      files,
    ]),
  );
  const cache = path.join(root, "transcripts");
  await mkdir(cache, { recursive: true });
  const target = path.join(cache, key + ".json");
  const cached = await readFile(target, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (typeof cached?.text === "string") {
    signal?.throwIfAborted();
    return cached.text;
  }
  const scratch = await mkdtemp(path.join(root, ".transcribe-"));
  try {
    onStatus("Preparing edited audio…");
    const input = path.join(scratch, "audio.wav"),
      result = path.join(scratch, "result.json");
    const args = exportArgs(
      project,
      snapshot,
      { audio: true, height: 720, fps: 30 },
      "audio",
      input,
    );
    await run(await binary("ffmpeg"), args, { signal });
    await transcribe(input, result, root, { signal, onStatus });
    signal?.throwIfAborted();
    const output = JSON.parse(await readFile(result, "utf8"));
    if (typeof output.text !== "string" || output.text.length > 2_000_000)
      throw new Error("The transcription engine returned invalid text");
    await rename(result, target);
    return output.text;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
