import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";

export async function connectMcp(mode = "legacy") {
  const client = new Client({ name: "frame-studio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("mcp/server.mjs")],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (d) => {
    stderr += d;
  });
  await client.connect(transport, { mode });
  return { client, transport, stderr: () => stderr };
}

export async function call(client, name, args) {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 120000 },
  );
  if (result.isError)
    throw new Error(result.content.map((c) => c.text || "").join("\n"));
  return result.structuredContent;
}
