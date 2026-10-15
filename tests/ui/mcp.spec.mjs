import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { motionFixture } from "../motion-fixture.mjs";
import { connectMcp, call } from "../mcp-client.mjs";

test("MCP edits appear in the desktop, stale saves preserve both editors, and reloaded edits can be saved", async () => {
  const root = path.resolve(".cache/mcp-ui");
  await fs.rm(root, { recursive: true, force: true });
  const directory = path.join(root, "project.framestudio");
  await motionFixture(directory);
  const app = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? {
          executablePath: process.env.FRAME_EXECUTABLE,
          args: [`--project=${directory}`],
        }
      : { args: [".", `--project=${directory}`] }),
    env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
  });
  const { client } = await connectMcp();
  try {
    const page = await app.firstWindow();
    await expect(page.locator("#project-title")).toHaveText(
      "Motion validation",
    );
    await page.locator("#padding").fill("0.1");
    await expect(page.locator("#save-state")).toHaveText("Unsaved changes");
    const args = { project_path: directory };
    const before = await call(client, "get_project", args);
    const batch = await call(client, "apply_edits", {
      ...args,
      expected_revision: before.revision,
      operations: [
        { operation: "edit_zoom", zoom_id: "z1", changes: { zoom: 1.7 } },
        { operation: "split_cut", cut_index: 1, source_time: 3 },
        {
          operation: "update_style",
          changes: {
            cameraRoundness: 0.4,
            cursorSize: 1.8,
            cursorSmoothing: 0.1,
            cursorClicks: false,
            showCursor: false,
          },
        },
      ],
    });
    const p = batch.project;
    expect(batch.saved).toBe(true);
    await expect(page.locator("#reload-project")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("#save-state")).toHaveText(
      "Project updated on disk",
    );
    await page.locator("#save").click();
    await expect(page.locator("#toast")).toContainText(
      "Project changed on disk",
    );
    expect((await call(client, "get_project", args)).revision).toBe(p.revision);
    expect(await page.locator("#padding").inputValue()).toBe("0.1");
    // Cancel reload once to prove the local unsaved edits remain available.
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#reload-project").click();
    expect(await page.locator("#padding").inputValue()).toBe("0.1");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#reload-project").click();
    await expect(page.locator("#clip-count")).toHaveText("3 clips");
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    await expect(page.locator("#reload-project")).toBeHidden();
    expect(await page.locator("#padding").inputValue()).toBe("0.065");
    await page.locator("#tab-motion").click();
    await page.locator("#zoom-selector").selectOption({ index: 1 });
    await expect(page.locator("#section-zoom")).toHaveValue("1.7");
    await expect(page.locator("#cursorSize")).toHaveValue("1.8");
    await expect(page.locator("#cursorSmoothing")).toHaveValue("0.1");
    await expect(page.locator("#showCursor")).not.toBeChecked();
    await expect(page.locator("#cursorClicks")).not.toBeChecked();
    await page.locator("#tab-camera").click();
    await expect(page.locator("#cameraRoundness")).toHaveValue("0.4");
    await expect(page.locator("#cameraRoundness-value")).toHaveText("40%");
    await page.locator("#tab-appearance").click();
    await page.locator("#padding").fill("0.08");
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    const saved = await call(client, "get_project", args);
    expect(saved.style.padding).toBe(0.08);
    expect(saved.zooms[0].zoom).toBe(1.7);
    expect(saved.style.cameraRoundness).toBe(0.4);
    expect(saved.style.cursorSize).toBe(1.8);
    expect(saved.style.showCursor).toBe(false);
    expect(saved.cuts).toHaveLength(3);
    const conflict = await client.callTool({
      name: "remove_zoom",
      arguments: { ...args, expected_revision: p.revision, zoom_id: "z1" },
    });
    expect(conflict.isError).toBe(true);
    await fs.mkdir("evidence/mcp", { recursive: true });
    await page.screenshot({ path: "evidence/mcp/desktop-edits.png" });
  } finally {
    await client.close();
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app.close().catch(() => {});
  }
});
