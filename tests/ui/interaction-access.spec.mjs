import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { motionFixture } from "../motion-fixture.mjs";
import { readProject } from "../../desktop/media.mjs";
import { connectMcp, call } from "../mcp-client.mjs";

test("text-tracking access is mandatory and silent native clicks still produce zooms from cursor edges", async () => {
  const root = path.resolve(".cache/interaction-access-ui");
  await fs.rm(root, { recursive: true, force: true });
  const fixture = await motionFixture(path.join(root, "fixture.framestudio"));
  fixture.interactions = {
    version: 1,
    permissions: { accessibility: false, inputMonitoring: false },
    capabilities: {
      click: true,
      typing: true,
      selection: true,
      scroll: true,
      drag: true,
    },
    events: [],
  };
  const file = path.join(fixture.directory, "project.json");
  await fs.writeFile(file, JSON.stringify(fixture));
  const folder = path.join(root, "Projects");
  await fs.mkdir(folder);
  let app, mcp;
  try {
    app = await electron.launch({
      ...(process.env.FRAME_EXECUTABLE
        ? { executablePath: process.env.FRAME_EXECUTABLE, args: [] }
        : { args: ["."] }),
      env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
    });
    const page = await app.firstWindow();
    await expect(page.locator("#project-title")).toBeVisible();
    await app.evaluate(
      ({ dialog, desktopCapturer, nativeImage }, config) => {
        const child = process.getBuiltinModule("child_process"),
          original = child.spawn;
        child.spawn = (command, args, options) =>
          String(command).endsWith("/frame-capture") &&
          (args.includes("--source") || args.includes("--interaction-access"))
            ? original(
                config.node,
                [config.script, ...args, "--fixture", config.fixture],
                options,
              )
            : original(command, args, options);
        process.getBuiltinModule("module").syncBuiltinESMExports();
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [config.folder],
        });
        desktopCapturer.getSources = async () => [
          {
            id: "screen:0:0",
            display_id: "1",
            name: "Generated recording",
            thumbnail: nativeImage.createEmpty(),
          },
        ];
      },
      {
        node: process.execPath,
        script: path.resolve("tests/fixtures/capture-process.mjs"),
        fixture: fixture.directory,
        folder,
      },
    );
    await page.evaluate(() => {
      navigator.mediaDevices.enumerateDevices = async () => [];
    });
    await page.locator("#new-recording").click();
    await expect(page.locator("#interaction-access-status")).toContainText(
      "Text tracking needs access",
    );
    await expect(page.locator("#start-record")).toBeDisabled();
    await expect(page.locator("#interaction-enable")).toBeVisible();
    // The main-process guard also prevents bypassing the disabled button.
    const blocked = await page.evaluate(async () => {
      try {
        await window.studio.begin();
        return "unexpected success";
      } catch (e) {
        return String(e);
      }
    });
    expect(blocked).toContain("Accessibility and Input Monitoring");
    expect(await fs.readdir(folder)).toHaveLength(0);
    // Simulate returning from macOS after granting both permissions.
    fixture.interactions.permissions = {
      accessibility: true,
      inputMonitoring: true,
    };
    await fs.writeFile(file, JSON.stringify(fixture));
    await page.locator("#record-dialog .close-dialog").click();
    await page.locator("#new-recording").click();
    await expect(page.locator("#start-record")).toBeEnabled();
    await expect(page.locator("#interaction-enable")).toBeHidden();
    // Revocation between dialog and Start is checked again, before allocation.
    fixture.interactions.permissions.inputMonitoring = false;
    await fs.writeFile(file, JSON.stringify(fixture));
    await page.locator("#start-record").click();
    await expect(page.locator("#interaction-access-status")).toContainText(
      "Text tracking needs access",
    );
    await expect(page.locator("#start-record")).toBeDisabled();
    expect(await fs.readdir(folder)).toHaveLength(0);
    fixture.interactions.permissions.inputMonitoring = true;
    await fs.writeFile(file, JSON.stringify(fixture));
    await page.locator("#record-dialog .close-dialog").click();
    await page.locator("#new-recording").click();
    await expect(page.locator("#start-record")).toBeEnabled();
    // Permissions alone are insufficient if the actual capture listener fails.
    fixture.interactions.capabilities.typing = false;
    await fs.writeFile(file, JSON.stringify(fixture));
    await page.locator("#start-record").click();
    await expect(page.locator("#toast")).toContainText(
      "Text tracking could not start",
    );
    await expect(page.locator("#recording-banner")).toBeHidden();
    await expect(page.locator("#start-record")).toBeEnabled();
    expect(
      await fs.stat(path.join(folder, "Recording 1.framestudio/recovery.json")),
    ).toBeTruthy();
    await page.locator(".record-advanced summary").click();
    await page.locator('[data-auto-zoom="click"]').check();
    fixture.interactions.capabilities.typing = true;
    await fs.writeFile(file, JSON.stringify(fixture));
    await page.locator("#start-record").click();
    await expect(page.locator("#recording-banner")).toBeVisible();
    await page.locator("#stop-record").click();
    await expect(page.locator("#project-title")).toHaveText("Recording 2");
    await expect(page.locator("#toast")).toContainText("1 automatic zoom");
    await page.locator("#tab-motion").click();
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(1);
    await expect(page.locator("#interaction-summary")).toHaveCount(0);
    await expect(page.locator("#interaction-coverage")).toHaveCount(0);
    const p = await readProject(path.join(folder, "Recording 2.framestudio"));
    expect(p.interactions.events).toHaveLength(1);
    expect(p.interactions.events[0].origin).toBe("cursor");
    expect(p.edits.zooms[0].mode).toBe("follow");
    mcp = await connectMcp();
    const result = await call(mcp.client, "get_interactions", {
      project_path: p.directory,
    });
    expect(result.events[0].origin).toBe("cursor");
    expect(result.events[0].t).toBe(2);
    await fs.mkdir("evidence/interactions", { recursive: true });
    await fs.writeFile(
      "evidence/interactions/access-checks.json",
      JSON.stringify(
        {
          mandatoryAccess: true,
          backendGuard: true,
          revocationBeforeStart: true,
          actualListenerChecked: true,
          silentTapRecovered: true,
          mcpCursorOrigin: true,
          asarSha256: createHash("sha256")
            .update(
              await fs.readFile(
                "release/Open Record Studio.app/Contents/Resources/app.asar",
              ),
            )
            .digest("hex"),
        },
        null,
        2,
      ),
    );
  } finally {
    await mcp?.client.close();
    await app
      ?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app?.close().catch(() => {});
  }
});
