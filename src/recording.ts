// A stream permission grant does not mean its recorder is ready. Waiting for
// start before launching the screen capture prevents an initial webcam gap.
export function startRecorder(
  recorder: MediaRecorder,
): Promise<{ startedAt: number }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      recorder.removeEventListener("start", started);
      recorder.removeEventListener("error", failed);
      recorder.removeEventListener("stop", failed);
    };
    const started = () => {
      const startedAt = Date.now();
      cleanup();
      resolve({ startedAt });
    };
    const failed = () => {
      cleanup();
      reject(
        new Error(
          "A recording input could not start. Check the selected camera and microphone.",
        ),
      );
    };
    const timeout = setTimeout(failed, 15000);
    recorder.addEventListener("start", started, { once: true });
    recorder.addEventListener("error", failed, { once: true });
    recorder.addEventListener("stop", failed, { once: true });
    try {
      recorder.start(1000);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
