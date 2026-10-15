import { motionFixture } from "./motion-fixture.mjs";
import fs from "node:fs/promises";
import path from "node:path";

export async function followFixture(root) {
  const project = await motionFixture(root);
  project.name = "Follow zoom validation";
  project.edits.style.showCursor = false;
  project.edits.zooms = [
    {
      id: "follow",
      mode: "follow",
      start: 0.1,
      end: 3.9,
      zoom: 2.5,
      focusX: 0.5,
      focusY: 0.5,
      ease: 0.35,
    },
  ];
  project.cursor.samples = Array.from({ length: 481 }, (_, i) => {
    const t = i / 120;
    return {
      t,
      x:
        t < 2
          ? 0.28 + 0.07 * Math.sin(t * 4) + (i % 2 ? 0.007 : -0.007)
          : 0.76 + 0.08 * Math.sin(t * 3),
      y: 0.5 + 0.16 * Math.sin(t * 2),
      visible: t < 2.8 || t > 3.2,
      pressed: i >= 240 && i < 245,
    };
  });
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify(project));
  return project;
}
