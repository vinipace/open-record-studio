import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { motionFixture } from "../motion-fixture.mjs";

test("choose a projects folder once, auto-name imports and recordings, rename inline without losing edits, and remember after restart", async () => {
  const root = path.resolve(".cache/projects-ui");
  await fs.rm(root, { recursive: true, force: true });
  const folder = path.join(root, "Projects"),
    secondFolder = path.join(root, "Another folder");
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(secondFolder);
  const fixture = await motionFixture(path.join(root, "fixture.framestudio"));
  const input = path.join(root, "Demo source.mp4");
  await fs.copyFile(path.join(fixture.directory, "screen.mp4"), input);
  let app, page;
  const errors = [];
  const launch = async (directory) => {
    const args = directory ? [`--project=${directory}`] : [];
    app = await electron.launch({
      ...(process.env.FRAME_EXECUTABLE
        ? { executablePath: process.env.FRAME_EXECUTABLE, args }
        : { args: [".", ...args] }),
      env: { ...process.env, FRAME_DATA_DIR: path.join(root, "profile") },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
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
  const dialogs = async (choices) =>
    app.evaluate(({ dialog }, choices) => {
      globalThis.__choices = choices;
      dialog.showSaveDialog = async () => {
        throw new Error("Project creation must never ask for a filename");
      };
      dialog.showOpenDialog = async (_window, options) => {
        const next = globalThis.__choices.shift();
        if (!next) throw new Error("Unexpected dialog: " + options.title);
        if (next.title && !options.title.includes(next.title))
          throw new Error("Unexpected title: " + options.title);
        return {
          canceled: Boolean(next.cancel),
          filePaths: next.path ? [next.path] : [],
        };
      };
    }, choices);
  const importMedia = async (name) => {
    await page.locator("#import").click();
    await expect(page.locator("#project-title")).toHaveText(name);
    expect(await app.evaluate(() => globalThis.__choices.length)).toBe(0);
  };
  const rename = async (name) => {
    await page.locator("#project-title").dblclick();
    await expect(
      page.getByRole("textbox", { name: "Project name", exact: true }),
    ).toBeFocused();
    await page.locator("#project-name").fill(name);
    await page.locator("#project-name").press("Enter");
    await expect(page.locator("#project-name")).toBeHidden();
  };
  try {
    await launch();
    await expect(page.locator(".local-tag")).toHaveCount(0);
    await dialogs([{ title: "all your projects", cancel: true }]);
    await page.locator("#projects-folder").click();
    await page.locator("#choose-projects-folder").click();
    await expect(page.locator("#projects-path")).toHaveText(
      "No folder selected yet",
    );
    expect(
      await page.evaluate(() => window.studio.projectsFolder()),
    ).toBeNull();
    await page.locator("#projects-dialog .close-dialog").click();
    await dialogs([
      { title: "video or image", path: input },
      { title: "all your projects", path: folder },
    ]);
    await importMedia("Demo source");
    const directory = path.join(folder, "Demo source.framestudio"),
      json = path.join(directory, "project.json");
    await page.locator("#tab-appearance").click();
    await page.locator("#padding").fill("0.08");
    await rename("Launch demo");
    await expect(page.locator("#project-title")).toHaveText("Launch demo •");
    let saved = JSON.parse(await fs.readFile(json));
    expect(saved.name).toBe("Launch demo");
    expect(saved.edits.style.padding).not.toBe(0.08);
    await page.locator("#save").click();
    await expect(page.locator("#save-state")).toHaveText("All changes saved");
    saved = JSON.parse(await fs.readFile(json));
    expect(saved.edits.style.padding).toBe(0.08);
    await page.locator("#project-title").dblclick();
    await page.locator("#project-name").fill("");
    await page.locator("#project-name").press("Enter");
    await expect(page.locator("#project-name")).toBeVisible();
    await page.locator("#project-name").press("Escape");
    await expect(page.locator("#project-title")).toHaveText("Launch demo");
    await page.locator("#project-title").dblclick();
    await page.locator("#project-name").fill("Final demo");
    await page.locator("#tab-appearance").click();
    await expect(page.locator("#project-title")).toHaveText("Final demo");
    await expect(page.locator("#project-name")).toBeHidden();
    const before = await fs.readFile(json);
    // A stale title change must not overwrite another editor's project revision.
    const stale = await page.evaluate(async () => {
      const p = (await window.studio.status()).project;
      try {
        await window.studio.renameProject(p.id, "Wrong", "stale");
        return "";
      } catch (e) {
        return String(e);
      }
    });
    expect(stale).toContain("changed on disk");
    expect(await fs.readFile(json)).toEqual(before);
    await close();
    await launch(directory);
    await expect(page.locator("#project-title")).toHaveText("Final demo");
    expect(await page.evaluate(() => window.studio.projectsFolder())).toBe(
      folder,
    );
    await dialogs([{ title: "video or image", path: input }]);
    await importMedia("Demo source 2");
    expect(await fs.readFile(json)).toEqual(before);
    for (const number of [1, 2]) {
      const session = await page.evaluate(() => window.studio.begin());
      await page.evaluate((id) => window.studio.abort(id), session.id);
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(folder, `Recording ${number}.framestudio/recovery.json`),
          ),
        ).interrupted,
      ).toBe(true);
    }
    await dialogs([{ title: "all your projects", path: secondFolder }]);
    await page.locator("#projects-folder").click();
    await expect(page.locator("#projects-path")).toHaveText(folder);
    await page.locator("#choose-projects-folder").click();
    await expect(page.locator("#projects-path")).toHaveText(secondFolder);
    await fs.mkdir("evidence/projects", { recursive: true });
    await page.screenshot({ path: "evidence/projects/folder.png" });
    await page.locator("#projects-dialog .close-dialog").click();
    await dialogs([{ title: "video or image", path: input }]);
    await importMedia("Demo source");
    expect(
      (await page.evaluate(() => window.studio.status())).project.directory,
    ).toBe(path.join(secondFolder, "Demo source.framestudio"));
    await page.locator("#project-title").dblclick();
    await page.locator("#project-name").fill("Ready to share");
    await page.screenshot({ path: "evidence/projects/rename.png" });
    await page.locator("#project-name").press("Enter");
    await expect(page.locator("#project-title")).toHaveText("Ready to share");
    expect(errors).toEqual([]);
    await fs.writeFile(
      "evidence/projects/checks.json",
      JSON.stringify(
        {
          asarSha256: process.env.FRAME_EXECUTABLE
            ? createHash("sha256")
                .update(
                  await fs.readFile(
                    path.resolve(
                      "release/Open Record Studio.app/Contents/Resources/app.asar",
                    ),
                  ),
                )
                .digest("hex")
            : null,
          folderCancellation: true,
          rememberedFolder: true,
          automaticUniqueNames: true,
          inlineRename: true,
          dirtyEditsPreserved: true,
          staleRevisionRejected: true,
          coldReopen: true,
          changeFolder: true,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
});
