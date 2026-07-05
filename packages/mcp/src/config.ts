import { KrovaClient } from "@krovacloud/sdk";

/**
 * Runtime configuration for the Krova Cloud MCP server, read from the process
 * environment:
 *
 * - `KROVA_API_KEY` (required) — your Krova Cloud API key (`kro_...`).
 * - `KROVA_BASE_URL` (optional) — override the API base URL.
 * - `KROVA_SPACE_ID` (optional) — a default Space id so tools can omit `spaceId`.
 */
export interface McpConfig {
  apiKey: string;
  baseUrl?: string;
  defaultSpaceId?: string;
}

/**
 * Read and validate configuration from the given environment (defaults to
 * `process.env`). Throws if the required `KROVA_API_KEY` is missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiKey = env.KROVA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "KROVA_API_KEY is required. Set it in the MCP server environment to your Krova Cloud API key (kro_...).",
    );
  }

  const baseUrl = env.KROVA_BASE_URL?.trim() || undefined;
  const defaultSpaceId = env.KROVA_SPACE_ID?.trim() || undefined;

  return { apiKey, baseUrl, defaultSpaceId };
}

/** Construct a {@link KrovaClient} from the loaded configuration. */
export function createClient(config: McpConfig): KrovaClient {
  return new KrovaClient({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}
