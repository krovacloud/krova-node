# Changelog

All notable changes to `n8n-nodes-krova` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).





## 0.3.0

### Changed

- **The package moved to `@krovacloud/n8n-nodes-krova`.** The unscoped
  `n8n-nodes-krova` name is stranded: its sole npm owner account was deleted on
  2026-08-31, which left the name unadministrable and deprecated every published
  version. This package is the same node, published under the `krovacloud` npm
  org alongside the SDK, CLI, MCP and webhook packages.

  Existing installs of `n8n-nodes-krova` keep working but will not receive
  updates. To move: uninstall `n8n-nodes-krova` in **Settings → Community
  Nodes**, then install `@krovacloud/n8n-nodes-krova`. Credentials and existing
  workflow nodes are unaffected — the node type, its operations and the
  **Krova Cloud API** credential are unchanged.

  Starts at 0.3.0 rather than continuing 0.2.x: a short-lived scoped mirror of
  this package existed under the same name in July 2026, and npm permanently
  burns any version number once used.

## 0.2.13

### Changed

- Docs-only republish: changelog entries for 0.2.4-0.2.12 backfilled from the
  release tags. No code change.

## 0.2.12

### Changed

- Automated release (2026-08-27, PR #47): repo tooling — ESLint moved to a flat
  config (`eslint.config.mjs` replaces `.eslintrc.js`), pnpm 11 across the repo,
  typecheck gated in CI. No node behavior change.

## 0.2.11

### Changed

- Automated release (2026-08-27, PR #46): Prettier replaced with **oxfmt**; a
  formatting-only touch in `Krova.node.ts`. No behavior change.

## 0.2.10

### Changed

- Docs (2026-08-23, PR #43): the SSH Public Key field note now describes the
  per-image login user — `ubuntu` on Ubuntu images, `debian` on Debian images
  (both with passwordless `sudo`); Cubes created before August 2026 log in as
  `root`.

## 0.2.9

### Changed

- Docs (2026-08-22): the Create field notes now state that per-Cube size is
  **not** tiered — every Space gets the same 16 vCPU / 32 GB RAM / 100 GB disk
  ceiling.

## 0.2.8

### Added

- **Origin Scheme** on Domain Create and Update (2026-08-06) — reach the Cube
  over HTTPS instead of cleartext, for Cubes that terminate TLS themselves.

## 0.2.7

### Changed

- Docs (2026-08-02): corrected stale sleep/wake copy — the platform powers
  Cubes off and cold-boots them; there is no paused-VM sleep.

## 0.2.6

### Added

- **Cube → Restart** (2026-07-31) — cold-restart a running Cube against the
  host's current kernel, the only way to pick up a refreshed guest kernel.

### Removed

- The stale vendored `openapi.json` (unused by the node at runtime).

## 0.2.5

### Changed

- **Power Off replaces Sleep** (2026-07-18, clean break): the operation is now
  **Power Off** (`power-off`, hitting `/power-off`) and **Wake** is renamed
  **Start** ("start a stopped Cube (cold boot)") — matching the platform, which
  powers Cubes off rather than pausing them.

## 0.2.4

### Changed

- Automated release (2026-07-13): package homepage now points at
  `krova.cloud/developers`. No code change.

## 0.2.3

### Changed

- Docs: install instructions reference only `n8n-nodes-krova` — the pre-rename scoped alias (`@krovacloud/n8n-nodes-krova`) was removed from npm.


## 0.2.2

### Changed

- Reworded the resource-cap field descriptions to not reference internal tooling.
## 0.2.1

### Changed

- Docs: removed a physical-infrastructure reference from the README.
## 0.2.0

### Added

- New **Domain**, **Snapshot**, and **TCP Mapping** resources:
  - Domain — List / Create / Delete a Cube's custom domains.
  - Snapshot — List / Create / Delete, plus **Restore** (restore a Cube's disk
    from a snapshot).
  - TCP Mapping — List / Create / Delete a Cube's TCP port mappings.
## 0.1.7

### Changed

- The **vCPU**, **RAM (GB)**, and **Disk (GB)** fields now enforce the API's
  universal minimums and steps (vCPU ≥1, RAM ≥1 whole GB, disk ≥10 in steps of
  5) and document the per-space default caps (16 vCPU / 32 GB RAM / 100 GB disk,
  raisable for your space). No hard maximum is set client-side, so spaces
  with an admin-raised cap aren't blocked in the editor.

## 0.1.6

### Fixed

- The credential **Test** now calls the authenticated `GET /space` instead of
  the public `/regions`, so an invalid or revoked API key is correctly rejected
  (it previously reported success for any key).

## 0.1.5

### Changed

- Re-homed into the **krova-node** monorepo. The source now lives at
  `github.com/krovacloud/krova-node` — this release restores npm provenance and
  the correct repository link (the previous per-package repo was made private).

## 0.1.3 - 2026-07-02

### Security

- Hardened all space-scoped Cube routing URLs to URL-encode the `spaceId` and
  `cubeId` path parameters via `encodeURIComponent()`. n8n interpolates
  declarative routing URLs unencoded, so a value containing `?`, `#`, `/`, or
  whitespace could previously alter the request path/query (e.g. `spaceId=x?e=1`
  would inject a query string and swallow the intended `/cubes` suffix). The
  `X-API-KEY` host was never at risk — the leading `/spaces/` keeps the URL
  relative to the pinned credential base URL, so no path value can redirect the
  key to another origin — but the encoding closes path-segment injection and
  aligns with n8n's community-node convention. Added tests asserting every ID
  interpolation is encoded and that the node config never echoes the API key.

## 0.1.2 - 2026-07-02

### Changed

- Rewrote the README to community-node marketplace standard: npm/downloads/license
  badges, an in-app **Installation** flow (Settings → Community Nodes), a
  step-by-step **Credential setup** section with a field reference and where to
  get a `kro_...` key, a full **Operations** reference table listing the fields
  each Cube and Catalog operation needs, a concrete **Example workflow**, and a
  **Related packages** section linking the Krova SDK, MCP, webhook, and scoped
  n8n packages.
- Sharpened the package description and expanded `keywords` (kept the required
  `n8n-community-node-package` marketplace tag) for better npm/n8n discovery.

_No functional change to the node, credential, or their behavior._

## 0.1.1 - 2026-07-01

### Fixed

- Verified the node and credential against the corrected Krova Cloud cube
  response shape (`state`, nested `resources.{vcpu,ramGb,diskGb}`, `image`, no
  `spaceId`). The node is declarative and returns API responses raw — it does
  not read, map, or display any cube response field — so no output mapping,
  display value, or credential-test request needed changing. The Create
  request body already sends the correct nested `resources.*` fields. No
  behavioral change; this release records the audit.

## 0.1.0 - 2026-07-01

### Added

- Initial release of the Krova Cloud community node for n8n.
- **Krova Cloud API** credential — injects the `X-API-KEY` header and includes a
  connectivity test against `GET /regions`. Base URL is configurable.
- **Cube** resource with operations: List, Get, Create, Sleep, Wake, Delete
  (all scoped by Space ID). Create supports `name`, `image`, `region`, `vcpu`,
  `ramGb`, `diskGb`, `sshPublicKey`, and optional `userData`.
- **Catalog** resource with operations: Get Regions, Get Images, Get Pricing.
- Node icon and structural test suite (node:test).

