import { KrovaWebhookError } from "./errors.js";
import {
  verifyKrovaWebhook,
  type VerifyFailure,
  type WebhookPayload,
} from "./verify.js";

/** Header carrying the signature: `t=<timestamp>,v1=<hex>`. */
export const SIGNATURE_HEADER = "x-krova-signature";
/** Header carrying the event name. */
export const EVENT_HEADER = "x-krova-event";
/** Header carrying the unique delivery id. */
export const DELIVERY_HEADER = "x-krova-delivery";

/** Common options for the framework helpers. */
export interface FrameworkOptions {
  /** The webhook signing secret configured in Krova Cloud. */
  secret: string;
  /**
   * Replay-tolerance window in seconds.
   * @default 300
   */
  toleranceSeconds?: number;
}

/**
 * A verified Krova Cloud webhook, attached to the request by the framework
 * helpers once the signature checks pass.
 */
export interface KrovaWebhookContext {
  /** The signed timestamp (UNIX seconds). */
  timestamp: number;
  /** The `X-Krova-Event` header value, if present. */
  event?: string;
  /** The `X-Krova-Delivery` header value, if present. */
  delivery?: string;
}

type HeaderValue = string | string[] | undefined;

function firstHeader(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/**
 * Framework-agnostic core. Verifies a raw body against the provided headers
 * and returns a discriminated result you can act on from any HTTP framework
 * (Next.js Route Handlers, Fastify, plain `http`, etc.).
 *
 * `headers` may be a plain object, a `Headers` instance, or anything with a
 * `.get()` method — header names are matched case-insensitively.
 */
export function verifyKrovaRequest(args: {
  payload: WebhookPayload;
  headers: Headers | Record<string, HeaderValue> | { get(name: string): string | null };
  secret: string;
  toleranceSeconds?: number;
}): ({ valid: true } & KrovaWebhookContext) | VerifyFailure {
  const getHeader = makeHeaderGetter(args.headers);
  const signature = getHeader(SIGNATURE_HEADER);

  const result = verifyKrovaWebhook({
    payload: args.payload,
    signature: signature ?? "",
    secret: args.secret,
    ...(args.toleranceSeconds !== undefined
      ? { toleranceSeconds: args.toleranceSeconds }
      : {}),
  });

  if (!result.valid) {
    return result;
  }

  const context: { valid: true } & KrovaWebhookContext = {
    valid: true,
    timestamp: result.timestamp,
  };
  const event = getHeader(EVENT_HEADER);
  const delivery = getHeader(DELIVERY_HEADER);
  if (event !== undefined) context.event = event;
  if (delivery !== undefined) context.delivery = delivery;
  return context;
}

function makeHeaderGetter(
  headers: Headers | Record<string, HeaderValue> | { get(name: string): string | null },
): (name: string) => string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    const h = headers as { get(name: string): string | null };
    return (name) => h.get(name) ?? undefined;
  }
  // Plain object: build a lowercased lookup once.
  const record = headers as Record<string, HeaderValue>;
  const lower = new Map<string, HeaderValue>();
  for (const key of Object.keys(record)) {
    lower.set(key.toLowerCase(), record[key]);
  }
  return (name) => firstHeader(lower.get(name.toLowerCase()));
}

// --- Express ---------------------------------------------------------------
// Structural types so we never take a runtime dependency on `express`.

interface ExpressLikeRequest {
  body: unknown;
  headers: Record<string, HeaderValue>;
  krovaWebhook?: KrovaWebhookContext;
}

interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  json(body: unknown): unknown;
}

type ExpressNext = (err?: unknown) => void;

/**
 * Express middleware that verifies the incoming Krova Cloud webhook signature.
 *
 * IMPORTANT: the raw request body is required. Mount
 * `express.raw({ type: "application/json" })` on the webhook route BEFORE this
 * middleware so `req.body` is a `Buffer` — a body already parsed by
 * `express.json()` has been re-serialized and will NOT match the signature.
 *
 * On success it attaches a {@link KrovaWebhookContext} to `req.krovaWebhook`
 * and calls `next()`. On failure it responds `401` with
 * `{ error: <reason> }` and does not call `next()`.
 *
 * @example
 * import express from "express";
 * import { krovaWebhook } from "@krovacloud/webhook";
 *
 * const app = express();
 * app.post(
 *   "/webhooks/krova",
 *   express.raw({ type: "application/json" }),
 *   krovaWebhook({ secret: process.env.KROVA_WEBHOOK_SECRET! }),
 *   (req, res) => {
 *     const event = JSON.parse(req.body.toString("utf8"));
 *     // req.krovaWebhook.event / .delivery / .timestamp are trustworthy here
 *     res.status(200).json({ received: true });
 *   },
 * );
 */
export function krovaWebhook(options: FrameworkOptions) {
  return function krovaWebhookMiddleware(
    req: ExpressLikeRequest,
    res: ExpressLikeResponse,
    next: ExpressNext,
  ): void {
    const body = req.body;
    const payload: WebhookPayload =
      typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array
        ? (body as WebhookPayload)
        : "";

    const result = verifyKrovaRequest({
      payload,
      headers: req.headers,
      secret: options.secret,
      ...(options.toleranceSeconds !== undefined
        ? { toleranceSeconds: options.toleranceSeconds }
        : {}),
    });

    if (!result.valid) {
      res.status(401).json({ error: result.reason });
      return;
    }

    req.krovaWebhook = {
      timestamp: result.timestamp,
      ...(result.event !== undefined ? { event: result.event } : {}),
      ...(result.delivery !== undefined ? { delivery: result.delivery } : {}),
    };
    next();
  };
}

export { KrovaWebhookError };
