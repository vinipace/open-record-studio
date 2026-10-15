import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  projectsFolder,
  setProjectsFolder,
  allocateProject,
  projectName,
} from "../desktop/project-library.mjs";

test("projects folder persists and atomic auto names preserve collisions, concurrent creation and missing folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-library-"));
  try {
    const profile = path.join(root, "profile"),
      folder = path.join(root, "Projects");
    await fs.mkdir(folder);
    assert.equal(await projectsFolder(profile), null);
    await setProjectsFolder(profile, folder);
    assert.equal(await projectsFolder(profile), await fs.realpath(folder));
    const first = await allocateProject(folder);
    assert.equal(path.basename(first), "Recording 1.framestudio");
    await fs.writeFile(path.join(first, "original.txt"), "keep");
    const more = await Promise.all(
      Array.from({ length: 12 }, () => allocateProject(folder)),
    );
    assert.equal(new Set(more).size, 12);
    assert.equal(
      await fs.readFile(path.join(first, "original.txt"), "utf8"),
      "keep",
    );
    assert.equal(
      path.basename(await allocateProject(folder, "Café demo")),
      "Café demo.framestudio",
    );
    assert.equal(
      path.basename(await allocateProject(folder, "Café demo")),
      "Café demo 2.framestudio",
    );
    await assert.rejects(
      setProjectsFolder(profile, first),
      /outside an existing/,
    );
    assert.equal(await projectsFolder(profile), await fs.realpath(folder));
    await assert.rejects(
      allocateProject(path.join(root, "missing")),
      /folder is unavailable/,
    );
    assert.equal(projectName("  New title  "), "New title");
    for (const name of ["", "..", "a/b", "a\\b", "x".repeat(121), null])
      assert.throws(() => projectName(name), /project name/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
