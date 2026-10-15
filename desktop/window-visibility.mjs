// Fullscreen preview windows must not turn the entire editor into a Dock-less
// accessory app. Electron otherwise calls DockHide for visibleOnFullScreen.
export const previewWorkspaceOptions = {
  visibleOnFullScreen: true,
  skipTransformProcessType: true,
};

export function keepAppInSwitcher(app, platform = process.platform) {
  if (platform === "darwin") app.setActivationPolicy("regular");
}
