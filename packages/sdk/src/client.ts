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

/** A Space — the tenancy an API key is scoped to. */
export type Space = components["schemas"]["Space"];

/** A Cube's SSH connection info (host, port, user, and pinned host keys). */
export type CubeSshInfo = components["schemas"]["CubeSshInfo"];

/** A custom domain attached to a Cube. */
export type Domain = components["schemas"]["Domain"];

/** A snapshot of a Cube's disk. */
export type Snapshot = components["schemas"]["Snapshot"];

/** A TCP port mapping exposing a Cube port on the host. */
export type TcpMapping = components["schemas"]["TcpMapping"];

/** Request body for attaching a custom domain to a Cube. */
export type CreateDomainInput = NonNullable<
  paths["/spaces/{spaceId}/cubes/{cubeId}/domains"]["post"]["requestBody"]
>["content"]["application/json"];

/** Request body for updating a custom domain's proxy settings. */
export type UpdateDomainInput = NonNullable<
  paths["/spaces/{spaceId}/cubes/{cubeId}/domains/{mappingId}"]["patch"]["requestBody"]
>["content"]["application/json"];

/** Request body for creating a TCP port mapping. */
export type CreateTcpMappingInput = NonNullable<
  paths["/spaces/{spaceId}/cubes/{cubeId}/tcp-mappings"]["post"]["requestBody"]
>["content"]["application/json"];

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
 * present, else exponential backoff) and re-issue the request.
 *
 * A retried request may have a body (POST/PUT/DELETE — exactly the mutating,
 * rate-limited endpoints). By the time `onResponse` runs, the request that was
 * handed to `fetch` has had its body stream consumed, so `request.clone()` here
 * throws `TypeError: unusable`. To re-issue it we stash a *pristine* clone in
 * `onRequest` — captured before the body is read — keyed by openapi-fetch's
 * per-request `id`, and clone from that pristine copy on each attempt.
 */
