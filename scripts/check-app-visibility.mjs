// Focused native-window regression; no editor project, capture, or E2E suite.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  keepAppInSwitcher,
  previewWorkspaceOptions,
} from "../desktop/window-visibility.mjs";

app.setName("Open Record Studio visibility check");
app.setPath("userData", path.resolve(".cache/visibility-check-profile"));
app.whenReady().then(async () => {
  let preview;
  try {
    keepAppInSwitcher(app);
    assert.equal(app.dock.isVisible(), true);
    preview = new BrowserWindow({
      show: false,
      frame: false,
      width: 160,
      height: 160,
    });
    preview.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const oldPreviewHidApp = !app.dock.isVisible();
    assert.equal(
      oldPreviewHidApp,
      true,
      "reproduce the old app-wide Dock hiding",
    );
    keepAppInSwitcher(app);
    assert.equal(app.dock.isVisible(), true, "recover accessory app state");
    preview.setVisibleOnAllWorkspaces(true, previewWorkspaceOptions);
    assert.equal(
      app.dock.isVisible(),
      true,
      "fullscreen preview preserves the app switcher",
    );
    assert.equal(preview.isVisibleOnAllWorkspaces(), true);
    preview.showInactive();
    assert.equal(
      app.dock.isVisible(),
      true,
      "showing the preview preserves the Dock",
    );
    preview.hide();
    assert.equal(
      app.dock.isVisible(),
      true,
      "hiding the preview preserves the Dock",
    );
    preview.destroy();
    assert.equal(
      app.dock.isVisible(),
      true,
      "closing the preview preserves the Dock",
    );
    await fs.mkdir("evidence/window-visibility", { recursive: true });
    const report = {
      date: new Date().toISOString(),
      oldPreviewHidApp,
      fixedPreviewKeepsDockVisible: true,
      allWorkspaces: true,
      showHideClosePassed: true,
    };
    await fs.writeFile(
      "evidence/window-visibility/native.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (preview && !preview.isDestroyed()) preview.destroy();
    app.quit();
  }
});
