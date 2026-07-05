/**
 * The error body shape returned by the Krova Cloud API.
 *
 * Per the OpenAPI spec (`components.schemas.Error`), every non-2xx response
 * body is `{ "error": string }`. Additional fields may appear over time, so
 * we keep the type open.
 */
export interface KrovaErrorBody {
  error?: string;
  [key: string]: unknown;
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
export function krovaErrorFrom(
  response: Response,
  body: KrovaErrorBody | undefined,
): KrovaError {
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
