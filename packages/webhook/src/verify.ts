import { createHmac, timingSafeEqual } from "node:crypto";
import { KrovaWebhookError, type KrovaWebhookErrorReason } from "./errors.js";

/** Default replay-tolerance window, in seconds (5 minutes). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The raw webhook body: either the JSON string or its bytes. */
export type WebhookPayload = string | Buffer | Uint8Array;

/** Parsed contents of an `X-Krova-Signature` header. */
export interface ParsedSignature {
  /** The signed UNIX timestamp (seconds), from the `t=` field. */
  timestamp: number;
  /** The lowercase-hex HMAC-SHA256 signature, from the `v1=` field. */
  signature: string;
}

/** Options accepted by the verification helpers. */
export interface VerifyOptions {
  /** Raw request body (string or bytes) exactly as received — never re-serialized. */
  payload: WebhookPayload;
  /** The full `X-Krova-Signature` header value. */
  signature: string;
  /** The webhook signing secret configured in Krova Cloud. */
  secret: string;
  /**
   * Maximum allowed absolute difference (seconds) between now and the signed
   * timestamp before the request is rejected as a replay.
   * @default 300
   */
  toleranceSeconds?: number;
  /**
   * Override the current time (seconds since epoch). Primarily for testing.
   * @default Math.floor(Date.now() / 1000)
   */
  now?: number;
}

/** Successful verification result. */
export interface VerifySuccess {
  valid: true;
  /** The signed timestamp (UNIX seconds). */
  timestamp: number;
  reason?: undefined;
}

/** Failed verification result. */
export interface VerifyFailure {
  valid: false;
  /** The machine-readable failure reason. */
  reason: KrovaWebhookErrorReason;
  /** The signed timestamp, present when the header parsed but a later check failed. */
  timestamp?: number;
}

/**
 * Result of a non-throwing verification. A discriminated union on `valid` —
 * narrow with `if (result.valid) { … }` to access `timestamp`, or the `else`
 * branch to read `reason`.
 */
export type VerifyResult = VerifySuccess | VerifyFailure;

/**
 * Parse an `X-Krova-Signature` header into its `t` (timestamp) and `v1`
 * (signature) parts.
 *
 * The header format is `t=<unix-seconds>,v1=<hex>`. Fields may appear in any
 * order and unknown fields are ignored (forward-compatible with future
 * signature versions).
 *
 * @throws {KrovaWebhookError} with reason `malformed_header` if the header is
 * missing either field or the timestamp is not a finite integer.
 */
export function parseSignatureHeader(header: string): ParsedSignature {
  if (typeof header !== "string" || header.length === 0) {
    throw new KrovaWebhookError("malformed_header", "Signature header is empty");
  }

  let timestamp: number | undefined;
  let signature: string | undefined;

  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      // Strict: a canonical UNIX-seconds timestamp is `[1-9]\d*` (digits only, no
      // leading zero). `Number()` is far too lax here — it would accept `1e9`,
      // `0x10`, `0b101`, `+5`, `-5`, `1.0`, leading zeros, and `Infinity` — so we
      // validate the literal digits first, then bound to a safe integer (a 10–11
      // digit UNIX timestamp is well within range). The timestamp is HMAC-signed,
      // so this is defense-in-depth hardening rather than a bypass fix, but it
      // keeps parsing predictable and rejects ambiguous encodings.
      if (/^[1-9]\d*$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) timestamp = parsed;
      }
    } else if (key === "v1") {
      if (value.length > 0) signature = value;
    }
  }

  if (timestamp === undefined || signature === undefined) {
    throw new KrovaWebhookError(
      "malformed_header",
      "Signature header must contain both 't' and 'v1' fields",
    );
  }

  return { timestamp, signature };
}

/**
 * Compute the expected signature for a payload the same way Krova Cloud does:
 * `HMAC_SHA256(secret, "${timestamp}.${rawBody}")` as lowercase hex.
 */
export function computeSignature(
  secret: string,
  timestamp: number,
  payload: WebhookPayload,
): string {
  const body =
    typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(payload);
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.`);
  hmac.update(body);
  return hmac.digest("hex");
}

/**
 * Constant-time comparison of two hex signature strings. Returns `false`
 * (without leaking timing) when the lengths differ or either side is not a
 * valid hex string.
 */
function timingSafeCompareHex(a: string, b: string): boolean {
  // Reject non-hex early; a mismatched length can't be timing-safe compared.
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  // Buffer.from(hex) silently drops invalid/odd chars, so re-check byte length.
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Krova Cloud webhook signature without throwing.
 *
 * Recomputes `HMAC_SHA256(secret, "${t}.${rawBody}")`, compares it to the
 * header's `v1` value in constant time, and rejects when the signed timestamp
 * is outside the tolerance window (replay protection).
 *
 * @returns a {@link VerifyResult}; check `.valid` before trusting the payload.
 */
export function verifyKrovaWebhook(options: VerifyOptions): VerifyResult {
  const {
    payload,
    signature: header,
    secret,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    now = Math.floor(Date.now() / 1000),
  } = options;

  let parsed: ParsedSignature;
  try {
    parsed = parseSignatureHeader(header);
  } catch (err) {
    if (err instanceof KrovaWebhookError) {
      return { valid: false, reason: err.reason };
    }
    throw err;
  }

  if (Math.abs(now - parsed.timestamp) > toleranceSeconds) {
    return {
      valid: false,
      reason: "timestamp_out_of_tolerance",
      timestamp: parsed.timestamp,
    };
  }

  const expected = computeSignature(secret, parsed.timestamp, payload);
  if (!timingSafeCompareHex(expected, parsed.signature)) {
    return {
      valid: false,
      reason: "invalid_signature",
      timestamp: parsed.timestamp,
    };
  }

  return { valid: true, timestamp: parsed.timestamp };
}

/**
 * Verify a Krova Cloud webhook signature, throwing on failure.
 *
 * Identical checks to {@link verifyKrovaWebhook}, but raises a
 * {@link KrovaWebhookError} (carrying the machine-readable `reason`) instead of
 * returning a result object. Returns the parsed timestamp on success.
 *
 * @throws {KrovaWebhookError}
 */
export function verifyKrovaWebhookOrThrow(
  options: VerifyOptions,
): { timestamp: number } {
  const result = verifyKrovaWebhook(options);
  if (!result.valid) {
    throw new KrovaWebhookError(result.reason);
  }
  return { timestamp: result.timestamp };
}
