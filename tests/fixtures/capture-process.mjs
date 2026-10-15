// Explicit test fixture process: replaces only ScreenCaptureKit, never ships.
import fs from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const fixture = args[args.indexOf("--fixture") + 1];

const project = JSON.parse(
  await fs.readFile(path.join(fixture, "project.json")),
);
if (args.includes("--interaction-access")) {
  console.log(
    JSON.stringify(
      project.interactions?.permissions ?? {
        accessibility: false,
        inputMonitoring: false,
      },
    ),
  );
  process.exit(0);
}
await fs.copyFile(path.join(fixture, "screen.mp4"), output);
// Exercise camera preroll while the native capture helper warms up.
await new Promise((resolve) => setTimeout(resolve, 300));
const excludeIndex = args.indexOf("--exclude-apps");
console.log(
  JSON.stringify({
    event: "started",
    interactions: project.interactions ?? {
      permissions: { accessibility: true, inputMonitoring: true },
      capabilities: { click: true, typing: true, selection: true },
    },
    startedAt: Date.now(),
    captureType: "screen",
    excludedApplicationPIDs:
      excludeIndex < 0 || args.includes("--omit-exclusions")
        ? []
        : args[excludeIndex + 1].split(",").map(Number),
  }),
);
process.stdin.once("data", async () => {
  await fs.writeFile(
    path.join(path.dirname(output), "cursor.json"),
    JSON.stringify(project.cursor),
  );
  if (project.interactions)
    await fs.writeFile(
      path.join(path.dirname(output), "interactions.json"),
      JSON.stringify(project.interactions),
    );
  console.log(JSON.stringify({ event: "finished" }));
  process.exit(0);
});
