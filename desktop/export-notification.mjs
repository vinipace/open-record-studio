export function createExportNotifier({ Notification, openPath }) {
  const active = new Set();
  return (projectName, result) => {
    if (!Notification.isSupported()) return;
    try {
      const count = result.files.length;
      const notification = new Notification({
        title: "Export complete",
        body: `${projectName} · ${count} ${count === 1 ? "file" : "files"} ready. Click to open the folder.`,
        silent: false,
      });
      // Retain the notification so its click handler remains available.
      active.add(notification);
      while (active.size > 20) active.delete(active.values().next().value);
      notification.on("click", () => {
        void openPath(result.directory);
      });
      notification.on("close", () => active.delete(notification));
      notification.on("failed", (_event, error) => {
        active.delete(notification);
        console.warn("Export notification unavailable:", error);
      });
      notification.show();
    } catch (error) {
      // Notification permissions must never turn a completed export into an error.
      console.warn("Export notification unavailable:", error.message);
    }
  };
}