function retryMiddleware(maxRetries: number, doFetch: typeof fetch): Middleware {
  const pristine = new Map<string, Request>();
  return {
    onRequest({ request, id }) {
      pristine.set(id, request.clone());
      return request;
    },
    onError({ id }) {
      // fetch rejected (network error) — no onResponse will fire; don't leak.
      pristine.delete(id);
    },
    async onResponse({ request, response, id }) {
      const original = pristine.get(id) ?? request;
      pristine.delete(id);
      if (maxRetries <= 0 || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      let current = response;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (!RETRYABLE_STATUSES.has(current.status)) break;
        const retryAfterMs = parseRetryAfterMs(current.headers.get("retry-after"));
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        // Cap the wait — including a server-supplied `Retry-After` — so a hostile
        // or misconfigured server can't park the client for minutes/hours.
        await sleep(Math.min(retryAfterMs ?? backoff, MAX_BACKOFF_MS));
        // Re-issue from the pristine clone; `.clone()` keeps it reusable across
        // multiple attempts.
        current = await doFetch(original.clone());
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
     * Update the IN-CUBE port that SSH is forwarded to.
     *
     * `cubePort` is the port **inside** the Cube that sshd listens on — NOT the
     * host port you connect to. The host port is allocated by Krova and is not
     * changed by this call. Pointing this at a port nothing is listening on
     * inside the Cube will silently make SSH unreachable; the default is 22.
     *
     * The Krova Cloud API exposes no general Cube-mutation endpoint; the only
     * mutable Cube field over the API is this port, via
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

    /** Power off a running Cube (asynchronous — power-off is enqueued). The Cube
     *  becomes `stopped` (its host RAM is freed); start it again with `wake`. */
    powerOff: async (spaceId: string, cubeId: string): Promise<unknown> => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/{cubeId}/power-off",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },

    /** Start a stopped Cube — a cold boot (asynchronous — start is enqueued). */
    wake: async (spaceId: string, cubeId: string): Promise<unknown> => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/{cubeId}/wake",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },

    /**
     * Get a Cube's SSH connection info — host, port, login user, and (when
     * available) the pinned host public keys for strict host-key verification.
     */
    ssh: async (spaceId: string, cubeId: string): Promise<CubeSshInfo> => {
      const { data, error, response } = await this.raw.GET(
        "/spaces/{spaceId}/cubes/{cubeId}/ssh",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (data === undefined)
        throw krovaErrorFrom(response, { error: "Cube SSH-info response was empty." });
      return data;
    },

    /**
     * Restore a Cube's disk from one of its {@link Snapshot}s (asynchronous —
     * the restore is enqueued). The Cube's current disk is replaced.
     */
    restore: async (spaceId: string, cubeId: string, snapshotId: string) => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/{cubeId}/restore",
        { params: { path: { spaceId, cubeId } }, body: { snapshotId } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },
  };

  /**
   * Resolve the {@link Space} this API key is scoped to — so you don't have to
   * hardcode a `spaceId`. Handy right after constructing the client:
   *
   * @example
   * ```ts
   * const space = await krova.getSpace();
   * const cubes = await krova.cubes.list(space.id);
   * ```
   */
  async getSpace(): Promise<Space> {
    const { data, error, response } = await this.raw.GET("/space");
    if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
    if (data === undefined)
      throw krovaErrorFrom(response, { error: "Space response was empty." });
    return data;
  }

  // ---------------------------------------------------------------------------
  // Custom domains
  // ---------------------------------------------------------------------------

  readonly domains = {
    /** List the custom domains attached to a Cube. */
    list: async (spaceId: string, cubeId: string): Promise<Domain[]> => {
      const { data, error, response } = await this.raw.GET(
        "/spaces/{spaceId}/cubes/{cubeId}/domains",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data?.domains ?? [];
    },

    /** Attach a custom domain to a Cube. `domain` + `port` are required. */
    create: async (
      spaceId: string,
      cubeId: string,
      body: CreateDomainInput,
    ): Promise<Domain> => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/{cubeId}/domains",
        { params: { path: { spaceId, cubeId } }, body },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (!data?.domain)
        throw krovaErrorFrom(response, { error: "Create domain response had no `domain`." });
      return data.domain;
    },

    /** Update a domain's per-domain proxy settings. */
    update: async (
      spaceId: string,
      cubeId: string,
      mappingId: string,
      body: UpdateDomainInput,
    ): Promise<Domain> => {
      const { data, error, response } = await this.raw.PATCH(
        "/spaces/{spaceId}/cubes/{cubeId}/domains/{mappingId}",
        { params: { path: { spaceId, cubeId, mappingId } }, body },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (!data?.domain)
        throw krovaErrorFrom(response, { error: "Update domain response had no `domain`." });
      return data.domain;
    },

    /** Detach a custom domain from a Cube. */
    delete: async (spaceId: string, cubeId: string, mappingId: string) => {
      const { data, error, response } = await this.raw.DELETE(
        "/spaces/{spaceId}/cubes/{cubeId}/domains/{mappingId}",
        { params: { path: { spaceId, cubeId, mappingId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },
  };

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  readonly snapshots = {
    /** List a Cube's snapshots. */
    list: async (spaceId: string, cubeId: string): Promise<Snapshot[]> => {
      const { data, error, response } = await this.raw.GET(
        "/spaces/{spaceId}/cubes/{cubeId}/snapshots",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data?.snapshots ?? [];
    },

    /** Create a snapshot of a Cube's disk (asynchronous — enqueued). */
    create: async (
      spaceId: string,
      cubeId: string,
      body?: { name?: string },
    ): Promise<Snapshot> => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/{cubeId}/snapshots",
        { params: { path: { spaceId, cubeId } }, body: body ?? {} },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (!data?.snapshot)
        throw krovaErrorFrom(response, { error: "Create snapshot response had no `snapshot`." });
      return data.snapshot;
    },

    /** Delete a snapshot. */
    delete: async (spaceId: string, cubeId: string, snapshotId: string) => {
      const { data, error, response } = await this.raw.DELETE(
        "/spaces/{spaceId}/cubes/{cubeId}/snapshots/{snapshotId}",
        { params: { path: { spaceId, cubeId, snapshotId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },
  };

  // ---------------------------------------------------------------------------
  // TCP port mappings
  // ---------------------------------------------------------------------------

  readonly tcpMappings = {
    /** List a Cube's TCP port mappings. */
    list: async (spaceId: string, cubeId: string): Promise<TcpMapping[]> => {
      const { data, error, response } = await this.raw.GET(
        "/spaces/{spaceId}/cubes/{cubeId}/tcp-mappings",
        { params: { path: { spaceId, cubeId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data?.tcpMappings ?? [];
    },

    /**
     * Create a TCP port mapping exposing a Cube port on the host. `cubePort` is
     * required; `whitelistIps` optionally restricts who can reach it.
     */
    create: async (
      spaceId: string,
      cubeId: string,
      body: CreateTcpMappingInput,
    ): Promise<TcpMapping> => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/{cubeId}/tcp-mappings",
        { params: { path: { spaceId, cubeId } }, body },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      if (!data?.tcpMapping)
        throw krovaErrorFrom(response, { error: "Create TCP mapping response had no `tcpMapping`." });
      return data.tcpMapping;
    },

    /** Delete a TCP port mapping. */
    delete: async (spaceId: string, cubeId: string, mappingId: string) => {
      const { data, error, response } = await this.raw.DELETE(
        "/spaces/{spaceId}/cubes/{cubeId}/tcp-mappings/{mappingId}",
        { params: { path: { spaceId, cubeId, mappingId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },
  };

  // ---------------------------------------------------------------------------
  // Imports & backups (.cube archive import / export)
  // ---------------------------------------------------------------------------

  readonly imports = {
    /**
     * Start importing a `.cube` archive into a new Cube. Returns the multipart
     * upload target (`importId`, `uploadId`, presigned `parts`, …). Upload the
     * archive to those URLs, then call {@link imports.complete}.
     */
    create: async (
      spaceId: string,
      body: NonNullable<
        paths["/spaces/{spaceId}/cubes/imports"]["post"]["requestBody"]
      >["content"]["application/json"],
    ) => {
      const { data, error, response } = await this.raw.POST("/spaces/{spaceId}/cubes/imports", {
        params: { path: { spaceId } },
        body,
      });
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },

    /** Get an in-progress or completed import by id. */
    get: async (spaceId: string, importId: string) => {
      const { data, error, response } = await this.raw.GET(
        "/spaces/{spaceId}/cubes/imports/{importId}",
        { params: { path: { spaceId, importId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },

    /**
     * Finish an import after the archive has been uploaded — provisions the
     * Cube. Pass the uploaded `parts` (partNumber + etag) and the resolved
     * `config`.
     */
    complete: async (
      spaceId: string,
      importId: string,
      body: NonNullable<
        paths["/spaces/{spaceId}/cubes/imports/{importId}/complete"]["post"]["requestBody"]
      >["content"]["application/json"],
    ) => {
      const { data, error, response } = await this.raw.POST(
        "/spaces/{spaceId}/cubes/imports/{importId}/complete",
        { params: { path: { spaceId, importId } }, body },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },

    /** Cancel an in-progress import. */
    cancel: async (spaceId: string, importId: string) => {
      const { data, error, response } = await this.raw.DELETE(
        "/spaces/{spaceId}/cubes/imports/{importId}",
        { params: { path: { spaceId, importId } } },
      );
      if (error !== undefined || !response.ok) throw krovaErrorFrom(response, error);
      return data;
    },
  };

  readonly backups = {
    /** Get a time-limited download URL for a backup `.cube` archive. */
    download: async (spaceId: string, backupId: string) => {
      const { data, error, response } = await this.raw.GET(
        "/spaces/{spaceId}/backups/{backupId}/download",
        { params: { path: { spaceId, backupId } } },
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
