import fs from "node:fs/promises";
import path from "node:path";
import { defaults, binary, run, probe } from "../desktop/media.mjs";
export const edits = {
  segments: [
    { start: 0, end: 1.5 },
    { start: 2, end: 4 },
  ],
  style: { ...defaults, speed: 1.5 },
  zooms: [
    {
      id: "z1",
      start: 0.5,
      end: 3.5,
      zoom: 2.4,
      focusX: 0.3,
      focusY: 0.6,
      ease: 0.6,
    },
  ],
};
export const samples = Array.from({ length: 481 }, (_, i) => ({
  t: i / 120,
  x: 0.43 + 0.055 * Math.sin((i / 120) * 3) + (i % 2 ? 0.004 : -0.004),
  y: 0.4,
  visible: true,
  pressed: i >= 240 && i < 252,
}));
export const cursor = { clean: true, samples };
export async function motionFixture(root, { height = 360 } = {}) {
  await fs.mkdir(root, { recursive: true });
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `nullsrc=s=640x${height}:r=60:d=4,format=gbrp,geq=r='X/W*255':g='Y/H*255':b='48+T*30'`,
    "-c:v",
    "libx264",
    "-crf",
    "12",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "screen.mp4"),
  ]);
  const meta = await probe(path.join(root, "screen.mp4"));
  const project = {
    version: 1,
    kind: "frame-studio",
    name: "Motion validation",
    directory: root,
    duration: 4,
    tracks: {
      screen: { ...meta, file: "screen.mp4", offset: 0 },
      camera: { ...meta, file: "screen.mp4", offset: 0 },
    },
    edits: structuredClone(edits),
    cursor: structuredClone(cursor),
  };
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify(project));
  return project;
}
