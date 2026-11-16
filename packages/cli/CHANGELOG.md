# Changelog

All notable changes to `@krovacloud/cli` are documented here.

## Unreleased

### Added

- `krova tunnel <cube> [localPort:]cubePort` and `krova connect <cube> --port <cubePort> [--local-port <n>]`: a private SSH tunnel to a port inside a Cube, bound to `127.0.0.1` only, over the same pinned host keys and strict host-key checking as `krova ssh`. `connect` picks a free local port and prints the endpoint (`--json` prints `host`, `port`, `cube` and `cubePort`). Both accept `-i, --identity`. Prefer them to a public `krova tcp add` mapping for databases.

- `krova psql`, `krova redis` and `krova mysql`: open a private tunnel on a free local port, run `psql`, `redis-cli` or `mysql` against it, close the tunnel when the client exits, and exit with the client's code. Flags: `--user`, `--db`, `--port`, `-i`. Passwords are never taken as flags. A missing client is reported before anything connects.

- `krova exec <cube> -- <command...>`: run a command on a Cube over SSH without a terminal and exit with its exit code.

- `krova cp [-r] [-i <file>] <src> <dst>`: copy files between this machine and a Cube with `scp`. Exactly one side is `<cube>:<path>`; both-remote, both-local and a remote path starting with `-` are rejected.

- `krova auth logout [--context <name>]`: removes a saved context (the current one by default) and its API key from this machine. The key itself keeps working until you revoke it in the dashboard (Settings > API keys). If that was the current context and another one takes over, it prints `Now using <name>.`. `--json` prints `{ "context": "<name>", "result": "logged_out", "current": "<name>" | null }`.

- `--show-secrets` on `krova whoami`, `krova auth status` and `krova context list`: prints the full API key. It stays masked by default, in text and in `--json`. With the flag, `whoami --json` and `auth status --json` return `apiKey` in place of `apiKeyMasked`.

- `krova cubes delete` and `krova snapshots rm` take `-y, --yes`. In a terminal they now ask `[y/N]` before deleting; with no terminal (scripts, pipes) they run without a prompt, as before.

- `krova tcp add` warns on stderr when the port would be open to the whole internet (no `--whitelist`, or `0.0.0.0/0` or `::/0`) and suggests `--whitelist` or `krova tunnel`. In a terminal it also asks `[y/N]`; `-y, --yes` skips the question. With no terminal it adds the mapping as before.

- `krova cubes create` now asks for anything you leave out when run in a terminal: name, image and region from the catalog, vCPUs, RAM and disk, and an SSH public key (it offers `~/.ssh/id_ed25519.pub` and `~/.ssh/id_rsa.pub`, public keys only). It shows a one-line summary and asks `[Y/n]` before creating; `-y, --yes` skips that. Without a terminal, or with `--json`, nothing is prompted and a missing `--name`, `--image` or `--ssh-key` fails exactly as before.

- `krova completion <bash|zsh|fish>` prints a shell completion script for the commands, subcommands, aliases and flags of the installed version. `krova completion --help` shows how to install it for each shell.

- Global `-o, --output <format>` (`table` by default, or `json`). `-o json` is the same as `--json`; any other value fails with a one-line error.

- Errors with a status of 401, 403, 404, 409, 429 or 5xx, and connection failures, now print one extra line on what to try next, for example `Your API key was rejected. Run krova login, or check krova whoami.` for a 401 and `Could not reach <base URL>. Check your connection or KROVA_BASE_URL.` when the server cannot be reached. Nothing changes with `--json`.

- `krova login` and `krova cubes create` show a spinner on stderr while they wait, only in an interactive terminal and never with `--json`.

- `krova backups`: `list`, `get <backup>`, `download <backup>`, `share <backup> <destination-space-id> [--idempotency-key <key>]`, `shares`, `accept <share-id>`, `decline <share-id>` and `cancel <share-id>`. A backup can be named or given by ID. `download` warns on stderr that the printed link works for anyone who has it until it expires. These need the Backups permissions on the key's member (View Backups to read, Manage Backups for the rest).

- `krova domains add --proxy-protocol <v1|v2>` and
  `krova domains set-proxy-protocol <cube> <domain-id> <v1|v2|off>`: send a
  PROXY protocol header naming the visitor on each connection to the Cube. Both
  take `--confirm-mixed-proxy-protocol` to save a setting that differs from
  other domains on the same Cube port.

- API keys now go to the OS keychain: macOS Keychain (through the `security` tool) and, on Linux, the Secret Service (through `secret-tool`). `krova login` and `krova auth login` store the key there under service `krova-cli`, account = the context name, and keep only the context's settings plus `keyStorage: "keychain"` in `config.json`. Each write is read back before the key is trusted. When no keychain is available (Windows, headless Linux, `secret-tool` missing, or the call fails) the key stays in the `0600` config file and one line on stderr says why. Existing file contexts keep working; nothing is migrated unless you ask. `--api-key` and `KROVA_API_KEY` still win and never touch the keychain.

- `krova auth migrate-keychain`: moves the API keys saved in the config file into the keychain. A key leaves the file only after the keychain returns the same value. `--json` prints `{ "keychain": "<name>", "results": [{ "context", "result": "migrated" | "skipped" | "failed", "detail"? }] }`; it exits 1 if any context failed.

- `KROVA_NO_KEYCHAIN=1` forces new keys into the config file, for CI. It does not stop `krova` from reading a key that is already in the keychain.

- `krova whoami`, `krova auth status` and `krova context list --json` show where the key lives (`apiKeyStorage` / `keyStorage`: `keychain` or `file`), and `krova auth logout`, `krova context delete` and `krova context rename` delete or move the keychain item with the context, and only after the config file is saved. `krova context list` no longer reads the keychain unless you pass `--show-secrets`. The config file is now written atomically. Context names cannot start with `-`.

## 0.6.2

### Changed

- Docs-only republish: `krova domains records <cube> <domain-id>` (the 0.6.0
  feature) is now documented in the README. No code change.

## 0.6.1

### Changed

- Automated patch republish (2026-08-27, PR #46): the package is now built with
  **tsdown** (replacing the unmaintained tsup) and formatted with **oxfmt**
  (replacing Prettier). No behavior change.

## 0.6.0

### Added

- `krova domains records <cube> <domain-id>` — the DNS records a domain needs
  and whether each one resolves yet.
- `krova domains add` now prints the records to publish. Attaching a domain does
  nothing until they exist, and for a wildcard two of the three were not
  discoverable from anything the CLI printed.

## 0.5.1

### Changed

- Republished to validate the automated release pipeline. No code changes.

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

