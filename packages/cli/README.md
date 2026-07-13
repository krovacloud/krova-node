# @krovacloud/cli

The [**Krova Cloud**](https://krova.cloud) command-line interface (`krova`) — manage Cubes (Firecracker
microVMs), browse the catalog, log in through your browser, and SSH into a Cube,
all from your terminal. A pure Node.js CLI built on
[`@krovacloud/sdk`](https://www.npmjs.com/package/@krovacloud/sdk) — no native
binary, no Go toolchain.

```sh
npm i -g @krovacloud/cli
krova --help
```

Requires Node.js ≥ 20.

## Log in

```sh
krova login            # browser device-authorization flow
# or paste an API key:
krova auth login       # prompts (hidden) for a kro_… key
krova whoami           # confirm the active context + space
```

Credentials are stored in `~/.config/krova/config.json` (mode `0600`), as named
**contexts** — switch accounts/spaces like `kubectl`/`aws` profiles. The file
format is compatible with the previous CLI, so existing logins keep working.

```sh
krova context list
krova context use <name>
krova context rename <old> <new>
krova context delete <name>
```

## Cubes

```sh
krova list                         # list Cubes (alias: krova cubes list, ls)
krova get <cube>                   # show one Cube (name or ID)
krova cubes create \
  --name web --image ubuntu-24.04 \
  --vcpu 1 --ram 1 --disk 10 \
  --ssh-key "$(cat ~/.ssh/id_ed25519.pub)"
krova cubes sleep <cube>
krova cubes wake <cube>
krova cubes ssh-port <cube> --port 2222
krova cubes delete <cube>
```

`<cube>` is a Cube **name or ID** — a unique name resolves automatically.

## SSH

```sh
krova ssh <cube>                    # interactive shell
krova ssh <cube> -- uname -a        # run a command non-interactively
krova ssh <cube> -i ~/.ssh/id_ed25519 -L 8080:localhost:80
```

The CLI fetches the Cube's SSH endpoint and, when the server provides them,
**pins the host keys** to `~/.config/krova/known_hosts` with strict host-key
checking (no trust-on-first-use window). The destination is always passed after
a `--` separator, with host/user validated against option-injection — a hostile
value aborts before `ssh` ever runs.

## Domains, snapshots & TCP mappings

Manage a Cube's attached resources. All take a `<cube>` name or ID and support
`--json`.

```sh
# Custom domains
krova domains list <cube>
krova domains add <cube> --domain app.example.com --port 8080
krova domains rm <cube> <domain-id>

# Snapshots + restore
krova snapshots list <cube>
krova snapshots create <cube> --name nightly
krova snapshots restore <cube> <snapshot-id>   # replaces the Cube's disk
krova snapshots rm <cube> <snapshot-id>

# TCP port mappings (expose a Cube port on the host)
krova tcp list <cube>
krova tcp add <cube> --port 5432 --whitelist 203.0.113.4/32
krova tcp rm <cube> <mapping-id>
```

## Catalog

```sh
krova regions          # regions with available capacity
krova images           # OS images
krova pricing           # per-resource hourly pricing
```

## Webhooks

```sh
krova webhooks listen --secret "$KROVA_WEBHOOK_SECRET"
# verifies each delivery's HMAC signature and prints the event
```

## Global flags

Available on every command (flag > env var > context):

| Flag | Env | Purpose |
| --- | --- | --- |
| `--api-key <key>` | `KROVA_API_KEY` | API key |
| `--space <id>` | `KROVA_SPACE_ID` | Space ID (else auto-detected) |
| `--base-url <url>` | `KROVA_BASE_URL` | override the API base URL |
| `--context <name>` | `KROVA_CONTEXT` | select a named context |
| `--json` | | machine-readable JSON output |
| `--timeout <dur>` | | per-request timeout (e.g. `30s`); defaults to `30s` |

## License

MIT
