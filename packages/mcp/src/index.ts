import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, loadConfig } from "./config.js";
import { createServer } from "./server.js";

export { createServer, SERVER_INFO } from "./server.js";
export { createClient, loadConfig } from "./config.js";
export { TOOLS, runTool } from "./tools.js";

/**
 * Entry point: read config from the environment, construct the Krova Cloud
 * client + MCP server, and serve over stdio.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config);
  const server = createServer(client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr only — stdout is reserved for the JSON-RPC stream.
  process.stderr.write("krova-mcp server running on stdio\n");
}

// Run when invoked as the CLI bin (not when imported as a library).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `krova-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
