import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const preferencesFile = (profile) => path.join(profile, "preferences.json");
async function preferences(profile) {
  try {
    return JSON.parse(await fs.readFile(preferencesFile(profile), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
export async function projectsFolder(profile) {
  const folder = (await preferences(profile)).projectsFolder;
  return typeof folder === "string" && path.isAbsolute(folder) ? folder : null;
}
export async function setProjectsFolder(profile, folder) {
  if (typeof folder !== "string" || !path.isAbsolute(folder))
    throw new Error("Choose a projects folder");
  const resolved = await fs.realpath(folder);
  if (
    resolved
      .split(path.sep)
      .some((part) => part.toLowerCase().endsWith(".framestudio"))
  )
    throw new Error("Choose a folder outside an existing Open Record Studio project");
  if (!(await fs.stat(resolved)).isDirectory())
    throw new Error("Choose a folder for your projects");
  await fs.access(resolved, fs.constants.W_OK | fs.constants.X_OK);
  const next = { ...(await preferences(profile)), projectsFolder: resolved };
  await fs.mkdir(profile, { recursive: true });
  const temp = path.join(profile, `preferences.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(next, null, 2) + "\n", {
      flag: "wx",
    });
    await fs.rename(temp, preferencesFile(profile));
  } finally {
    await fs.rm(temp, { force: true });
  }
  return resolved;
}
export function projectName(value) {
  const name = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (
    !name ||
    name.length > 120 ||
    /[/\\\x00-\x1f]/.test(name) ||
    /^\.+$/.test(name)
  )
    throw new Error("Use a project name of 1–120 characters without slashes");
  return name;
}
export async function allocateProject(folder, sourceName) {
  // mkdir is exclusive: simultaneous imports/recordings cannot overwrite a project.
  let base = sourceName
    ? sourceName
        .normalize("NFC")
        .replace(/[/\\\x00-\x1f]/g, " ")
        .trim()
        .slice(0, 100)
        .replace(/^\.+$/, "") || "Media"
    : "Recording";
  const characters = Array.from(base);
  while (Buffer.byteLength(base, "utf8") > 180) {
    characters.pop();
    base = characters.join("");
  }
  for (let i = 1; ; i++) {
    const name = sourceName && i === 1 ? base : `${base} ${i}`;
    const directory = path.join(folder, `${name}.framestudio`);
    try {
      await fs.mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw new Error(
        "The projects folder is unavailable. Choose a folder in Projects folder.",
        { cause: error },
      );
    }
  }
}
