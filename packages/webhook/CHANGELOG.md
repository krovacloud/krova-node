# Changelog

All notable changes to `@krovacloud/webhook` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.


## 0.1.5

### Changed

- The Express middleware now returns a clear `raw_body_required` error when the
  route delivered a parsed (non-raw) body — the most common integration mistake
  — instead of a misleading `invalid_signature`.

## 0.1.4

### Changed

- Re-homed into the **krova-node** monorepo. The source now lives at
  `github.com/krovacloud/krova-node` — this release restores npm provenance and
  the correct repository link (the previous per-package repo was made private).

## 0.1.2 - 2026-07-02

### Security

- **Strict timestamp parsing (hardening).** `parseSignatureHeader` now accepts
  the `t=` field only when it is a canonical UNIX-seconds integer (`[1-9]\d*`,
  bounded to a safe integer). Previously it used `Number()`, which also accepted
  scientific notation (`1e9`), hex/binary/octal literals (`0x10`, `0b101`), a
  leading `+`/`-`, decimals (`1.0`), and leading zeros. The timestamp is part of
  the HMAC-signed input, so no signature bypass or replay-window widening was
  possible via these forms (a non-canonical `t` either falls outside the
  tolerance window or reproduces an already-valid message's own HMAC) — this is
  defense-in-depth to keep parsing predictable and reject ambiguous encodings.
  Regression-tested in `test/verify.test.ts`.


## 0.1.1 - 2026-07-02

### Documentation

- Rewrote the README to reference quality: npm/downloads/bundle-size/license/types
  badges, a dedicated "signature scheme" section (header format, 300s replay
  window, constant-time comparison), a fuller API reference with a
  `verifyKrovaRequest` example and its return type, a **Related packages** table
  (`@krovacloud/sdk`, `@krovacloud/mcp`, `krova` on PyPI, `krova-go`), and a
  **Requirements** section.

### Changed

- Sharpened the package `description` and expanded `keywords` (webhooks,
  signature-verification, hmac-sha256, replay-protection, constant-time,
  express, nextjs, fastify) for better npm discoverability.

No functional or API changes — verification behaviour is identical to 0.1.0.


## 0.1.0 - 2026-07-01

### Added

- Initial release: verify **Krova Cloud** outbound webhook signatures.
- `verifyKrovaWebhook` — non-throwing verification returning
  `{ valid, reason?, timestamp? }`.
- `verifyKrovaWebhookOrThrow` — throwing variant that raises
  `KrovaWebhookError` with a machine-readable `reason`.
- `verifyKrovaRequest` — framework-agnostic helper accepting a `Headers`
  instance or a plain header object (Next.js Route Handlers, Fastify, etc.).
- `krovaWebhook` — Express middleware (requires
  `express.raw({ type: "application/json" })`).
- `parseSignatureHeader` and `computeSignature` helpers.
- Constant-time signature comparison via `crypto.timingSafeEqual` and
  timestamp-tolerance replay protection (default 300s).
- Zero runtime dependencies; ESM + CJS builds with bundled TypeScript
  declarations.

