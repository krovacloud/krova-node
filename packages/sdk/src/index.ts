/**
 * `@krovacloud/sdk` — the official TypeScript SDK for the Krova Cloud API.
 *
 * @example
 * ```ts
 * import { KrovaClient } from "@krovacloud/sdk";
 *
 * const krova = new KrovaClient({ apiKey: process.env.KROVA_API_KEY! });
 * const cubes = await krova.cubes.list("space_123");
 * ```
 */
export {
  KrovaClient,
  DEFAULT_BASE_URL,
  type KrovaClientOptions,
  type AuthScheme,
  type Cube,
  type Region,
  type Image,
  type PricingTier,
  type Pagination,
  type Space,
  type CubeSshInfo,
} from "./client.js";
export { KrovaError, krovaErrorFrom, type KrovaErrorBody } from "./error.js";

// Re-export the generated OpenAPI types for advanced/`.raw` consumers.
export type { paths, components } from "./generated/types.js";
