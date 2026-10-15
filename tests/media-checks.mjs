import { spawn } from "node:child_process";
import { binary } from "../desktop/media.mjs";

// Inspect decoded samples, so a silent/empty AAC stream cannot pass as audio.
export async function audioEnergy(file, start = 0.5) {
  const command = await binary("ffmpeg");
  const bytes = await new Promise((resolve, reject) => {
    const child = spawn(command, [
      "-v",
      "error",
      "-ss",
      String(start),
      "-i",
      file,
      "-t",
      "0.25",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ]);
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("Audio decode failed")),
    );
  });
  if (bytes.length < 400) throw new Error("Too few decoded audio samples");
  let squares = 0;
  for (let i = 0; i + 4 <= bytes.length; i += 4)
    squares += bytes.readFloatLE(i) ** 2;
  return Math.sqrt(squares / (bytes.length / 4));
}
