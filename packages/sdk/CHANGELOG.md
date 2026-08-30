# Changelog

All notable changes to `@krovacloud/sdk` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.


## Unreleased

### Changed

- **BREAKING** — `KrovaErrorBody` no longer has an open `[key: string]: unknown`
  index signature; only `error?: string` is part of the public shape. The
  documented API contract (`components.schemas.Error` in the bundled OpenAPI
  spec) is the strict `{ error: string }`, and no internal consumer reads any
  field other than `body?.error`. Callers that were treating the body as an
  arbitrary record should narrow to `body?.error` (or cast the body to a
  concrete shape they actually expect).

## 0.4.2

### Changed

- Docs-only republish: the `domains.create()` example now destructures the
  `{ domain, records }` result (the 0.4.0 shape), and `domains.records()` plus
  the `DnsRecord`/`DnsRecordStatus` types are documented in the README. No code
  change.

## 0.4.1

### Changed

- Automated patch republish (2026-08-27, PR #46): the package is now built with
  **tsdown** (replacing the unmaintained tsup) and formatted with **oxfmt**
  (replacing Prettier). No API change.

## 0.4.0

### Changed

- **BREAKING** — `domains.create()` now resolves to `{ domain, records }`
  instead of `Domain`. The records are the DNS entries you must publish for the
  domain to work, so you can create them in the same run.

  Why it changed rather than being added alongside: for a wildcard, two of the
  three records (the ownership `TXT` and the `_acme-challenge` delegation) were
  not derivable from anything the SDK returned. An integration had to read the
  record shapes out of the docs and hope they still matched the server, which is
  the arrangement that eventually breaks quietly.

  ```diff
  - const domain = await client.domains.create(spaceId, cubeId, { domain, port });
  + const { domain, records } = await client.domains.create(spaceId, cubeId, { domain, port });
  ```

### Added

- `domains.records(spaceId, cubeId, mappingId)` — the same records, each checked
  against live DNS. Poll it after publishing them; `summary.complete` turns true
  only once every record is `found`. Rate limited, because it performs real
  lookups.
- `DnsRecord` and `DnsRecordStatus` types.

  Each record carries `mustBeGrey` and `proxyOk`, which are deliberate
  opposites: the routing record may sit behind Cloudflare's proxy, the
  `_acme-challenge` record must not. Automation needs both — one alone would let
  you confidently orange-cloud the single record that has to stay grey.

  `state: "missing"` means NOT PUBLISHED YET — the expected state before you
  create the record, never an error. `state: "unknown"` means the lookup could
  not be completed, which is never a statement about your DNS.

## 0.3.2

### Changed

- Docs: the npm package description no longer references physical infrastructure.


## 0.3.1

### Changed

- Docs: removed a physical-infrastructure reference from the README.
## 0.3.0

### Added

- First-class typed helpers for a Cube's attached resources:
  - `client.domains` — `list` / `create` / `update` / `delete` custom domains.
  - `client.snapshots` — `list` / `create` / `delete`, plus `client.cubes.restore`.
  - `client.tcpMappings` — `list` / `create` / `delete` TCP port mappings.
  - `client.imports` — `create` / `get` / `complete` / `cancel` a `.cube` import.
  - `client.backups.download` — a time-limited backup download URL.
- Exported `Domain`, `Snapshot`, `TcpMapping`, and the create/update input types.

## 0.2.0

### Added

- `client.getSpace()` — resolve the `Space` your API key is scoped to, so you no
  longer have to hardcode a `spaceId`.
- `client.cubes.ssh(spaceId, cubeId)` — fetch a Cube's SSH connection info
  (`host`, `port`, `user`, and pinned `hostKeys`).
- Exported `Space` and `CubeSshInfo` types.

### Changed

- Refreshed the bundled OpenAPI spec to the current API (26 paths / 35
  operations). `client.raw` can now reach `GET /space`, the cube SSH-info
  endpoint, and the CLI device-auth endpoints, which the stale bundle omitted.

## 0.1.6

### Fixed

- Auto-retry no longer throws `TypeError: unusable` on requests with a body
  (POST/PUT/DELETE) — a pristine copy of the request is captured before its body
  is consumed, so retries of the mutating, rate-limited endpoints work.
- A hostile or misconfigured `Retry-After` is now capped at the maximum backoff
  (10s), so the client can't be parked for minutes/hours.

## 0.1.5

### Changed

- Re-homed into the **krova-node** monorepo. The source now lives at
  `github.com/krovacloud/krova-node` — this release restores npm provenance and
  the correct repository link (the previous per-package repo was made private).

## 0.1.3

### Security

- **Prevent API-key leakage via HTTP redirects.** The client now sets
  `redirect: "manual"` on every request, so a `3xx` response is never
  auto-followed. Previously the SDK relied on `fetch`'s default
  (`redirect: "follow"`), and because the Fetch spec only strips
  `Authorization` / `Cookie` / `Proxy-Authorization` — **not** a custom header
  like `X-API-KEY` — on a cross-origin redirect, a redirect from the API host to
  another origin (via a compromised/misconfigured proxy, an open-redirect, or a
  MITM) would silently resend the API key to the redirect target. The Krova
  Cloud API is a plain JSON API that never legitimately redirects a data call;
  with `"manual"`, a redirect now surfaces as a `KrovaError` instead of leaking
  the key. Regression-tested in `tests/redirect.test.ts`.

## 0.1.2

### Changed

- **Documentation & packaging polish** — no runtime behavior change.
  - Rewrote the README to a complete public reference: npm/license/types
    badges, a runnable Quickstart traced against the shipped API, a per-export
    reference for `KrovaClient`, every `client.cubes.*` and `client.catalog.*`
    helper, `client.raw`, and `KrovaError` (with its full field table), plus
    Auth, Error-handling, Configuration, TypeScript, Requirements, and a
    **Related packages** section linking `@krovacloud/cli`,
    `@krovacloud/webhook`, `@krovacloud/mcp`, and `n8n-nodes-krova`.
  - Sharpened the `package.json` `description`, expanded `keywords`
    (added `api`, `api-client`, `cubes`, `openapi`), and pointed `homepage`
    at [krova.cloud](https://krova.cloud).
  - Added a top-level `"types"` fallback and a `"./package.json"` entry to the
    `exports` map for broader tooling compatibility.

## 0.1.1

### Fixed

- Regenerated the vendored OpenAPI types from the corrected Krova Cloud spec so
  the SDK's response types match what the API actually returns. The most
  visible changes:
  - **`Cube`** now has the real shape: `state` (was `status`), a nested
    `resources: { vcpu, ramGb, diskGb }` object (replacing the flat `vcpus` /
    `ramMb` / `diskLimitGb` fields), and `image` (was `imageId`). The
    `spaceId` field was removed (a Cube is addressed via its Space in the path,
    not carried in the body). All fields are now `required`.
  - **`TcpMapping`** now returns `hostPort` (was `publicPort`), a structured
    `whitelistedIps: { id, cidr }[]` (was a flat `whitelistIps: string[]`), plus
    `label`, `status`, `isSsh`, `createdAt`, and `updatedAt`.
  - **`Snapshot`** gained `kind`; **`Domain`** gained `corsConfig`.
  - `Domain`, `Snapshot`, `Webhook`, `WebhookDelivery`, and `Error` schema
    fields are now `required` rather than optional, matching the real responses.
- Updated the README quickstart and the client tests to the corrected `Cube`
  shape (`cube.state`, `cube.resources.vcpu`, `cube.image`).

## 0.1.0

Initial release.

### Added

- `KrovaClient` — a typed client for the Krova Cloud API, generated from the
  vendored OpenAPI spec via `openapi-typescript` + `openapi-fetch`.
- `client.raw` — the underlying fully typed `openapi-fetch` client covering every
  operation in the spec (31 operations across 22 resource paths: Cubes, Domains,
  TCP mappings, Snapshots, Backups, Imports, Webhooks, and the public catalog).
- Ergonomic helpers that unwrap `data` and throw on non-2xx:
  - `client.cubes`: `list`, `create`, `get`, `update`, `delete`, `sleep`, `wake`.
  - `client.catalog`: `regions`, `images`, `pricing`.
- `KrovaError` — thrown by the helpers on non-2xx responses, with `status`,
  `code`, `requestId`, and the parsed error `body`.
- `X-API-KEY` authentication (the spec's scheme) with an optional
  `authScheme: "bearer"` mode.
- Automatic retry on `429` / `503`, honoring the `Retry-After` header.
- Dual ESM + CJS builds with bundled `.d.ts` type declarations.
