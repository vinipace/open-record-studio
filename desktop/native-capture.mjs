import { spawn } from "node:child_process";
// Own the helper lifetime and await file finalization, not merely process launch.
export function startCapture(
  executable,
  { source, output, audio = false, excludeApplicationPIDs = [] },
  spawnProcess = spawn,
) {
  if (!excludeApplicationPIDs.every((pid) => Number.isInteger(pid) && pid > 0))
    throw new Error("Invalid capture exclusion process ID");
  const child = spawnProcess(
    executable,
    [
      "--source",
      source,
      "--output",
      output,
      ...(audio ? ["--audio"] : []),
      ...(excludeApplicationPIDs.length
        ? ["--exclude-apps", excludeApplicationPIDs.join(",")]
        : []),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "",
    stderr = "",
    started = false,
    finished = false,
    exited = false,
    startResolve,
    startReject,
    endResolve,
    endReject;
  const ready = new Promise((resolve, reject) => {
    startResolve = resolve;
    startReject = reject;
  });
  const done = new Promise((resolve, reject) => {
    endResolve = resolve;
    endReject = reject;
  });
  // done can reject while the renderer is recording, before it calls stop().
  done.catch(() => {});
  const timeout = setTimeout(() => {
    reject(
      new Error(
        "Screen capture did not start. Check Screen Recording permission and unlock the Mac.",
      ),
    );
    child.kill();
  }, 20000);
  const reject = (error) => {
    clearTimeout(timeout);
    startReject(error);
    endReject(error);
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.event === "started" && Number.isFinite(event.startedAt)) {
        started = true;
        clearTimeout(timeout);
        startResolve(event);
      }
      if (event.event === "finished") {
        finished = true;
      }
      if (event.event === "error")
        reject(new Error(event.message || "Screen capture failed"));
    }
  });
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  // A failed/exited helper can close its pipe before the UI aborts. Completion
  // is determined by the process protocol, not by an unhandled EPIPE event.
  child.stdin.on("error", () => {});
  const requestStop = () => {
    if (!exited && !child.stdin.destroyed && !child.stdin.writableEnded)
      child.stdin.end("stop\n");
  };
  child.on("error", reject);
  child.on("exit", () => (exited = true));
  child.on("close", (code) => {
    if (code === 0 && started && finished) endResolve();
    else
      reject(
        new Error(`Screen capture stopped unexpectedly (${code}). ${stderr}`),
      );
  });
  let stopping;
  return {
    ready,
    done,
    stop() {
      if (!stopping)
        stopping = (async () => {
          requestStop();
          const deadline = setTimeout(() => child.kill(), 15000);
          try {
            await done;
          } finally {
            clearTimeout(deadline);
          }
        })();
      return stopping;
    },
    abort() {
      requestStop();
      if (!exited) child.kill();
    },
  };
}
