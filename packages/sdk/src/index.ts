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
  type AuthScheme,
  type CreateCubeInput,
  type CreateDomainInput,
  type CreateTcpMappingInput,
  type Cube,
  type CubeSshInfo,
  DEFAULT_BASE_URL,
  type Domain,
  type Image,
  KrovaClient,
  type KrovaClientOptions,
  type Pagination,
  type PricingTier,
  type Region,
  type Snapshot,
  type Space,
  type TcpMapping,
  type UpdateDomainInput,
} from "./client.js";
export {
  KrovaError,
  type KrovaErrorBody,
  krovaErrorFrom,
  TerminationProtectedError,
  terminationProtectedFrom,
} from "./error.js";

// Re-export the generated OpenAPI types for advanced/`.raw` consumers.
export type { components, paths } from "./generated/types.js";
