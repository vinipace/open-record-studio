// Weight stages by the work they perform so a quick webcam pass does not
// receive the same share of the estimate as a large screen with motion.
export function createExportProgress(stages, now = () => performance.now()) {
  const started = now();
  const total = stages.reduce((sum, stage) => sum + stage.work, 0);
  let index = 0,
    fraction = 0,
    completed = 0,
    lastAdvance = started,
    stageStarted = started;
  let done = false;
  const snapshot = () => {
    const elapsedSeconds = Math.max(0, (now() - started) / 1000);
    const work = completed + (stages[index]?.work || 0) * fraction;
    const ratio = done ? 1 : Math.min(0.995, work / total);
    const stageElapsed = Math.max(0, (now() - stageStarted) / 1000);
    const stageWork = (stages[index]?.work || 0) * fraction;
    const remainingSeconds = done
      ? 0
      : stageElapsed >= 2 && stageWork > 0 && now() - lastAdvance < 15000
        ? Math.max(1, (stageElapsed * (total - work)) / stageWork)
        : null;
    return {
      ratio,
      track: done ? "done" : stages[index].track,
      elapsedSeconds,
      remainingSeconds,
    };
  };
  return {
    snapshot,
    update(value) {
      const next = Math.max(
        fraction,
        Math.min(1, Number.isFinite(value) ? value : 0),
      );
      if (next > fraction) lastAdvance = now();
      fraction = next;
      return snapshot();
    },
    advance() {
      completed += stages[index].work;
      fraction = 0;
      index++;
      if (index === stages.length) done = true;
      lastAdvance = now();
      stageStarted = now();
      return snapshot();
    },
  };
}
