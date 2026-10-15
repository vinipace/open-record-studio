import { expect } from "@playwright/test";

export async function openRecordingDialog(page) {
  await page.locator("#new-recording").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#record-dialog").open ||
      document.querySelector("#record-menu").matches(":popover-open"),
  );
  if (await page.locator("#record-new-screen").isVisible())
    await page.locator("#record-new-screen").click();
  await expect(page.locator("#record-dialog")).toBeVisible();
}

// Observe the actual Web Audio gains, including both prebuffered decoder slots.
// The app deliberately leaves element.volume=1 and element.muted=false to avoid
// restarting the macOS audio sink at every edit or cut.
export async function observeAudioMixer(page) {
  await page.addInitScript(() => {
    window.audioMixers = [];
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...args) {
      if (
        this instanceof MediaElementAudioSourceNode &&
        target instanceof GainNode
      )
        window.audioMixers.push({
          element: this.mediaElement,
          gain: target.gain,
          context: target.context,
        });
      return connect.call(this, target, ...args);
    };
    window.audioVolumes = () => {
      const volumes = {};
      for (const { element, gain } of window.audioMixers) {
        if (!element.src) continue;
        const key = new URL(element.src).pathname.split("/").pop();
        volumes[key] = Math.max(volumes[key] || 0, gain.value);
      }
      return volumes;
    };
  });
  await page.reload();
  await expect(page.locator("#save-state")).toHaveText("All changes saved");
}
