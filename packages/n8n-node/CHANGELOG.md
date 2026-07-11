# Changelog

All notable changes to `n8n-nodes-krova` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).





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

