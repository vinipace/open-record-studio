import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { motionFixture } from "../motion-fixture.mjs";
import { connectMcp, call } from "../mcp-client.mjs";
import { readProject, probe, run, binary } from "../../desktop/media.mjs";

test("recording activity creates editable eased zooms and preserves MCP timestamps through save, cuts, preview and render", async () => {
  test.setTimeout(90000);
  const root = path.resolve(".cache/interactions-ui"),
    evidence = path.resolve("evidence/interactions");
  await fs.rm(root, { recursive: true, force: true });
  const fixture = await motionFixture(path.join(root, "fixture.framestudio"));
  fixture.cursor.samples = fixture.cursor.samples.map((s) => ({
    ...s,
    pressed: s.t >= 0.4 && s.t < 0.5,
  }));
  fixture.interactions = {
    version: 1,
    capabilities: {
      click: true,
      typing: true,
      selection: true,
      scroll: true,
      drag: true,
    },
    permissions: { accessibility: true, inputMonitoring: true },
    events: [
      {
        id: "click-1",
        type: "click",
        t: 0.4,
        end: 0.4,
        x: 0.3,
        y: 0.3,
        button: "left",
      },
      {
        id: "typing-1",
        type: "typing",
        t: 0.8,
        end: 1.6,
        x: 0.32,
        y: 0.3,
        count: 8,
        position: "caret",
        rect: { x: 0.3, y: 0.28, width: 0.08, height: 0.04 },
      },
      {
        id: "selection-1",
        type: "selection",
        t: 2.5,
        end: 2.8,
        x: 0.75,
        y: 0.7,
        position: "selection",
        rect: { x: 0.65, y: 0.65, width: 0.2, height: 0.1 },
      },
      { id: "scroll-1", type: "scroll", t: 3.1, end: 3.2, x: 0.7, y: 0.7 },
      { id: "drag-1", type: "drag", t: 3.3, end: 3.6, x: 0.6, y: 0.6 },
    ],
  };
  await fs.writeFile(
    path.join(fixture.directory, "project.json"),
    JSON.stringify(fixture),
  );
  const folder = path.join(root, "Projects"),
    directory = path.join(folder, "Recording 1.framestudio");
  await fs.mkdir(folder);
  await fs.mkdir(evidence, { recursive: true });
  let app, page, mcp;
  const launch = async (reopen = false) => {
    const args = reopen ? [`--project=${directory}`] : [];
    app = await electron.launch({
      ...(process.env.FRAME_EXECUTABLE
        ? { executablePath: process.env.FRAME_EXECUTABLE, args }
        : { args: [".", ...args] }),
      env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
    });
    page = await app.firstWindow();
    await expect(page.locator("#project-title")).toBeVisible();
  };
  const close = async () => {
    await app
      ?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      )
      .catch(() => {});
    await app?.close().catch(() => {});
  };
  try {
    await launch();
    await app.evaluate(
      ({ dialog, desktopCapturer, nativeImage }, config) => {
        const child = process.getBuiltinModule("child_process"),
          original = child.spawn;
        child.spawn = (command, args, options) =>
          String(command).endsWith("/frame-capture") &&
          args.includes("--source")
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
            name: "Generated interaction capture",
            display_id: "1",
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
    await expect(page.locator("#interaction-access-status")).toBeVisible();
    await page.locator("#start-record").click();
    await expect(page.locator("#recording-banner")).toBeVisible();
    await page.locator("#stop-record").click();
    await expect(page.locator("#recording-banner")).toBeHidden({
      timeout: 20000,
    });
    await expect(page.locator("#project-title")).toHaveText("Recording 1");
    const recorded = await readProject(directory);
    expect(recorded.interactions.events).toHaveLength(5);
    expect(recorded.edits.zooms).toHaveLength(2);
    expect(
      recorded.edits.zooms.every((z) => z.mode === "fixed" && z.ease === 0.6),
    ).toBe(true);
    expect(recorded.edits.zooms[0].end).toBeLessThanOrEqual(
      recorded.edits.zooms[1].start,
    );
    await page.locator("#tab-motion").click();
    await expect(page.locator("#interaction-summary")).toHaveCount(0);
    await page.locator("#zoom-selector").selectOption({ index: 1 });
    await page.locator("#section-zoom").fill("1.7");
    await page.locator("#section-zoom").dispatchEvent("change");
    await page.locator("#remove-zoom").click();
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(1);
    await page.locator("#undo").click();
    await expect(
      page.locator("#zoom-selector option:not([disabled])"),
    ).toHaveCount(2);
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    await close();
    await launch(true);
    await page.locator("#tab-motion").click();
    await page.locator("#zoom-selector").selectOption({ index: 1 });
    await expect(page.locator("#section-zoom")).toHaveValue("1.7");
    expect((await readProject(directory)).interactions).toEqual(
      recorded.interactions,
    );
    await page.screenshot({ path: path.join(evidence, "automatic-zooms.png") });
    mcp = await connectMcp();
    const args = { project_path: directory };
    const saved = await call(mcp.client, "get_project", args);
    expect(saved.interactions.total).toBe(5);
    // Use the real MCP operations to remove the first second and change speed.
    await call(mcp.client, "apply_edits", {
      ...args,
      expected_revision: saved.revision,
      operations: [
        { operation: "edit_cut", cut_index: 0, start: 1, end: 4 },
        { operation: "update_style", changes: { speed: 2 } },
      ],
    });
    const activity = await call(mcp.client, "get_interactions", {
      ...args,
      timebase: "output",
    });
    expect(activity.matched).toBe(4);
    const typing = activity.events.find((e) => e.type === "typing");
    expect(typing.output_times).toEqual([]);
    expect(typing.output_ranges[0].start).toBe(0);
    expect(typing.output_ranges[0].end).toBeCloseTo(0.3, 6);
    expect(
      activity.events.find((e) => e.type === "selection").output_times[0].t,
    ).toBe(0.75);
    const preview = await mcp.client.callTool({
      name: "get_preview",
      arguments: { ...args, time: 0.8, height: 360 },
    });
    expect(preview.isError).not.toBe(true);
    const edited = await readProject(directory);
    const job = await call(mcp.client, "render", {
      ...args,
      expected_revision: edited.revision,
      output_directory: path.join(root, "render"),
      height: 720,
      fps: 30,
      audio: false,
    });
    let rendered;
    await expect
      .poll(
        async () => {
          rendered = await call(mcp.client, "render_status", {
            job_id: job.job_id,
          });
          return rendered.status;
        },
        { timeout: 30000 },
      )
      .toBe("succeeded");
    const file = rendered.files[0];
    expect((await probe(file)).duration).toBeCloseTo(1.5, 1);
    await run(await binary("ffmpeg"), [
      "-v",
      "error",
      "-xerror",
      "-i",
      file,
      "-f",
      "null",
      "-",
    ]);
    await fs.writeFile(
      path.join(evidence, "checks.json"),
      JSON.stringify(
        {
          passed: true,
          fixtureCapture: true,
          nativeEventsVerified: false,
          events: recorded.interactions.events.length,
          generatedZooms: recorded.edits.zooms.length,
          editableAndColdReopened: true,
          mcpOutputTimeMapping: true,
          decodedRenderDuration: 1.5,
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
    await close();
  }
});
