export type Filmstrip = { time: number; image: string }[];

// Use a separate decoder so timeline thumbnails never seek the playing video.
export async function loadFilmstrip(
  url: string,
  duration: number,
  signal: AbortSignal,
): Promise<Filmstrip> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  const wait = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener(event, ready);
        video.removeEventListener("error", failed);
        signal.removeEventListener("abort", failed);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("Thumbnail unavailable"));
      };
      const timeout = setTimeout(failed, 6000);
      video.addEventListener(event, ready, { once: true });
      video.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", failed, { once: true });
      if (signal.aborted) failed();
    });
  const canvas = document.createElement("canvas");
  canvas.width = 144;
  canvas.height = 81;
  const ctx = canvas.getContext("2d")!;
  try {
    const ready = wait("loadeddata");
    video.src = url;
    await ready;
    const frames: Filmstrip = [];
    for (let i = 0; i < 16; i++) {
      if (signal.aborted) break;
      const time = Math.min(
        Math.max(0, duration - 0.04),
        (duration * i) / 16 + 0.01,
      );
      const seeked = wait("seeked");
      video.currentTime = time;
      await seeked;
      const scale = Math.max(144 / video.videoWidth, 81 / video.videoHeight);
      ctx.drawImage(
        video,
        (144 - video.videoWidth * scale) / 2,
        (81 - video.videoHeight * scale) / 2,
        video.videoWidth * scale,
        video.videoHeight * scale,
      );
      frames.push({ time, image: canvas.toDataURL("image/jpeg", 0.7) });
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export function frameAt(frames: Filmstrip | undefined, time: number) {
  if (!frames?.length) return "";
  return frames.reduce((a, b) =>
    Math.abs(a.time - time) < Math.abs(b.time - time) ? a : b,
  ).image;
}
