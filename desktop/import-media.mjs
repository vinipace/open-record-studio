import fs from "node:fs/promises";
import path from "node:path";
import { binary, probe, run } from "./media.mjs";

export const imageExtensions = ["png", "jpg", "jpeg", "webp"];
export const videoExtensions = ["mp4", "mov", "mkv", "webm", "m4v"];
export const isImage = (file) =>
  imageExtensions.includes(path.extname(file).slice(1).toLowerCase());

export async function inspectImport(file, imageDuration = 10) {
  const image = isImage(file),
    meta = await probe(file);
  if (
    !meta.video ||
    !meta.width ||
    !meta.height ||
    (!image && meta.duration < 0.05)
  )
    throw new Error("Choose a video or image with usable visual content");
  if (
    image &&
    (!Number.isFinite(imageDuration) ||
      imageDuration < 0.1 ||
      imageDuration > 3600)
  )
    throw new Error("Image duration must be between 0.1 and 3600 seconds");
  if (!image && meta.duration > 86400)
    throw new Error("Videos must be 24 hours or shorter");
  return {
    ...meta,
    ...(image
      ? { duration: imageDuration, audio: false, sourceKind: "image" }
      : {}),
  };
}

export async function importTrack(file, directory, key, meta) {
  const extension = path.extname(file).toLowerCase();
  if (meta.sourceKind !== "image") {
    const name = key + extension;
    await fs.copyFile(
      file,
      path.join(directory, name),
      fs.constants.COPYFILE_EXCL,
    );
    return {
      ...meta,
      name: path.basename(file),
      sourceKind: "video",
      file: name,
      offset: 0,
    };
  }
  // Keep the original image, with an editable timed video for the same decoder,
  // thumbnail, cut, zoom and export paths used by recordings.
  const original = path.join(directory, `${key}-original${extension}`);
  await fs.copyFile(file, original, fs.constants.COPYFILE_EXCL);
  const name = `${key}.mp4`;
  await run(await binary("ffmpeg"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-n",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    original,
    "-t",
    String(meta.duration),
    "-an",
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-tune",
    "stillimage",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    path.join(directory, name),
  ]);
  return {
    ...(await probe(path.join(directory, name))),
    sourceKind: "image",
    name: path.basename(file),
    file: name,
    offset: 0,
  };
}
