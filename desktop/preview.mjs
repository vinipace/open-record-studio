import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  binary,
  run,
  exportArgs,
  outputDuration,
  prepareCursor,
  validateEdits,
} from "./media.mjs";
import { sourceAt } from "./motion.mjs";

// Select after the complete composition graph. Seeking the inputs instead
// would reset zoom easing, cut mapping and the cursor's output-frame clock.
export async function previewProject(
  project,
  { time, mode = "combined", height = 360, fps = 60 },
  { signal } = {},
) {
  const edits = validateEdits(project.edits, project.duration, project.assets);
  const duration = outputDuration(edits);
  if (!Number.isFinite(time) || time < 0 || time >= duration)
    throw new Error(
      `Preview time must be >= 0 and < ${duration} output seconds`,
    );
  if (
    !["combined", "screen", "camera"].includes(mode) ||
    ![360, 720].includes(height) ||
    ![30, 60].includes(fps)
  )
    throw new Error("Invalid preview options");
  if (mode === "camera" && !project.tracks.camera)
    throw new Error("Project has no webcam track");
  const frame = Math.min(
    Math.ceil(duration * fps) - 1,
    Math.floor(time * fps + 1e-8),
  );
  const temp = await mkdtemp(path.join(os.tmpdir(), "frame-preview-"));
  try {
    const cursor =
      mode === "camera"
        ? undefined
        : await prepareCursor(project, edits, fps, temp, {
            signal,
            // FPS/overlay filters need a following timestamp to release the
            // selected frame, including when previewing output frame zero.
            frameCount: Math.min(Math.ceil(duration * fps), frame + 3),
          });
    const destination = path.join(temp, "preview.png");
    const args = exportArgs(
      project,
      edits,
      { height, fps, audio: false },
      mode,
      destination,
      cursor,
    );
    const index = args.indexOf("-filter_complex");
    const graph = path.join(temp, "graph.txt");
    await writeFile(
      graph,
      args[index + 1] +
        `;[vout]select='eq(n,${frame})',scale=w='min(1920,iw)':h=-2[preview]`,
    );
    args.splice(index, 2, "-filter_complex_script", graph);
    // Replace video encoder/output options with a single lossless image.
    args.splice(
      args.indexOf("-map"),
      args.length,
      "-map",
      "[preview]",
      "-frames:v",
      "1",
      "-fps_mode",
      "vfr",
      "-c:v",
      "png",
      "-update",
      "1",
      destination,
    );
    await run(await binary("ffmpeg"), args, { signal });
    const image = await readFile(destination);
    return {
      image,
      mimeType: "image/png",
      time: frame / fps,
      sourceTime: sourceAt(edits, frame / fps),
      frame,
      fps,
      width: image.readUInt32BE(16),
      height: image.readUInt32BE(20),
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
