# @krovacloud/mcp

[![npm version](https://img.shields.io/npm/v/@krovacloud/mcp)](https://www.npmjs.com/package/@krovacloud/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@krovacloud/mcp)](https://www.npmjs.com/package/@krovacloud/mcp)
[![license](https://img.shields.io/npm/l/@krovacloud/mcp)](./LICENSE)
[![Node](https://img.shields.io/node/v/@krovacloud/mcp)](https://nodejs.org)

> **MCP server for [Krova Cloud](https://krova.cloud) — let Claude, Cursor, and any MCP client provision and manage Cubes (Firecracker microVMs) in natural language.**

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Krova Cloud as a set of tools an AI agent can call. Ask Claude to "spin up a 2-vCPU Ubuntu cube in us", "list my running cubes", or "power off the idle ones", and it drives the [Krova Cloud API](https://krova.cloud) for you.

It's a thin, fully typed bridge over the official [`@krovacloud/sdk`](https://www.npmjs.com/package/@krovacloud/sdk): each Krova Cloud operation is an MCP tool with a validated input schema, authenticated with your API key.

## Quickstart

The fastest way to try it — no install, no clone:

```bash
KROVA_API_KEY=kro_... npx -y @krovacloud/mcp
```

The server speaks MCP over **stdio**, so you normally don't run it by hand — your MCP client launches it with that command. Pick your client below.

## Client setup

All clients use the same launch command (`npx -y @krovacloud/mcp`) and the same environment variables. Set at least `KROVA_API_KEY`; set `KROVA_SPACE_ID` too if you want the Cube tools to default to one Space.

### Claude Desktop

Edit `claude_desktop_config.json` (**Settings → Developer → Edit Config**, or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS / `%APPDATA%\Claude\claude_desktop_config.json` on Windows) and add:

```json
{
  "mcpServers": {
    "krova": {
      "command": "npx",
      "args": ["-y", "@krovacloud/mcp"],
      "env": {
        "KROVA_API_KEY": "kro_your_api_key_here",
        "KROVA_SPACE_ID": "space_optional_default"
      }
    }
  }
}
```

Restart Claude Desktop. The Krova Cloud tools appear under the tools (🔨) menu.

### Claude Code

Add the server with one command:

```bash
claude mcp add krova \
  --env KROVA_API_KEY=kro_your_api_key_here \
  --env KROVA_SPACE_ID=space_optional_default \
  -- npx -y @krovacloud/mcp
```

Or add it to `.mcp.json` in your project root (checked in, shared with your team):

```json
{
  "mcpServers": {
    "krova": {
      "command": "npx",
      "args": ["-y", "@krovacloud/mcp"],
      "env": {
        "KROVA_API_KEY": "kro_your_api_key_here",
        "KROVA_SPACE_ID": "space_optional_default"
      }
    }
  }
}
```

Verify with `claude mcp list`.

### Cursor

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "krova": {
      "command": "npx",
      "args": ["-y", "@krovacloud/mcp"],
      "env": {
        "KROVA_API_KEY": "kro_your_api_key_here",
        "KROVA_SPACE_ID": "space_optional_default"
      }
    }
  }
}
```

Then enable the **krova** server in **Cursor Settings → MCP**.

### Any other MCP client

Any client that speaks MCP over stdio works — launch `npx -y @krovacloud/mcp` with the environment variables set. The config shape above is portable across VS Code (Copilot), Windsurf, Zed, and custom agents built on the MCP SDK.

## Configuration

The server is configured entirely through environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `KROVA_API_KEY` | **yes** | Your Krova Cloud API key (`kro_...`). Scoped to a Space; inherits the permissions of the membership that created it. |
| `KROVA_SPACE_ID` | no | A default Space id, so Cube tools can omit `spaceId`. |
| `KROVA_BASE_URL` | no | Override the API base URL (defaults to the Krova Cloud production API). |

## Tools

All 23 tools, their parameters, and what they do. Every tool's `spaceId` is optional when `KROVA_SPACE_ID` is set.

| Tool | Parameters | Description |
| --- | --- | --- |
| `list_cubes` | `spaceId?` | List all Cubes (Firecracker microVMs) in a Space. |
| `get_cube` | `spaceId?`, `cubeId` | Get details for a single Cube by id. |
| `get_cube_ssh` | `spaceId?`, `cubeId` | Host, port, **login user** and pinned host keys for SSH. Call this rather than guessing a username — it is `ubuntu`/`debian` on newer Cubes and `root` on older ones, and cannot be derived from the image id. |
| `create_cube` | `spaceId?`, `name`, `image`, `vcpu`, `ramGb`, `diskGb`, `sshPublicKey`, `region?`, `userData?` | Provision a new Cube. Asynchronous — the returned Cube starts in a pending state. **Billable. Destructive.** |
| `power_off_cube` | `spaceId?`, `cubeId` | Power off a running Cube (releases compute + host RAM, keeps disk). Asynchronous. |
| `wake_cube` | `spaceId?`, `cubeId` | Start a stopped Cube. Asynchronous. |
| `restart_cube` | `spaceId?`, `cubeId` | Restart a **running** Cube. This is a COLD restart — the Cube boots against the host's current kernel, so it is the only way to pick up a refreshed guest kernel (a `reboot` issued inside the Cube cannot, and reports no error). Disk state is preserved. Asynchronous; a concurrent restart is rejected, not queued. |
| `delete_cube` | `spaceId?`, `cubeId` | Delete a Cube. Asynchronous — deletion is enqueued. **Destructive.** |
| `list_regions` | — | List regions with available capacity. |
| `list_images` | — | List available OS images for new Cubes. |
| `get_pricing` | — | Get per-resource hourly rates and volume pricing tiers. |
| `list_domains` | `spaceId?`, `cubeId` | List the custom domains attached to a Cube. |
| `get_domain_records` | `spaceId?`, `cubeId`, `mappingId` | The DNS records a domain needs, each checked against live DNS — `missing` means not published yet (expected before the user creates them, never an error), and `summary.complete` turns true once every record is found. Performs real DNS lookups; rate limited. |
| `create_domain` | `spaceId?`, `cubeId`, `domain`, `port`, `originScheme?` | Attach a custom domain to a Cube. Returns the domain **and** the DNS records to publish — relay them verbatim. |
| `update_domain` | `spaceId?`, `cubeId`, `mappingId`, `originScheme` | Change a domain's proxy settings. |
| `delete_domain` | `spaceId?`, `cubeId`, `mappingId` | Detach a custom domain. **Destructive.** |
| `list_snapshots` | `spaceId?`, `cubeId` | List a Cube's disk snapshots. |
| `create_snapshot` | `spaceId?`, `cubeId`, `name?` | Snapshot a Cube's disk. Asynchronous. |
| `delete_snapshot` | `spaceId?`, `cubeId`, `snapshotId` | Delete a snapshot. **Destructive.** |
| `restore_cube` | `spaceId?`, `cubeId`, `snapshotId` | Restore a Cube's disk from a snapshot — **replaces the disk. Destructive.** |
| `list_tcp_mappings` | `spaceId?`, `cubeId` | List a Cube's TCP port mappings. |
| `create_tcp_mapping` | `spaceId?`, `cubeId`, `cubePort`, `whitelistIps?` | Expose a Cube TCP port on the host. |
| `delete_tcp_mapping` | `spaceId?`, `cubeId`, `mappingId` | Remove a TCP port mapping. **Destructive.** |

Every tool advertises MCP **annotations** so your client can treat them appropriately: the **ten** read tools (`list_cubes`, `get_cube`, `get_cube_ssh`, `list_regions`, `list_images`, `get_pricing`, `list_domains`, `get_domain_records`, `list_snapshots`, `list_tcp_mappings`) are marked read-only, while the **six** destructive tools (`create_cube`, `delete_cube`, `delete_domain`, `delete_snapshot`, `restore_cube`, `delete_tcp_mapping`) are marked **destructive**. `update_domain` mutates but is idempotent and reversible, so it is not. Most MCP clients surface a confirmation prompt before running a destructive tool — keep that confirmation on, since an LLM driven by untrusted content could be induced to call one.

### `create_cube` parameters

| Param | Type | Notes |
| --- | --- | --- |
| `name` | string | Human-readable Cube name. |
| `image` | string | OS image slug — see `list_images`. `ubuntu-24.04`, `ubuntu-24.04-docker`, `debian-13` or `debian-13-docker`. |
| `region` | string? | Optional region slug — see `list_regions`. Omit to let Krova Cloud auto-select a region with capacity. |
| `vcpu` | integer | Number of virtual CPUs. Default per-space cap 16 (can be raised for your space). |
| `ramGb` | integer | RAM in whole GiB. Default per-space cap 32 GB (raisable for your space). |
| `diskGb` | integer | Disk in GiB — minimum 10, in steps of 5. Default per-space cap 100 GB (raisable for your space). |
| `sshPublicKey` | string | Written to `/root/.ssh/authorized_keys` at boot (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-*`, …). Required by the API. |
| `userData` | string? | Optional cloud-init script (**max 16 KiB, enforced**). |

Successful calls return the API's JSON response as text; API errors surface as an MCP error result carrying the HTTP status, the API message, and a request id when available.

## Authentication

You need a Krova Cloud API key. Create one from your Space settings in the [Krova Cloud dashboard](https://krova.cloud) — keys are **scoped per Space**, inherit the permissions of the membership that created them, and look like `kro_...`.

Never commit your key or paste it into logs, issues, or chats. Rotate any key you believe has been exposed. See [SECURITY.md](https://github.com/krovacloud/krova-node/blob/main/SECURITY.md).

## Requirements

- **Node.js ≥ 18** (the underlying SDK uses the global `fetch`).
- An MCP-capable client (Claude Desktop, Claude Code, Cursor, or your own agent).

## Related packages

Part of the Krova Cloud developer toolkit:

- [`@krovacloud/sdk`](https://www.npmjs.com/package/@krovacloud/sdk) — the official TypeScript SDK this server is built on.
- [Krova Cloud docs & dashboard](https://krova.cloud) — hosted API docs, the OpenAPI spec, and where you obtain API keys.

## Contributing

See [CONTRIBUTING.md](https://github.com/krovacloud/krova-node/blob/main/CONTRIBUTING.md). The tool registry in `src/tools.ts` is the single source of truth — add a `defineTool(...)`, cover it in `tests/`, and update the table above. Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before opening a PR.

## License

[MIT](./LICENSE) © 2026 Krova Inc.
