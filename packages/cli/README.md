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
krova auth logout [--context <name>]   # remove a saved context and its key from this machine
```

`krova auth logout` only clears the local copy. The API key keeps working until you revoke it in the dashboard (Settings > API keys).

`krova whoami`, `krova auth status` and `krova context list --json` mask the API key. Add `--show-secrets` to print it in full.

## Cubes

```sh
krova list                         # list Cubes (alias: krova cubes list, ls)
krova get <cube>                   # show one Cube (name or ID)
krova cubes create \
  --name web --image ubuntu-24.04 \
  --vcpu 1 --ram 1 --disk 10 \
  --ssh-key "$(cat ~/.ssh/id_ed25519.pub)"
krova cubes power-off <cube>
krova cubes wake <cube>
krova cubes restart <cube>   # cold restart — the only way to pick up a new kernel
krova cubes ssh-port <cube> --port 2222   # in-Cube sshd port, NOT the host port
krova cubes delete <cube>            # asks first in a terminal; -y/--yes skips the prompt
```

In a terminal, `krova cubes delete` and `krova snapshots rm` ask `[y/N]` before deleting, because it is permanent. In scripts and pipes (no terminal) they run without a prompt, as before. Pass `-y, --yes` to skip it.

`<cube>` is a Cube **name or ID** — a unique name resolves automatically.

In a terminal, `krova cubes create` asks for whatever you leave out. Run it with no flags to pick the name, image, region, size and SSH key from lists:

```sh
krova cubes create                     # asks for everything
krova cubes create --name web --vcpu 2 # asks for the image, region, RAM, disk and key
```

It reads only `~/.ssh/id_ed25519.pub` and `~/.ssh/id_rsa.pub` (public keys, never private ones) to offer your key, and shows a one-line summary with `[Y/n]` before it creates anything. Add `-y` / `--yes` to skip that question. A fully flagged command never asks anything, and without a terminal (scripts, CI) or with `--json` nothing is prompted: a missing `--name`, `--image` or `--ssh-key` is an error, as before.

## SSH

```sh
krova ssh <cube>                    # interactive shell
krova ssh <cube> -- uname -a        # run a command non-interactively
krova ssh <cube> -i ~/.ssh/id_ed25519 -L 8080:localhost:80
```

The CLI fetches the Cube's SSH endpoint — including **which user to log in as**
— so you never have to remember it. That is `ubuntu` on Ubuntu images and
`debian` on Debian images, both with passwordless `sudo` (`sudo su` for a root
shell); Cubes created before August 2026 log in as `root`. Direct root SSH is
disabled on the newer images, which is why the CLI reads the user from the API
rather than assuming one.

When the server provides them the CLI also **pins the host keys** to
`~/.config/krova/known_hosts` with strict host-key checking (no
trust-on-first-use window). The destination is always passed after
a `--` separator, with host/user validated against option-injection — a hostile
value aborts before `ssh` ever runs.

### Private tunnels, database clients, exec and copy

These use the same pinned host keys and strict host-key checking as `krova ssh`. For a database, a private tunnel is safer than a public `krova tcp add` mapping: the port is only reachable from your machine, over your SSH key.

```sh
krova tunnel <cube> 5432               # localhost:5432 -> the Cube's port 5432
krova tunnel <cube> 15432:5432         # localhost:15432 -> the Cube's port 5432
krova connect <cube> --port 5432       # free local port, prints localhost:<port>
krova connect <cube> --port 5432 --json
krova psql <cube> [--user postgres] [--db postgres] [--port 5432]
krova redis <cube> [--port 6379]
krova mysql <cube> [--user root] [--db <name>] [--port 3306]
krova exec <cube> -- uname -a          # no terminal; exits with the remote exit code
krova cp ./site.tar.gz <cube>:/tmp/    # upload (scp)
krova cp -r <cube>:/var/log ./logs     # download a directory
```

Tunnels listen on `127.0.0.1` only. `psql`, `redis` and `mysql` open a tunnel on a free local port, run the client (`psql`, `redis-cli` or `mysql`, which must be installed), and close the tunnel when it exits, with the client's exit code. They never take a password as a flag; the client prompts for it. `exec` joins the words after `--` and the remote shell runs them, like `ssh`. Put global flags such as `--space` before the `--`. In `cp`, exactly one side is `<cube>:<path>`; a remote path can't start with `-`. Write a local name that contains a colon as `./a:b`, or `cp` reads the part before the colon as a Cube. These commands refuse to run when Krova has no recorded host key for the Cube yet (`krova ssh` still connects, with ssh's own host-key prompt).

## Domains, snapshots & TCP mappings

Manage a Cube's attached resources. All take a `<cube>` name or ID and support
`--json`.

```sh
# Custom domains
krova domains list <cube>
krova domains add <cube> --domain app.example.com --port 8080
krova domains records <cube> <domain-id>   # the DNS records the domain needs,
                                           # and whether each one resolves yet
