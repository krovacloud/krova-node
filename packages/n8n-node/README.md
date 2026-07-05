# n8n-nodes-krova

[![npm version](https://img.shields.io/npm/v/n8n-nodes-krova)](https://www.npmjs.com/package/n8n-nodes-krova)
[![npm downloads](https://img.shields.io/npm/dm/n8n-nodes-krova)](https://www.npmjs.com/package/n8n-nodes-krova)
[![license](https://img.shields.io/npm/l/n8n-nodes-krova)](./LICENSE)

Provision and manage **Krova Cloud** Cubes — and read the platform catalog — straight from your [n8n](https://n8n.io) workflows.

[Krova Cloud](https://krova.cloud) is a self-service cloud platform for running lightweight **Cubes** (Firecracker microVMs) on dedicated bare-metal servers. This community node wraps the Krova Cloud REST API so you can create, sleep, wake, list, and delete Cubes and query regions, images, and pricing — no glue code, no HTTP Request nodes.

[Installation](#installation) · [Credential setup](#credential-setup) · [Operations](#operations) · [Example workflow](#example-workflow) · [Compatibility](#compatibility) · [Related packages](#related-packages) · [Resources](#resources)

## Installation

Install this node from within n8n — no CLI, no server restart:

1. Open **Settings → Community Nodes**.
2. Select **Install**.
3. Enter the package name **`n8n-nodes-krova`** (or the scoped alias **`@krovacloud/n8n-nodes-krova`** — identical contents).
4. Acknowledge the community-node risk prompt and select **Install**.

The **Krova Cloud** node appears in the node panel immediately after install. For self-hosted / manual setups, see the official [community-nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credential setup

Every operation authenticates with a **Krova Cloud API** credential.

1. Get an API key: sign in at **[krova.cloud](https://krova.cloud)**, open your Space, and create an API key. Keys are scoped per Space and inherit the permissions of the membership that created them. They look like `kro_...`.
2. In n8n, add a new **Krova Cloud API** credential.
3. Paste the key into **API Key** — it is sent to the API in the `X-API-KEY` header and stored encrypted by n8n.
4. Leave **Base URL** at its default `https://krova.cloud/api/v1` (override only for self-hosted or test endpoints).
5. Click **Test**. n8n calls `GET /regions` to confirm the key and endpoint are reachable.

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| **API Key** | Yes | — | A `kro_...` key from your Space. Sent as the `X-API-KEY` header. |
| **Base URL** | No | `https://krova.cloud/api/v1` | Change only for self-hosted or test endpoints. |

## Operations

### Cube

Cubes are scoped to a **Space**, so every Cube operation takes a **Space ID**.

| Operation | Fields | Description | Endpoint |
| --- | --- | --- | --- |
| **List** | Space ID | List all Cubes in a Space | `GET /spaces/{spaceId}/cubes` |
| **Get** | Space ID, Cube ID | Retrieve a single Cube by ID | `GET /spaces/{spaceId}/cubes/{cubeId}` |
| **Create** | Space ID, Name, Image, SSH Public Key, vCPU, RAM (GB), Disk (GB); optional Region, User Data | Create a new Cube in a Space | `POST /spaces/{spaceId}/cubes` |
| **Sleep** | Space ID, Cube ID | Sleep a running Cube — preserves data, stops compute billing | `POST /spaces/{spaceId}/cubes/{cubeId}/sleep` |
| **Wake** | Space ID, Cube ID | Wake a sleeping Cube | `POST /spaces/{spaceId}/cubes/{cubeId}/wake` |
| **Delete** | Space ID, Cube ID | Delete a Cube (asynchronous) | `DELETE /spaces/{spaceId}/cubes/{cubeId}` |

#### Create field notes

- **Image** — an OS image slug or ID. Fetch valid values from **Catalog → Get Images**.
- **SSH Public Key** — written to `/root/.ssh/authorized_keys` at boot. Must start with `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-*`, `ssh-dss`, or `sk-*@openssh.com`.
- **vCPU / RAM (GB) / Disk (GB)** — sent as nested `resources.{vcpu,ramGb,diskGb}`. Actual ceilings depend on your Space tier and host capacity.
- **Region** (optional) — a region slug from **Catalog → Get Regions**. Leave empty to auto-select.
- **User Data** (optional) — a cloud-init script run at first boot (max 16 KB).

### Catalog

Public read endpoints. The API key is still sent but is not required for these.

| Operation | Fields | Description | Endpoint |
| --- | --- | --- | --- |
| **Get Regions** | — | List regions with available capacity | `GET /regions` |
| **Get Images** | — | List available OS images | `GET /images` |
| **Get Pricing** | — | Per-resource hourly rates and volume pricing tiers | `GET /pricing` |

Each operation returns the raw Krova Cloud API response, ready to reference downstream with n8n expressions.

## Example workflow

**Provision a Cube every morning, sleep it every night — pay only for the hours you use.**

1. **Schedule Trigger** (`0 8 * * *`) → **Krova Cloud** — Resource *Catalog*, Operation *Get Images* — to resolve the image slug you want to boot.
2. **Krova Cloud** — Resource *Cube*, Operation *Create*. Set the Space ID, a Name, the Image slug from step 1, your SSH Public Key, and `vCPU` / `RAM (GB)` / `Disk (GB)`. The response contains the new Cube's ID.
3. A second **Schedule Trigger** (`0 20 * * *`) → **Krova Cloud** — Resource *Cube*, Operation *List* → **Filter** for the Cubes you want idle → **Krova Cloud** — Operation *Sleep* on each Cube ID.

Because a sleeping Cube keeps its disk but stops compute billing, this pattern gives you an ephemeral-by-day, zero-compute-by-night box driven entirely from n8n. Swap *Sleep* for *Delete* if you want it torn down instead of parked.

## Compatibility

- Requires an n8n instance with the community-nodes feature enabled.
- Built and tested against `n8n-workflow` 2.x and Node.js **20.15+**.

## Related packages

Krova Cloud ships first-party tooling across the ecosystem:

- **[@krovacloud/sdk](https://www.npmjs.com/package/@krovacloud/sdk)** — official TypeScript/JavaScript SDK.
- **[@krovacloud/mcp](https://www.npmjs.com/package/@krovacloud/mcp)** — Model Context Protocol server for AI agents.
- **[@krovacloud/webhook](https://www.npmjs.com/package/@krovacloud/webhook)** — HMAC signature verification for Krova webhooks.
- **[@krovacloud/n8n-nodes-krova](https://www.npmjs.com/package/@krovacloud/n8n-nodes-krova)** — the scoped alias of this exact package.

## Resources

- [Krova Cloud](https://krova.cloud)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Report an issue](https://github.com/krovacloud/n8n-nodes-krova/issues)
- [Changelog](./CHANGELOG.md)

## License

[MIT](./LICENSE) © Krova Inc.
