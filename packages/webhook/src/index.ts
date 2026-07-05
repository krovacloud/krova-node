/**
 * @krovacloud/webhook — verify Krova Cloud outbound webhook signatures.
 *
 * Krova Cloud signs each outbound webhook with an HMAC-SHA256 over
 * `"${timestamp}.${rawBody}"` and sends the result in the `X-Krova-Signature`
 * header as `t=<timestamp>,v1=<hex>`. This library recomputes and compares that
 * signature in constant time, and rejects stale timestamps to block replays.
 *
 * @packageDocumentation
 */

export {
  DEFAULT_TOLERANCE_SECONDS,
  computeSignature,
  parseSignatureHeader,
  verifyKrovaWebhook,
  verifyKrovaWebhookOrThrow,
  type ParsedSignature,
  type VerifyFailure,
  type VerifyOptions,
  type VerifyResult,
  type VerifySuccess,
  type WebhookPayload,
} from "./verify.js";

export {
  KrovaWebhookError,
  type KrovaWebhookErrorReason,
} from "./errors.js";

export {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  krovaWebhook,
  verifyKrovaRequest,
  type FrameworkOptions,
  type KrovaWebhookContext,
} from "./frameworks.js";
