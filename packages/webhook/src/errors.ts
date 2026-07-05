/**
 * Reasons a Krova Cloud webhook verification can fail.
 *
 * - `malformed_header` — the `X-Krova-Signature` header could not be parsed
 *   into a `t` (timestamp) and `v1` (signature) pair.
 * - `timestamp_out_of_tolerance` — the signed timestamp is too far from the
 *   current time (likely a replayed request).
 * - `invalid_signature` — the recomputed HMAC did not match the `v1` value.
 */
export type KrovaWebhookErrorReason =
  | "malformed_header"
  | "timestamp_out_of_tolerance"
  | "invalid_signature";

/**
 * Error thrown by {@link verifyKrovaWebhookOrThrow} (and the Express /
 * framework helpers) when a webhook signature fails verification.
 *
 * The machine-readable {@link KrovaWebhookError.reason} lets callers branch on
 * the specific failure without string-matching the message.
 */
export class KrovaWebhookError extends Error {
  public readonly reason: KrovaWebhookErrorReason;

  constructor(reason: KrovaWebhookErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "KrovaWebhookError";
    this.reason = reason;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, KrovaWebhookError.prototype);
  }
}