krova domains rm <cube> <domain-id>

# Reach the Cube over HTTPS instead of cleartext — only for a Cube that
# terminates TLS itself (a control panel with its own certificate). Visitors
# are on HTTPS either way.
krova domains add <cube> --domain panel.example.com --port 443 --origin-scheme https
krova domains set-origin <cube> <domain-id> https

# Send a PROXY protocol header naming the visitor on each connection to the
# Cube, for an app that reads the visitor from the connection. The app must
# accept it on that port first. Every domain on the same Cube port needs the
# same setting; add --confirm-mixed-proxy-protocol to save a mix anyway.
krova domains add <cube> --domain app.example.com --port 8080 --proxy-protocol v2
krova domains set-proxy-protocol <cube> <domain-id> v2    # or v1, or off

# Snapshots + restore
krova snapshots list <cube>
krova snapshots create <cube> --name nightly
krova snapshots restore <cube> <snapshot-id>   # replaces the Cube's disk
krova snapshots rm <cube> <snapshot-id>   # asks first in a terminal; -y/--yes skips the prompt

# TCP port mappings (expose a Cube port on the host)
krova tcp list <cube>
krova tcp add <cube> --port 5432 --whitelist 203.0.113.4/32
# With no --whitelist (or 0.0.0.0/0, ::/0) the port is open to the whole internet:
# the CLI warns on stderr and, in a terminal, asks to confirm (-y/--yes skips it).
krova tcp rm <cube> <mapping-id>
```

## Backups

A backup is a Cube's disk and configuration, kept after the Cube is gone. A backup is named or given by ID.

```sh
krova backups list
krova backups get nightly
krova backups download nightly     # prints a link valid for 15 minutes; anyone holding it can download the disk

# Offer another space its own copy. It has 48 hours to accept, and pays for its copy from then.
krova backups share nightly <destination-space-id>
krova backups shares               # pending shares into and out of this space
krova backups accept <share-id>    # in the destination space
krova backups decline <share-id>
krova backups cancel <share-id>    # withdraw one this space offered
```

These need the Backups permissions on the key's member: View Backups for `list`, `get` and `shares`, Manage Backups for the rest. Accepting or declining also works for the destination space's owner.

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

## Updating

```sh
krova update    # check npm for a newer CLI and print the install command
```

`krova update` asks the npm registry for the latest `@krovacloud/cli` and compares it with the version you have. It never installs anything: when a newer release exists it prints the exact `npm install -g @krovacloud/cli@latest` command to run. `--json` prints `{ "current", "latest", "updateAvailable", "command" }`. If the registry cannot be read, it exits 1 and changes nothing.

To use an npm mirror, set `KROVA_NPM_REGISTRY` to its base URL (default `https://registry.npmjs.org`), for example `KROVA_NPM_REGISTRY=https://npm.example.com krova update`.

## Global flags

Available on every command (flag > env var > context):

| Flag | Env | Purpose |
| --- | --- | --- |
| `--api-key <key>` | `KROVA_API_KEY` | API key |
| `--space <id>` | `KROVA_SPACE_ID` | Space ID (else auto-detected) |
| `--base-url <url>` | `KROVA_BASE_URL` | override the API base URL |
| `--context <name>` | `KROVA_CONTEXT` | select a named context |
| `--json` | | machine-readable JSON output |
| `-o, --output <format>` | | `table` (default) or `json`; `-o json` is the same as `--json` |
| `--timeout <dur>` | | per-request timeout (e.g. `30s`); defaults to `30s` |

When a command fails, `krova` prints the error and, for a 401, 403, 404, 409, 429, 5xx or a connection failure, one line on what to try next. With `--json` (or `-o json`) errors stay exactly as they are, with no extra line.

## Shell completion

```sh
krova completion bash > ~/.local/share/bash-completion/completions/krova
krova completion zsh > "${fpath[1]}/_krova"      # needs compinit in ~/.zshrc
krova completion fish > ~/.config/fish/completions/krova.fish
```

Restart your shell afterward. The script lists the commands, subcommands, aliases and flags of the version you have installed, so run it again after you upgrade. In bash and zsh you can also add `source <(krova completion bash)` or `source <(krova completion zsh)` to your shell's startup file (zsh: after `compinit`).

## License

MIT
