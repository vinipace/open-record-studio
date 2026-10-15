export function mcpClientConfig(command) {
  return { mcpServers: { "open-record-studio": { command, args: [] } } };
}
