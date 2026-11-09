export type AppUpdateState = {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error"
    | "unsupported";
  currentVersion: string;
  version?: string;
  message?: string;
};
type Activity = {
  recording: boolean;
  busy: boolean;
  dirty: boolean;
  saving: boolean;
  renaming: boolean;
};
export function updateRestartBlocker(activity: Activity) {
  if (activity.recording)
    return "Stop the recording before restarting to update.";
  if (activity.busy || activity.saving)
    return "Wait for the current operation to finish before restarting to update.";
  if (activity.dirty || activity.renaming)
    return "Save your changes before restarting to update.";
  return "";
}
export function connectAppUpdates(
  button: HTMLButtonElement,
  {
    activity,
    lock,
    error,
  }: {
    activity: () => Activity;
    lock: (value: boolean) => void;
    error: (error: unknown) => void;
  },
  api = window.studio,
) {
  let state: AppUpdateState | undefined;
  let restarting = false;
  const render = (value: AppUpdateState) => {
    state = value;
    button.hidden =
      !["available", "downloading", "ready", "installing"].includes(
        state.status,
      ) && !(state.status === "error" && state.version);
    button.disabled = ["downloading", "installing"].includes(state.status);
    button.textContent =
      state.status === "ready"
        ? "Restart to update"
        : state.status === "downloading"
          ? "Downloading update…"
          : state.status === "installing"
            ? "Restarting…"
            : state.status === "error"
              ? "Retry update"
              : "Update available";
    button.title = state.version
      ? `Open Record Studio ${state.version}`
      : "App update";
  };
  const install = async () => {
    if (restarting) return;
    const reason = updateRestartBlocker(activity());
    if (reason) {
      error(new Error(reason));
      return;
    }
    restarting = true;
    lock(true);
    try {
      await api.installAppUpdate();
    } catch (cause) {
      error(cause);
    } finally {
      restarting = false;
      lock(false);
    }
  };
  api.onAppUpdate(render);
  api.onInstallAppUpdate(() => void install());
  void api
    .appUpdateState()
    .then((value) => {
      if (value && !state) render(value);
    })
    .catch(error);
  button.onclick = () => {
    if (state?.status === "ready") void install();
    else void api.checkAppUpdate().catch(error);
  };
}
