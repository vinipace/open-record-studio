import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  stat,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { binary, run } from "./media.mjs";
import { audioModel, defaultAudioModel } from "./audio-models.mjs";
import { audioRuntimeVersion, runAudioModel } from "./audio-model-runtime.mjs";

export function enhancementSources(project) {
  return Object.fromEntries([
    ...["screen", "microphone"].flatMap((key) =>
      project.tracks[key]?.audio ? [[key, project.tracks[key]]] : [],
    ),
    ...Object.entries(project.assets || {}).flatMap(([id, asset]) =>
      asset.audio && asset.timeMap ? [[`asset-${id}`, asset]] : [],
    ),
  ]);
}

// Process each original track once, before cuts or speed changes. Preview and
// export share lossless cached audio; inference never runs on the renderer.
export async function enhanceProjectAudio(
  project,
  {
    signal,
    onProgress = () => {},
    onStatus = () => {},
    cacheRoot,
    model: modelId = project.edits?.style.audioEnhancementModel ??
      defaultAudioModel,
  } = {},
) {
  const selected = audioModel(modelId);
  signal?.throwIfAborted();
  // Retain the existing cache after the product rename to avoid reprocessing.
  const root =
    cacheRoot ||
    process.env.FRAME_AUDIO_CACHE ||
    path.join(os.homedir(), "Library/Caches/Frame Studio/enhanced-audio");
  await mkdir(root, { recursive: true });
  let modelHash, modelName;
  if (modelId === "rnnoise") {
    const model = await readFile(new URL("./models/bd.rnnn", import.meta.url));
    modelHash = createHash("sha256").update(model).digest("hex");
    modelName = `${modelHash}.rnnn`;
    await writeFile(path.join(root, modelName), model, { flag: "wx" }).catch(
      (error) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  } else {
    modelHash = (await audioRuntimeVersion()).hash;
  }
  const sources = Object.entries(enhancementSources(project)),
    result = {};
  const command = await binary("ffmpeg");
  for (const [index, [key, source]] of sources.entries()) {
    signal?.throwIfAborted();
    const file = await realpath(path.join(project.directory, source.file));
    const info = await stat(file);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          modelId === "rnnoise" ? "rnnoise-bd-v1-delay480" : `${modelId}-v1`,
          modelHash,
          file,
          info.size,
          info.mtimeMs,
          source.duration,
        ]),
      )
      .digest("hex");
    const target = path.join(root, `${hash}.flac`);
    if (!(await stat(target).catch(() => null))?.size) {
      const temp = path.join(root, `${hash}-${randomUUID()}.flac`);
      let workspace;
      try {
        let input = file;
        const progress = (ratio) =>
          onProgress((index + ratio) / sources.length);
        onStatus(`Enhancing with ${selected.name}…`);
        if (modelId !== "rnnoise") {
          workspace = await mkdtemp(path.join(root, ".model-"));
          const decoded = path.join(workspace, "input.wav");
          input = path.join(workspace, "output.wav");
          await run(
            command,
            [
              "-v",
              "error",
              "-nostdin",
              "-n",
              "-i",
              file,
              "-map",
              "0:a:0",
              "-vn",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-c:a",
              "pcm_f32le",
              decoded,
            ],
            { signal },
          );
          await runAudioModel(modelId, decoded, input, {
            signal,
            onStatus,
            onProgress: (ratio) => progress(ratio * 0.95),
          });
        }
        await run(
          command,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-n",
            "-threads",
            "2",
            "-i",
            input,
            "-map",
            "0:a:0",
            "-vn",
            "-filter_threads",
            "2",
            "-af",
            modelId === "rnnoise"
              ? `aresample=48000,asetpts=PTS-STARTPTS,apad=pad_dur=0.01,arnndn=m=${modelName}:mix=1,atrim=start_sample=480,asetpts=PTS-STARTPTS,apad,atrim=duration=${source.duration}`
              : `asetpts=PTS-STARTPTS,apad,atrim=duration=${source.duration}`,
            "-ac",
            "2",
            "-c:a",
            "flac",
            "-sample_fmt",
            "s16",
            "-progress",
            "pipe:1",
            temp,
          ],
          {
            signal,
            cwd: root,
            onProgress: (seconds) =>
              progress(
                modelId === "rnnoise"
                  ? Math.min(1, seconds / source.duration)
                  : 0.95 + Math.min(1, seconds / source.duration) * 0.05,
              ),
          },
        );
        signal?.throwIfAborted();
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true });
        if (workspace) await rm(workspace, { recursive: true, force: true });
      }
    }
    result[key] = target;
    onProgress((index + 1) / sources.length);
  }
  return result;
}
