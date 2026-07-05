# Changelog

All notable changes to `@krovacloud/cli` are documented here.



## 0.5.0

### Added

- `krova domains` (list / add / rm) — manage a Cube's custom domains.
- `krova snapshots` (list / create / restore / rm) — snapshot and restore a
  Cube's disk.
- `krova tcp` (list / add / rm) — manage a Cube's TCP port mappings, with an
  optional `--whitelist` IP allow-list.
## 0.4.3

### Fixed

- `webhooks listen --addr` now correctly parses a bare hostname (e.g.
  `localhost`), a bare port, and IPv6 (`[::1]:4666`, `::1`). A bare host was
  previously replaced with `127.0.0.1`.

## 0.4.2

### Fixed

- `krova pricing` now shows the per-resource hourly **rates** — it previously
  printed only the volume-tier multipliers and dropped `rates`/`currency`/`note`.
- A one-off `--base-url` / `KROVA_BASE_URL` is no longer persisted into the
  stored context.
- `auth login --space` is honored instead of being overwritten by the resolved
  space.
- `cubes create` validates `--vcpu/--ram/--disk` are positive integers instead
  of forwarding `null`.

## 0.4.1

### Changed

- Re-homed into the **krova-node** monorepo. The source now lives at
  `github.com/krovacloud/krova-node` — this release restores npm provenance and
  the correct repository link (the previous per-package repo was made private).

