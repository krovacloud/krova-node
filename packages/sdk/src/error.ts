/**
 * The error body shape returned by the Krova Cloud API.
 *
 * Per the OpenAPI spec (`components.schemas.Error`), every non-2xx response
 * body is `{ "error": string }`.
 */
export interface KrovaErrorBody {
  error?: string;
}

/**
 * The richer 409 body shape the v1 API returns for a termination-protected
 * Cube. The base {@link KrovaErrorBody} only carries `error: string` because
 * the documented `Error` schema is flat; the DELETE handler returns this
 * nested form for `error.code = "termination_protected"`. The {@link KrovaError}
 * `body` slot stays a `KrovaErrorBody` for backwards compatibility — the
 * dedicated error class below carries the parsed cube fields instead.
 */
export interface TerminationProtectedErrorBody {
  error?: {
    code?: string;
    message?: string;
    cube?: {
      id?: string;
      terminationProtectionChangedAt?: string | null;
      terminationProtectionChangedBy?: string | null;
    };
  };
}

/**
 * Error thrown by the ergonomic {@link KrovaClient} helpers when the API
 * responds with a non-2xx status.
 *
 * The raw openapi-fetch client (`client.raw`) never throws — it returns
 * `{ data, error, response }`. The helpers wrap that and throw `KrovaError`
 * so callers can `try/catch`.
 */
export class KrovaError extends Error {
  /** HTTP status code of the failing response. */
  readonly status: number;

  /**
   * A machine-readable error code, when the API surfaces one via the
   * `X-Error-Code` response header. The documented error body only carries a
   * human-readable `error` string, so this is best-effort.
   */
  readonly code?: string;

  /**
   * The request id from the `X-Request-Id` response header, when present.
   * Useful when contacting Krova Cloud support about a specific failure.
   */
  readonly requestId?: string;

  /** The parsed JSON error body, when the response had one. */
  readonly body?: KrovaErrorBody;

  /** The raw `Response` object, for callers that need headers/url/etc. */
  readonly response?: Response;

  constructor(
    message: string,
    init: {
      status: number;
      code?: string;
      requestId?: string;
      body?: KrovaErrorBody;
      response?: Response;
    },
  ) {
    super(message);
    this.name = "KrovaError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.body = init.body;
    this.response = init.response;
    // Restore prototype chain for instanceof across compilation targets.
    Object.setPrototypeOf(this, KrovaError.prototype);
  }
}

/**
 * Build a {@link KrovaError} from a failing response + parsed error body.
 */
export function krovaErrorFrom(response: Response, body: KrovaErrorBody | undefined): KrovaError {
  const message =
    (typeof body?.error === "string" && body.error) ||
    response.statusText ||
    `Request failed with status ${response.status}`;
  return new KrovaError(message, {
    status: response.status,
    code: response.headers.get("x-error-code") ?? undefined,
    requestId: response.headers.get("x-request-id") ?? undefined,
    body,
    response,
  });
}

/**
 * Thrown by `client.cubes.delete` when the server rejects a delete with
 * `409` and `error.code = "termination_protected"`.
 *
 * The customer-facing contract is: a Cube with `terminationProtection = true`
 * cannot be deleted until the flag is turned off. The CLI and MCP surface the
 * server's message verbatim, so callers can switch on `code` rather than
 * parsing prose. `cubeId` / `changedAt` / `changedBy` are best-effort — a
 * defensive server (or an older control plane) may omit the `cube` block, in
 * which case the SDK falls back to the id the call was made with and leaves
 * the two timestamps `null`.
 */
export class TerminationProtectedError extends KrovaError {
  /** The id of the Cube the customer tried to delete. */
  readonly cubeId: string;

  /**
   * When the flag was last changed (`terminationProtectionChangedAt` on the
   * Cube row). `null` when the server's 409 body omitted it.
   */
  readonly changedAt: string | null;

  /**
   * Who last changed the flag (`terminationProtectionChangedBy` on the Cube
   * row — typically `"user:<id>"`). `null` when the server's 409 body omitted
   * it.
   */
  readonly changedBy: string | null;

  constructor(
    message: string,
    init: {
      status: number;
      code: string;
      requestId?: string;
      body?: KrovaErrorBody;
      response?: Response;
      cubeId: string;
      changedAt: string | null;
      changedBy: string | null;
    },
  ) {
    super(message, {
      status: init.status,
      code: init.code,
      ...(init.requestId ? { requestId: init.requestId } : {}),
      ...(init.body ? { body: init.body } : {}),
      ...(init.response ? { response: init.response } : {}),
    });
    this.name = "TerminationProtectedError";
    this.cubeId = init.cubeId;
    this.changedAt = init.changedAt;
    this.changedBy = init.changedBy;
    Object.setPrototypeOf(this, TerminationProtectedError.prototype);
  }
}

/**
 * Try to interpret a failing DELETE response as the v1 API's
 * termination-protected 409. Returns a {@link TerminationProtectedError} when
 * the body shape matches, `null` otherwise (the caller then falls back to a
 * plain {@link KrovaError}).
 *
 * The 409 body is published as `{ error: { code, message, cube: { … } } }`,
 * but the bundled OpenAPI spec only declares `{ error: string }` for the
 * generic `Error` schema — so the cast is best-effort and we tolerate
 * missing optional fields.
 */
export function terminationProtectedFrom(
  response: Response,
  cubeId: string,
  body: unknown,
): TerminationProtectedError | null {
  if (response.status !== 409 || body === null || typeof body !== "object") return null;
  const errBlock = (body as TerminationProtectedErrorBody).error;
  if (!errBlock || typeof errBlock !== "object") return null;
  if (errBlock.code !== "termination_protected") return null;
  const cubeBlock = errBlock.cube;
  const message =
    (typeof errBlock.message === "string" && errBlock.message) ||
    `Cube ${cubeId} has termination protection on. Turn it off before deleting.`;
  return new TerminationProtectedError(message, {
    status: 409,
    code: "termination_protected",
    requestId: response.headers.get("x-request-id") ?? undefined,
    body: { error: message },
    response,
    cubeId: typeof cubeBlock?.id === "string" ? cubeBlock.id : cubeId,
    changedAt:
      typeof cubeBlock?.terminationProtectionChangedAt === "string"
        ? cubeBlock.terminationProtectionChangedAt
        : null,
    changedBy:
      typeof cubeBlock?.terminationProtectionChangedBy === "string"
        ? cubeBlock.terminationProtectionChangedBy
        : null,
  });
}
