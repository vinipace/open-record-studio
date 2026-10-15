import type { Progress } from "./types";

function duration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  return `${Math.floor(rounded / 3600)}h ${Math.ceil((rounded % 3600) / 60)}m`;
}

export function exportProgressText(progress: Progress) {
  const { track, ratio, elapsedSeconds, remainingSeconds } = progress;
  const label =
    track === "done"
      ? "Export complete"
      : track === "cursor"
        ? "Preparing cursor"
        : track === "finishing"
          ? "Finishing export"
          : track === "Enhance Audio"
            ? "Enhancing audio"
            : `Rendering ${track === "camera" ? "webcam" : track}`;
  const estimate =
    remainingSeconds === null || remainingSeconds === undefined
      ? "Estimating time…"
      : remainingSeconds < 5
        ? "Almost done"
        : `About ${duration(Math.ceil(remainingSeconds / 5) * 5)} left`;
  return {
    label: `${label}${track === "done" ? "" : ` · ${Math.floor(ratio * 100)}%`}`,
    time:
      track === "done"
        ? `Completed in ${duration(elapsedSeconds)}`
        : `${estimate} · ${duration(elapsedSeconds)} elapsed`,
  };
}
