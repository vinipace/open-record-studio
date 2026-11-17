import { readFile } from "node:fs/promises";
import { mcpClientConfig } from "../desktop/mcp-config.mjs";
import { runTodosCli, todoHelp } from "./todos-cli.mjs";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);
const args = process.argv.slice(2);
if (args[0] === "todos") {
  try {
    await runTodosCli(args.slice(1));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code: error.code || "INVALID_ARGUMENT",
          message: error.message,
        },
      }),
    );
    process.exitCode = 1;
  }
} else if (args.length === 1 && args[0] === "--version") {
  console.log(`${pkg.productName} MCP ${pkg.version}`);
} else if (args.length === 1 && args[0] === "--print-config") {
  const launcher = process.env.OPEN_RECORD_STUDIO_MCP_LAUNCHER;
  if (!launcher)
    throw new Error("Run --print-config through open-record-studio-mcp");
  console.log(JSON.stringify(mcpClientConfig(launcher), null, 2));
} else if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(
    `Open Record Studio MCP\n\nUsage: open-record-studio-mcp [--print-config | --version | --help]\n\nWith no arguments, serves MCP over stdin/stdout. The desktop window can stay closed.\nNo separate Node.js installation or source checkout is needed.\nFFmpeg/ffprobe are required for previews and renders (brew install ffmpeg).`,
  );
  console.log("\n" + todoHelp);
} else if (args.length) {
  console.error("Unknown arguments. Use open-record-studio-mcp --help.");
  process.exitCode = 1;
} else {
  const { startStdio } = await import("./server.mjs");
  startStdio();
}
