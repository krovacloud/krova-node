# @krovacloud/webhook

[![npm version](https://img.shields.io/npm/v/@krovacloud/webhook)](https://www.npmjs.com/package/@krovacloud/webhook)
[![npm downloads](https://img.shields.io/npm/dm/@krovacloud/webhook)](https://www.npmjs.com/package/@krovacloud/webhook)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@krovacloud/webhook)](https://bundlephobia.com/package/@krovacloud/webhook)
[![license](https://img.shields.io/npm/l/@krovacloud/webhook)](./LICENSE)
[![types](https://img.shields.io/npm/types/@krovacloud/webhook)](https://www.npmjs.com/package/@krovacloud/webhook)

Verify **Krova Cloud** outbound webhook signatures in Node.js — HMAC-SHA256,
constant-time comparison, and replay protection. **Zero runtime dependencies**
(built on `node:crypto`), ESM + CommonJS, first-class TypeScript types.

When Krova Cloud delivers an outbound webhook it signs the request so you can
prove it genuinely came from Krova Cloud and was not tampered with in transit or
replayed. This library performs exactly that verification.

## Install

```sh
npm install @krovacloud/webhook
# or: pnpm add @krovacloud/webhook  /  yarn add @krovacloud/webhook
```

Requires Node.js 18 or newer.

## How Krova Cloud signs a webhook

On every delivery, Krova Cloud sends these headers alongside the raw JSON body:

| Header              | Example                                   | Meaning                          |
| ------------------- | ----------------------------------------- | -------------------------------- |
| `X-Krova-Signature` | `t=1700000000,v1=3f8a…`                   | signed timestamp + HMAC-SHA256   |
| `X-Krova-Event`     | `cube.provisioned`                        | the event name                   |
| `X-Krova-Delivery`  | `dlv_abc123`                              | unique id for this delivery      |

### The signature scheme

```
timestamp = floor(Date.now() / 1000)
signed    = `${timestamp}.${rawBody}`             // "t.body", literal dot separator
v1        = HMAC_SHA256(secret, signed)           // lowercase hex

X-Krova-Signature: t=<timestamp>,v1=<hex>
```

- **Algorithm** — HMAC-SHA256, keyed with your webhook signing secret.
- **Signed content** — the timestamp, a literal `.`, then the exact raw request
  body bytes.
- **Encoding** — the digest is lowercase hex in the `v1=` field.
- **Header** — `X-Krova-Signature: t=..,v1=..`. Fields may appear in any order;
  unknown fields are ignored, so future `v2`/`v3` schemes stay backward
  compatible.
- **Replay window** — the signed timestamp must be within **300 seconds**
  (5 minutes) of the receiver's clock, in either direction. Configurable via
  `toleranceSeconds`.
- **Comparison** — the recomputed digest is compared to `v1` in **constant time**
  (`crypto.timingSafeEqual`), never with a short-circuiting `===`.

To verify, you recompute `HMAC_SHA256(secret, "${t}.${rawBody}")`, compare it to
`v1` in constant time, and reject the request if the timestamp is outside the
tolerance window to stop replays. This library does all of that for you.

> **The raw body matters.** The signature is over the exact bytes Krova Cloud
> sent. If your framework parses the JSON and you re-serialize it, the bytes
> (and therefore the signature) will differ. Always verify against the **raw**
> request body.

## Quickstart — Express

Mount `express.raw({ type: "application/json" })` on the webhook route so the
handler receives the raw `Buffer`, then use the `krovaWebhook` middleware:

```ts
import express from "express";
import { krovaWebhook } from "@krovacloud/webhook";

const app = express();

app.post(
  "/webhooks/krova",
  express.raw({ type: "application/json" }), // REQUIRED: gives us the raw body
  krovaWebhook({ secret: process.env.KROVA_WEBHOOK_SECRET! }),
  (req, res) => {
    // Signature already verified. Now it's safe to parse.
    const payload = JSON.parse(req.body.toString("utf8"));

    // The middleware attaches verified metadata:
    const { event, delivery, timestamp } = req.krovaWebhook!;
    console.log(`Received ${event} (${delivery}) signed at ${timestamp}`);

    res.status(200).json({ received: true });
  },
);

app.listen(3000);
```

On a bad signature, stale timestamp, or missing header the middleware responds
`401 { "error": "<reason>" }` and does **not** call `next()`.

## Quickstart — raw / framework-agnostic verify

Use `verifyKrovaWebhook` directly when you have the raw body and the signature
header in hand (any framework, serverless, or a queue consumer):

```ts
import { verifyKrovaWebhook } from "@krovacloud/webhook";

// `signature` must be the single X-Krova-Signature header value (a string).
// Node's `req.headers[...]` is `string | string[] | undefined`, so coalesce
// to a string; a missing header safely yields `reason: "malformed_header"`.
const signatureHeader = req.headers["x-krova-signature"] ?? "";

const result = verifyKrovaWebhook({
  payload: rawBody,                       // string or Buffer — the raw body
  signature: signatureHeader,             // the X-Krova-Signature value
  secret: process.env.KROVA_WEBHOOK_SECRET!,
  // toleranceSeconds: 300,               // optional, defaults to 300 (5 min)
});

if (!result.valid) {
  // result.reason is "invalid_signature" | "timestamp_out_of_tolerance"
  //                | "malformed_header"
  throw new Error(`Krova webhook rejected: ${result.reason}`);
}

// Safe to trust and process the payload now.
```

Prefer exceptions? Use `verifyKrovaWebhookOrThrow`, which throws a
`KrovaWebhookError` (with a `.reason`) instead of returning a result:

```ts
import { verifyKrovaWebhookOrThrow, KrovaWebhookError } from "@krovacloud/webhook";

try {
  verifyKrovaWebhookOrThrow({ payload, signature, secret });
} catch (err) {
  if (err instanceof KrovaWebhookError) {
    console.error("Rejected:", err.reason);
  }
  throw err;
}
```

## Quickstart — Next.js Route Handler

In the App Router, read the raw body with `await req.text()` and pass the
`Headers` object straight through to `verifyKrovaRequest`:

```ts
// app/api/webhooks/krova/route.ts
import { verifyKrovaRequest } from "@krovacloud/webhook";

export async function POST(req: Request) {
  const rawBody = await req.text(); // raw, un-parsed body
  const result = verifyKrovaRequest({
    payload: rawBody,
    headers: req.headers, // a standard Headers instance — matched case-insensitively
    secret: process.env.KROVA_WEBHOOK_SECRET!,
  });

  if (!result.valid) {
    return Response.json({ error: result.reason }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  // result.event / result.delivery / result.timestamp are verified
  return Response.json({ received: true });
}
```

## Quickstart — Fastify

Register a content-type parser that keeps the raw body, then verify:

```ts
import Fastify from "fastify";
import { verifyKrovaRequest } from "@krovacloud/webhook";

const app = Fastify();

app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => done(null, body), // keep the raw string
);

app.post("/webhooks/krova", (req, reply) => {
  const result = verifyKrovaRequest({
    payload: req.body as string,
    headers: req.headers,
    secret: process.env.KROVA_WEBHOOK_SECRET!,
  });
  if (!result.valid) {
    reply.code(401).send({ error: result.reason });
    return;
  }
  reply.send({ received: true });
});
```

## API

### `verifyKrovaWebhook(options): VerifyResult`

Non-throwing verification.

| Option             | Type               | Default | Description                                       |
| ------------------ | ------------------ | ------- | ------------------------------------------------- |
| `payload`          | `string \| Buffer` | —       | The **raw** request body.                         |
| `signature`        | `string`           | —       | The `X-Krova-Signature` header value.             |
| `secret`           | `string`           | —       | Your Krova Cloud webhook signing secret.          |
| `toleranceSeconds` | `number`           | `300`   | Max allowed clock skew before replay rejection.   |

Returns `{ valid: true, timestamp }` or
`{ valid: false, reason, timestamp? }`.

### `verifyKrovaWebhookOrThrow(options): { timestamp }`

Same checks; throws `KrovaWebhookError` on failure instead of returning a
result.

### `verifyKrovaRequest({ payload, headers, secret, toleranceSeconds? }): ({ valid: true } & KrovaWebhookContext) | VerifyFailure`

Framework-agnostic helper. `headers` may be a `Headers` instance, a plain header
object, or anything with a `.get()` method (header names are matched
case-insensitively), so it works with Next.js Route Handlers, Fastify, plain
`node:http`, and most other frameworks. On success it also returns the `event`
and `delivery` values pulled from the `X-Krova-Event` / `X-Krova-Delivery`
headers.

```ts
const result = verifyKrovaRequest({
  payload: rawBody, // string or Buffer
  headers: req.headers, // Headers | Record<string, string | string[]> | { get() }
  secret: process.env.KROVA_WEBHOOK_SECRET!,
});
if (result.valid) {
  // result.timestamp, result.event?, result.delivery?
}
```

### `krovaWebhook({ secret, toleranceSeconds? })`

Express middleware. Requires the raw body
(`express.raw({ type: "application/json" })`). Attaches
`req.krovaWebhook = { timestamp, event?, delivery? }` on success; responds `401`
with `{ error: <reason> }` on failure.

### `parseSignatureHeader(header): { timestamp, signature }`

Parses `t=<timestamp>,v1=<hex>`. Throws `KrovaWebhookError("malformed_header")`
if either field is missing. Unknown fields are ignored (forward-compatible).

### `computeSignature(secret, timestamp, payload): string`

Computes the lowercase-hex `HMAC_SHA256(secret, "${timestamp}.${payload}")`.
Useful for tests and for signing in your own tooling.

### `KrovaWebhookError`

Thrown by the throwing helpers. Has a `.reason` of
`"invalid_signature" | "timestamp_out_of_tolerance" | "malformed_header"`.

## Security

- Signatures are compared with `crypto.timingSafeEqual` — no early-exit string
  comparison that could leak timing information.
- Stale requests are rejected via the timestamp tolerance window, mitigating
  replay attacks.
- Always keep your webhook secret out of source control and rotate it if
  exposed. See [SECURITY.md](./SECURITY.md).

## Related packages

Other official Krova Cloud libraries:

| Package                                                                    | Language   | Purpose                                  |
| -------------------------------------------------------------------------- | ---------- | ---------------------------------------- |
| [`@krovacloud/sdk`](https://www.npmjs.com/package/@krovacloud/sdk)         | TypeScript | The Krova Cloud API client for Node.js.  |
| [`@krovacloud/mcp`](https://www.npmjs.com/package/@krovacloud/mcp)         | TypeScript | Model Context Protocol server for Krova. |
| [`krova`](https://pypi.org/project/krova/)                                 | Python     | The Krova Cloud API client for Python.   |
| [`github.com/krovacloud/krova-go`](https://github.com/krovacloud/krova-go) | Go         | The Krova Cloud API client for Go.       |

## Requirements

- **Node.js 18 or newer.** The library uses `node:crypto`
  (`createHmac`, `timingSafeEqual`) and has no other runtime dependencies.
- Works in both **ESM** and **CommonJS** projects; TypeScript declarations are
  bundled.
- Any runtime that provides the Node `crypto` API works (Node.js, Bun, and
  Deno via its Node compatibility layer). Edge runtimes without `node:crypto`
  are not supported.

## License

MIT © 2026 Krova Inc. See [LICENSE](./LICENSE).
