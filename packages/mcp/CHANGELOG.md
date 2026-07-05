# Changelog

All notable changes to `@krovacloud/mcp` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).



## 0.2.1

### Changed

- Reworded the resource-cap descriptions to not reference internal tooling.
## 0.2.0

### Added

- 10 new tools covering a Cube's attached resources: `list_domains` /
  `create_domain` / `delete_domain`, `list_snapshots` / `create_snapshot` /
  `delete_snapshot` / `restore_cube`, and `list_tcp_mappings` /
  `create_tcp_mapping` / `delete_tcp_mapping`. Deletes and `restore_cube`
  (which replaces the disk) are marked **destructive** so clients gate them
  behind confirmation.
## 0.1.8

### Changed

- `create_cube` now documents the per-space default resource caps (16 vCPU /
  32 GB RAM / 100 GB disk, raisable for your space) and enforces the disk
  rule (minimum 10 GiB, in steps of 5), so an assistant is less likely to
  request an invalid size.

## 0.1.7

### Fixed

- The server now starts correctly when launched via `npx -y @krovacloud/mcp`
  (or any `.bin` symlink). The entrypoint check compared unresolved paths, so
  under `npx` it never matched and the server started without serving.

## 0.1.6

### Changed

- Re-homed into the **krova-node** monorepo. The source now lives at
  `github.com/krovacloud/krova-node` — this release restores npm provenance and
  the correct repository link (the previous per-package repo was made private).

## 0.1.3 - 2026-07-02

### Added

- **MCP tool annotations** on every tool (`readOnlyHint` / `destructiveHint` /
  `idempotentHint` / `openWorldHint`). Read tools (`list_cubes`, `get_cube`,
  `list_regions`, `list_images`, `get_pricing`) are flagged read-only;
  `create_cube` and `delete_cube` are flagged **destructive** so MCP clients can
  require human confirmation before executing them — the spec-standard guard
  against a prompt-injected model firing a destructive call on untrusted input.

### Changed

- **Enforced the documented 16 KiB `userData` cap** in the `create_cube` schema
  (previously the "max 16 KB" was only described, not validated) so an oversized
  or injected cloud-init payload is rejected at the boundary instead of forwarded.
- Tightened `create_cube` input bounds: string fields (`name`, `image`,
  `region`, `sshPublicKey`) carry length ceilings, and `vcpu`/`ramGb`/`diskGb`
  are integer-and-max-bounded (generous client-side sanity ceilings; the Krova
  Cloud API remains authoritative on real tier/host limits).
- Sharpened the `delete_cube` / `create_cube` descriptions to state they are
  destructive/billable and should only run on explicit user intent.
- Bumped the MCP `serverInfo.version` advertised to clients to `0.1.3`.

## 0.1.2 - 2026-07-02

### Changed

- Consume the published [`@krovacloud/sdk`](https://www.npmjs.com/package/@krovacloud/sdk)
  from npm (`^0.1.1`) instead of the local `file:../krova-js` workspace link.
  No sibling checkout is needed to build or contribute.
- Overhauled the README to best-in-class: version/downloads/license/Node badges,
  a one-line pitch, a copy-paste **client setup** section with the exact MCP
  config for **Claude Desktop**, **Claude Code** (`claude mcp add` + `.mcp.json`),
  and **Cursor** (`.cursor/mcp.json`), a full **Tools reference** (all 9 tools with
  parameters + a `create_cube` field table), and **Authentication**, **Requirements**,
  and **Related packages** sections.
- Sharpened the package `description` and expanded `keywords`
  (`ai`, `llm`, `claude`, `cursor`, `anthropic`, `mcp-server`, `cubes`, …) for npm
  discoverability.
- Bumped the MCP `serverInfo.version` advertised to clients to `0.1.2`, matching
  the package version.

## 0.1.1 - 2026-07-01

### Changed

- Rebuilt against `@krovacloud/sdk` **v0.1.1**, which corrects the `Cube` type
  (`state` / `resources: { vcpu, ramGb, diskGb }` / `image`; the old
  `status` / `vcpus` / `imageId` and `spaceId` fields are gone). Tool handlers
  are pass-through and required no field-name changes; the `create_cube`
  handler already sent the nested `resources` shape. Test fixtures updated to
  the `state` field for accuracy. Still linked via `file:../krova-js` for
  workspace development (tracks `^0.1.1`).

## 0.1.0 - 2026-07-01

### Added

- Initial release: a Model Context Protocol (MCP) server for Krova Cloud,
  served over stdio.
- Tools for managing Cubes and browsing the catalog: `list_cubes`, `get_cube`,
  `create_cube`, `sleep_cube`, `wake_cube`, `delete_cube`, `list_regions`,
  `list_images`, `get_pricing`.
- Environment configuration: `KROVA_API_KEY` (required), `KROVA_BASE_URL`
  (optional), `KROVA_SPACE_ID` (optional default Space).
- Built on the official `@krovacloud/sdk` client and `@modelcontextprotocol/sdk`.

