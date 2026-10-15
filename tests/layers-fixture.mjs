import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  binary,
  run,
  probe,
  defaults,
  saveProject,
} from "../desktop/media.mjs";
// Deterministic transparent PNG, including alpha that MP4 intermediates cannot preserve.
function crc32(b) {
  let c = -1;
  for (const v of b) {
    c ^= v;
    for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ -1) >>> 0;
}
function chunk(type, b) {
  const typeBytes = Buffer.from(type),
    size = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  size.writeUInt32BE(b.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, b])));
  return Buffer.concat([size, typeBytes, b, crc]);
}
export async function layersFixture(root) {
  await fs.mkdir(root, { recursive: true });
  const ffmpeg = await binary("ffmpeg");
  const image = path.join(root, "Logo transparent.png"),
    video = path.join(root, "Blue video.mp4");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(160, 0);
  header.writeUInt32BE(80, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(80 * (160 * 4 + 1));
  for (let y = 0; y < 80; y++)
    for (let x = 40; x < 120; x++) {
      const o = y * 641 + 1 + x * 4;
      pixels[o] = 255;
      pixels[o + 3] = 255;
    }
  await fs.writeFile(
    image,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
  const directory = path.join(root, "Layers.framestudio");
  await fs.mkdir(directory, { recursive: true });
  for (const [file, color, duration, size] of [
    [path.join(directory, "screen.mp4"), "lime", 4, "640x360"],
    [video, "blue", 2, "160x120"],
  ]) {
    await run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=${color}:s=${size}:r=60:d=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${duration}:sample_rate=44100`,
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      file,
    ]);
  }
  const screen = {
    ...(await probe(path.join(directory, "screen.mp4"))),
    file: "screen.mp4",
    offset: 0,
  };
  const project = {
    kind: "frame-studio",
    version: 1,
    name: "Layers",
    duration: 4,
    directory,
    tracks: { screen, camera: { ...screen } },
    edits: {
      segments: [{ start: 0, end: 4 }],
      style: { ...defaults, padding: 0, showCamera: false, showCursor: false },
    },
  };
  await saveProject(project);
  return { project, directory, image, video };
}
