import { createRequire } from "node:module";

import { KrovaClient } from "@krovacloud/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "./config.js";
import { runTool, TOOLS, type ToolContext } from "./tools.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Package identity advertised to MCP clients (version read from package.json,
 *  so it stays in lockstep with releases). */
export const SERVER_INFO = {
  name: "krova-mcp",
  version: pkg.version,
  title: "Krova Cloud",
};

/**
 * Build an {@link McpServer} with every Krova Cloud tool registered against the
 * given client + config. Kept transport-agnostic so it can be wired to stdio in
 * `index.ts` (or any other transport, or a test).
 */
export function createServer(client: KrovaClient, config: McpConfig): McpServer {
  const server = new McpServer(SERVER_INFO);
  const ctx: ToolContext = { defaultSpaceId: config.defaultSpaceId };

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // Advertise behavioral hints (read-only vs. destructive) so MCP clients
        // can gate destructive calls (create_cube / delete_cube) behind human
        // confirmation — the primary guard against a prompt-injected model.
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => runTool(tool, client, args ?? {}, ctx),
    );
  }

  return server;
}
