import createClient, { type Client, type Middleware } from "openapi-fetch";
import { krovaErrorFrom } from "./error.js";
import type { components, paths } from "./generated/types.js";

/** The Cube resource, as defined in the Krova Cloud OpenAPI spec. */
export type Cube = components["schemas"]["Cube"];

/** A region with available capacity (from the catalog). */
export type Region = components["schemas"]["Region"];

/** A selectable OS image (from the catalog). */
export type Image = components["schemas"]["Image"];

/** A volume-pricing tier (from the catalog). */
export type PricingTier = components["schemas"]["PricingTier"];

/** Pagination envelope returned alongside a Cube list. */
export type Pagination = components["schemas"]["Pagination"];

/** Default API base URL — the single `servers[0].url` from the OpenAPI spec. */
export const DEFAULT_BASE_URL = "https://krova.cloud/api/v1";

/**
 * How the API key is presented to the server.
 *
 * - `"x-api-key"` (default) — `X-API-KEY: <key>`, matching the spec's
 *   `components.securitySchemes.ApiKeyAuth` (an `apiKey` header named
 *   `X-API-KEY`).
 * - `"bearer"` — `Authorization: Bearer <key>`, for gateways that expect it.
 */
export type AuthScheme = "x-api-key" | "bearer";

export interface KrovaClientOptions {
  /**
   * Your Krova Cloud API key (a `kro_...` token). Keys are scoped per Space
   * and inherit the permissions of the membership that created them.
   */
  apiKey: string;
  /** Override the API base URL. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /**
   * Auth header scheme. Defaults to `"x-api-key"` (the spec's scheme).
   */
  authScheme?: AuthScheme;
  /**
   * Max automatic retries on retryable statuses (429, 503).
   * Defaults to 2. Set to 0 to disable retries.
   */
  maxRetries?: number;
  /**
   * A custom `fetch` implementation (e.g. for tests or a proxy). Defaults to
   * the global `fetch`.
   */
  fetch?: typeof fetch;
}

/** Statuses the retry middleware treats as transient. */
const RETRYABLE_STATUSES = new Set([429, 503]);
/** Fallback backoff (ms) when the server sends no `Retry-After` header. */
const BASE_BACKOFF_MS = 500;
/** Cap on any single backoff wait (ms), to keep retries "small but real". */
const MAX_BACKOFF_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a `Retry-After` header (RFC 7231): either delta-seconds or an
 * HTTP-date. Returns milliseconds to wait, or `null` if absent/unparseable.
 */
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function authMiddleware(apiKey: string, scheme: AuthScheme): Middleware {
  return {
    onRequest({ request }) {
      if (scheme === "bearer") {
        request.headers.set("Authorization", `Bearer ${apiKey}`);
      } else {
        request.headers.set("X-API-KEY", apiKey);
      }
      return request;
    },
  };
}

/**
 * Retry middleware: on a retryable status, wait (honoring `Retry-After` when
 * present, else exponential backoff) and re-issue the request. openapi-fetch
 * clones the request per attempt, so re-fetching here is safe.
 */
function retryMiddleware(maxRetries: number, doFetch: typeof fetch): Middleware {
  return {
    async onResponse({ request, response }) {
      if (maxRetries <= 0 || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      let current = response;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (!RETRYABLE_STATUSES.has(current.status)) break;
        const retryAfterMs = parseRetryAfterMs(current.headers.get("retry-after"));
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        await sleep(retryAfterMs ?? backoff);
        current = await doFetch(request.clone());
      }
      return current;
    },
  };
}

/**
 * A typed client for the Krova Cloud API.
 *
 * @example
 * ```ts
 * const krova = new KrovaClient({ apiKey: "kro_..." });
 * const cubes = await krova.cubes.list("space_123");
 * ```
 */
export class KrovaClient {
  /**
   * The underlying openapi-fetch client — a fully typed escape hatch to every
   * path in the spec. Returns `{ data, error, response }` and never throws.
   *
   * @example
   * ```ts
   * const { data, error } = await krova.raw.GET(
   *   "/spaces/{spaceId}/cubes/{cubeId}",
   *   { params: { path: { spaceId, cubeId } } },
   * );
   * ```
   */
  readonly raw: Client<paths>;

  /** The resolved base URL in use. */
  readonly baseUrl: string;

