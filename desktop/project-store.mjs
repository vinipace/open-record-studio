import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const revisionOf = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export async function projectRevision(directory) {
  return revisionOf(await readFile(path.join(directory, "project.json")));
}

// Both Electron and MCP use this lock, so checking the revision and replacing
// the file form one transaction even across independent server processes.
export async function saveProject(p) {
  const { directory, id, revision, ...data } = p;
  const lock = path.join(directory, ".frame-save.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Project is being saved by another process. Retry shortly.",
      );
    throw error;
  }
  const temp = path.join(directory, `project.${randomUUID()}.tmp`);
  try {
    const existing = await projectRevision(directory).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== revision)
      throw new Error(
        "Project changed on disk. Reload it before saving or editing.",
      );
    const bytes = JSON.stringify(data, null, 2) + "\n";
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, path.join(directory, "project.json"));
    p.revision = revisionOf(bytes);
    return p.revision;
  } finally {
    await rm(temp, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
