import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, loadConfig } from "./config.js";
import { createServer } from "./server.js";

export { createServer, SERVER_INFO } from "./server.js";
export { createClient, loadConfig } from "./config.js";
export { TOOLS, runTool } from "./tools.js";

/**
 * Whether this module is the process entrypoint (was launched directly, not
 * imported). `argv1` is the launched path — under `npx` / a global install it
 * is the `.bin/krova-mcp` SYMLINK, while `moduleUrl` (import.meta.url) is the
 * realpath'd `dist/index.js`. A raw string/URL comparison therefore never
 * matches when the server is started the documented way, so we compare the
 * RESOLVED real paths of both. Exported for testing.
 */
export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

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
if (isEntrypoint(process.argv[1], import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `krova-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