  constructor(options: KrovaClientOptions) {
    if (!options?.apiKey) {
      throw new Error("KrovaClient: `apiKey` is required.");
    }
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const doFetch = options.fetch ?? globalThis.fetch;
    const maxRetries = options.maxRetries ?? 2;

    this.raw = createClient<paths>({
      baseUrl: this.baseUrl,
      // SECURITY: never auto-follow redirects. The Krova Cloud API is a plain
      // JSON API and never legitimately 3xx's a data call. Following a redirect
      // would resend the `X-API-KEY` header to the redirect target — and unlike
      // `Authorization`, `Cookie`, and `Proxy-Authorization`, the Fetch spec does
      // NOT strip a custom header like `X-API-KEY` on a cross-origin redirect
      // (verified against undici/Node fetch). A compromised/misconfigured proxy,
      // an open-redirect on the API, or a MITM could otherwise exfiltrate the key
      // to an attacker's host. With `"manual"`, a redirect comes back as a
      // non-ok response and the helpers throw `KrovaError` instead of leaking.
      redirect: "manual",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.raw.use(authMiddleware(options.apiKey, options.authScheme ?? "x-api-key"));
    if (maxRetries > 0) {
      this.raw.use(retryMiddleware(maxRetries, doFetch));
    }
  }

  // ---------------------------------------------------------------------------
  // Cubes
  // ---------------------------------------------------------------------------

  readonly cubes = {
    /** List Cubes in a Space, with pagination metadata. */
    list: async (spaceId: string) => {
      const { data, error, response } = await this.raw.GET("/spaces/{spaceId}/cubes", {
        params: { path: { spaceId } },
      });
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (data === undefined)
        throw krovaErrorFrom(response, { error: "List Cubes response was empty." });
      return data;
    },

    /**
     * Create a Cube. Returns the created {@link Cube}.
     *
     * @param spaceId Target Space id.
     * @param body Cube spec — `{ name, image, resources, sshPublicKey, ... }`.
     * @param opts Optional `idempotencyKey` (max 255 chars, scoped per space).
     */
    create: async (
      spaceId: string,
      body: NonNullable<
        paths["/spaces/{spaceId}/cubes"]["post"]["requestBody"]
      >["content"]["application/json"],
      opts?: { idempotencyKey?: string },
    ): Promise<Cube> => {
      const { data, error, response } = await this.raw.POST("/spaces/{spaceId}/cubes", {
        params: {
          path: { spaceId },
          ...(opts?.idempotencyKey
            ? { header: { "Idempotency-Key": opts.idempotencyKey } }
            : {}),
        },
        body,
      });
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      const cube = data?.cube;
      if (!cube) {
        throw krovaErrorFrom(response, { error: "Create Cube response had no `cube`." });
      }
      return cube;
    },

    /** Get a single Cube. Returns the {@link Cube}. */
    get: async (spaceId: string, cubeId: string): Promise<Cube> => {
      const { data, error, response } = await this.raw.GET(
        "/spaces/{spaceId}/cubes/{cubeId}",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      const cube = data?.cube;
      if (!cube) {
        throw krovaErrorFrom(response, { error: "Get Cube response had no `cube`." });
      }
      return cube;
    },

    /**
     * Update a Cube's SSH port.
     *
     * The Krova Cloud API exposes no general Cube-mutation endpoint; the only
     * mutable Cube field over the API is its SSH port, via
     * `PUT /spaces/{spaceId}/cubes/{cubeId}/ssh-port`. This helper maps to that
     * endpoint. (Compute resize / rename are not part of the public API.)
     */
    update: async (
      spaceId: string,
      cubeId: string,
      body: NonNullable<
        paths["/spaces/{spaceId}/cubes/{cubeId}/ssh-port"]["put"]["requestBody"]
      >["content"]["application/json"],
    ): Promise<unknown> => {
      const { data, error, response } = await this.raw.PUT(
        "/spaces/{spaceId}/cubes/{cubeId}/ssh-port",
        { params: { path: { spaceId, cubeId } }, body },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },

    /** Delete a Cube (asynchronous — deletion is enqueued). */
    delete: async (spaceId: string, cubeId: string) => {
      const { data, error, response } = await this.raw.DELETE(
        "/spaces/{spaceId}/cubes/{cubeId}",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (data === undefined)
        throw krovaErrorFrom(response, { error: "Delete Cube response was empty." });
      return data;
    },

    /** Sleep a running Cube (asynchronous — sleep is enqueued). */
    sleep: async (spaceId: string, cubeId: string): Promise<unknown> => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/{cubeId}/sleep",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },

    /** Wake a sleeping Cube (asynchronous — wake is enqueued). */
    wake: async (spaceId: string, cubeId: string): Promise<unknown> => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/{cubeId}/wake",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },
  };

  // ---------------------------------------------------------------------------
  // Public catalog (no auth required by the API, but the key is harmless)
  // ---------------------------------------------------------------------------

  readonly catalog = {
    /** List regions with available capacity. */
    regions: async () => {
      const { data, error, response } = await this.raw.GET("/regions");
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (data === undefined)
        throw krovaErrorFrom(response, { error: "Regions response was empty." });
      return data;
    },

    /** List available OS images. */
    images: async () => {
      const { data, error, response } = await this.raw.GET("/images");
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (data === undefined)
        throw krovaErrorFrom(response, { error: "Images response was empty." });
      return data;
    },

    /** Per-resource hourly rates and volume pricing tiers. */
    pricing: async () => {
      const { data, error, response } = await this.raw.GET("/pricing");
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (data === undefined)
        throw krovaErrorFrom(response, { error: "Pricing response was empty." });
      return data;
    },
  };
}
