import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { layersFixture } from "../layers-fixture.mjs";
import { saveProject } from "../../desktop/media.mjs";

test("advanced audio model selection supports undo, persistence, cached preview and cancellation", async () => {
  test.setTimeout(180000);
  const root = path.resolve(".cache/audio-models-ui");
  await fs.rm(root, { recursive: true, force: true });
  const { project, directory } = await layersFixture(root);
  project.tracks.microphone = { ...project.tracks.screen };
  await saveProject(project);
  const app = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? {
          executablePath: process.env.FRAME_EXECUTABLE,
          args: [`--project=${directory}`],
        }
      : { args: [".", `--project=${directory}`] }),
    env: {
      ...process.env,
      FRAME_DATA_DIR: path.join(root, "profile"),
      FRAME_AUDIO_CACHE: path.join(root, "audio-cache"),
    },
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator("#project-title")).toHaveText("Layers");
    await page.locator("#tab-audio").click();
    const model = page.locator("#audioEnhancementModel");
    await expect(model).toBeHidden();
    await page.locator("#audio-advanced summary").click();
    await expect(model).toHaveValue("deepfilternet3");
    await expect(model.locator("option")).toHaveText([
      "RNNoise",
      "DeepFilterNet3",
      "MossFormer2",
    ]);
    await model.selectOption("rnnoise");
    await expect(page.locator("#audio-model-description")).toContainText(
      "Included with the app",
    );
    await expect(page.locator("#enhanceAudio")).not.toBeChecked();
    await page.locator("#undo").click();
    await expect(model).toHaveValue("deepfilternet3");
    await page.locator("#redo").click();
    await expect(model).toHaveValue("rnnoise");
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    const saved = JSON.parse(
      await fs.readFile(path.join(directory, "project.json")),
    );
    expect(saved.edits.style.audioEnhancementModel).toBe("rnnoise");
    await page.reload();
    await page.locator("#tab-audio").click();
    await page.locator("#audio-advanced summary").click();
    await expect(model).toHaveValue("rnnoise");
    await page.locator("#enhanceAudio").check();
    await expect(page.locator("#play")).toBeEnabled({ timeout: 30000 });
    await expect(page.locator("#enhance-audio-status")).toBeHidden();

    if (process.env.FRAME_TEST_AUDIO_MODELS) {
      // No save between selection and preparation: preview must use the UI value.
      for (const id of ["deepfilternet3", "mossformer2", "rnnoise"]) {
        await model.selectOption(id);
        await expect(page.locator("#play")).toBeEnabled({ timeout: 60000 });
        await expect(page.locator("#enhance-audio-status")).toBeHidden();
      }
      // Switch away while model loading is pending; stale cancellations/results
      // must not disable the selected cached RNNoise result.
      await page.locator("#enhanceAudio").uncheck();
      await model.selectOption("mossformer2");
      await page.locator("#enhanceAudio").check();
      await model.selectOption("rnnoise");
      await expect(page.locator("#play")).toBeEnabled({ timeout: 30000 });
    }
    await fs.mkdir("evidence/audio-models", { recursive: true });
    await page
      .locator(".inspector")
      .screenshot({ path: "evidence/audio-models/advanced.png" });
    await page.locator("#enhanceAudio").uncheck();
    await expect(page.locator("#play")).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
      )
      .catch(() => {});
    await app.close();
  }
});
