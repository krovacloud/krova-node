# @krovacloud/sdk

[![npm version](https://img.shields.io/npm/v/@krovacloud/sdk?color=cb3837&logo=npm)](https://www.npmjs.com/package/@krovacloud/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@krovacloud/sdk?color=cb3837&logo=npm)](https://www.npmjs.com/package/@krovacloud/sdk)
[![license: MIT](https://img.shields.io/npm/l/@krovacloud/sdk?color=blue)](./LICENSE)
[![types: included](https://img.shields.io/npm/types/@krovacloud/sdk?logo=typescript)](https://www.typescriptlang.org/)

The official TypeScript SDK for the [Krova Cloud](https://krova.cloud) API — a fully typed client for provisioning and managing **Cubes** (Firecracker microVMs) on dedicated bare-metal servers.

## Highlights

- **Fully typed** — request bodies, responses, and path params are generated from the Krova Cloud OpenAPI spec via [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript) + [`openapi-fetch`](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch).
- **Ergonomic helpers** — `client.cubes.*` and `client.catalog.*` unwrap the response body and throw a typed `KrovaError` on failure.
- **Full escape hatch** — `client.raw` exposes the underlying typed client for *every* operation in the spec (31 operations across 22 resource paths).
- **Zero-config resilience** — automatic retries on `429` / `503`, honoring `Retry-After`.
- **ESM + CJS** — ships both, with bundled `.d.ts` declarations. No runtime dependencies beyond `openapi-fetch`.

## Install

```sh
npm i @krovacloud/sdk
# or: pnpm add @krovacloud/sdk
# or: yarn add @krovacloud/sdk
```

Requires **Node.js ≥ 18** (uses the global `fetch`).

## Quickstart

```ts
import { KrovaClient, KrovaError } from "@krovacloud/sdk";

const krova = new KrovaClient({
  apiKey: process.env.KROVA_API_KEY!, // a "kro_..." token
});

// List Cubes in a Space
const cubes = await krova.cubes.list("space_123");
console.log(cubes);

// Create a Cube (sshPublicKey is required)
const cube = await krova.cubes.create("space_123", {
  name: "web-server",
  image: "ubuntu-24.04",
  resources: { vcpu: 2, ramGb: 4, diskGb: 40 },
  sshPublicKey: "ssh-ed25519 AAAA...your-key... you@host",
});

console.log(`Created cube ${cube.id} (${cube.state})`);
console.log(`  ${cube.resources.vcpu} vCPU / ${cube.resources.ramGb} GB RAM, image ${cube.image}`);

// Sleep it, then wake it
await krova.cubes.sleep("space_123", cube.id);
await krova.cubes.wake("space_123", cube.id);
```

## Authentication

Get an API key at **[krova.cloud](https://krova.cloud)** → your Space settings. Keys are **scoped per Space**, inherit the permissions of the membership that created them, and look like `kro_...`.

By default the client sends the key as the `X-API-KEY` header (the API's security scheme). If your gateway expects a bearer token instead, pass `authScheme: "bearer"`:

```ts
const krova = new KrovaClient({ apiKey: "kro_...", authScheme: "bearer" });
```

> **Keep keys secret.** Never commit a key or embed it in a browser bundle. Load it from an environment variable or a secrets manager.

## API reference

Every public export, with its real signature and a short example.

### `new KrovaClient(options)`

```ts
new KrovaClient({
  apiKey: string,               // required — your "kro_..." token
  baseUrl?: string,             // default: "https://krova.cloud/api/v1"
  authScheme?: "x-api-key" | "bearer", // default: "x-api-key"
  maxRetries?: number,          // default: 2 — retries 429/503 (honors Retry-After); 0 disables
  fetch?: typeof fetch,         // optional fetch override (proxy, tests)
});
```

Throws if `apiKey` is missing. Exposes `client.baseUrl` (the resolved base URL), `client.cubes`, `client.catalog`, and `client.raw`.

### `client.cubes`

Ergonomic helpers for the Cube lifecycle. Each unwraps the response body and throws `KrovaError` on a non-2xx status.

| Method | Signature | Returns |
| --- | --- | --- |
| `list` | `(spaceId: string)` | the Cube list body |
| `create` | `(spaceId, body, opts?)` | the created `Cube` |
| `get` | `(spaceId, cubeId)` | the Cube body |
| `update` | `(spaceId, cubeId, body)` | updates the Cube's SSH port |
| `delete` | `(spaceId, cubeId)` | enqueues deletion |
| `sleep` | `(spaceId, cubeId)` | enqueues sleep |
| `wake` | `(spaceId, cubeId)` | enqueues wake |

```ts
// create — sshPublicKey is required; region + userData (cloud-init) are optional.
// opts.idempotencyKey (≤255 chars, per-space) makes retries safe.
const cube = await krova.cubes.create(
  "space_123",
  {
    name: "web-server",
    image: "ubuntu-24.04",
    resources: { vcpu: 2, ramGb: 4, diskGb: 40 },
    sshPublicKey: "ssh-ed25519 AAAA... you@host",
    region: "us-east",           // optional — slug from catalog.regions()
    userData: "#cloud-config\n",  // optional — cloud-init (max 16 KB)
  },
  { idempotencyKey: "deploy-2026-07-01" },
);

// get / list
const one = await krova.cubes.get("space_123", cube.id);
const all = await krova.cubes.list("space_123");

// update — the only mutable Cube field over the public API is the SSH port
await krova.cubes.update("space_123", cube.id, { cubePort: 2222 });

// lifecycle — sleep, wake, delete are asynchronous (enqueued)
await krova.cubes.sleep("space_123", cube.id);
await krova.cubes.wake("space_123", cube.id);
await krova.cubes.delete("space_123", cube.id);
```

The `Cube` type is exported for your own signatures:

```ts
import type { Cube } from "@krovacloud/sdk";
// {
//   id: string; name: string;
//   state: "pending" | "booting" | "running" | "sleeping" | "stopping" | "error" | "deleted";
//   publicIpv4: string | null;
//   resources: { vcpu: number; ramGb: number; diskGb: number };
//   image: string; costPerHour: number;
//   createdAt: string; updatedAt: string;
// }
```

### `client.catalog`

Public catalog endpoints (no auth required by the API; the client sends your key harmlessly).

```ts
const regions = await krova.catalog.regions(); // regions with available capacity
const images = await krova.catalog.images();   // available OS images
const pricing = await krova.catalog.pricing(); // per-resource hourly rates + volume tiers
```

### `client.raw` — every endpoint

The helpers cover Cubes and the catalog. For everything else — Domains, TCP mappings, Snapshots, Backups, Imports, Webhooks — use `client.raw`, the fully typed [`openapi-fetch`](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch) client. It returns `{ data, error, response }` and **never throws**:

```ts
const { data, error } = await krova.raw.POST("/spaces/{spaceId}/webhooks", {
  params: { path: { spaceId: "space_123" } },
  body: { url: "https://example.com/hook", events: ["cube.running"] },
});

if (error) {
  console.error("Webhook create failed:", error.error);
} else {
  console.log(data);
}
```

Path, method, params, and body are all type-checked against the spec. The generated `paths` and `components` types are also exported for advanced use:

```ts
import type { paths, components } from "@krovacloud/sdk";
type Domain = components["schemas"]["Domain"];
```

### `KrovaError`

Thrown by the `cubes.*` / `catalog.*` helpers on any non-2xx response. (`client.raw` never throws — it returns the error in `{ error }`.)

| Field | Type | Source |
| --- | --- | --- |
| `status` | `number` | HTTP status code |
| `message` | `string` | the API's `error` string, else `statusText` |
| `code` | `string \| undefined` | `X-Error-Code` response header |
| `requestId` | `string \| undefined` | `X-Request-Id` response header |
| `body` | `object \| undefined` | the parsed JSON error body |
| `response` | `Response \| undefined` | the raw `Response` |

```ts
import { KrovaError } from "@krovacloud/sdk";

try {
  await krova.cubes.get("space_123", "cube_missing");
} catch (err) {
  if (err instanceof KrovaError) {
    console.error(`[${err.status}] ${err.message}`);
    if (err.code) console.error("code:", err.code);
    if (err.requestId) console.error("request id:", err.requestId); // quote this to support
  } else {
    throw err;
  }
}
```

Mutating `POST` / `DELETE` endpoints are rate-limited (10 requests / 60s per client IP). The client automatically retries `429` and `503` up to `maxRetries` times, honoring the `Retry-After` header.

## Configuration

Point the client at a different base URL (self-hosted gateway, staging, a proxy):

```ts
const krova = new KrovaClient({
  apiKey: "kro_...",
  baseUrl: "https://gateway.internal/krova/api/v1",
});
```

## TypeScript

The package ships its own type declarations — no `@types/*` install needed. `Cube`, `KrovaError`, `KrovaClientOptions`, `AuthScheme`, and the generated `paths` / `components` are all exported.

## Related packages

| Package | What it is |
| --- | --- |
| [`@krovacloud/cli`](https://www.npmjs.com/package/@krovacloud/cli) | Command-line interface for Krova Cloud |
| [`@krovacloud/webhook`](https://www.npmjs.com/package/@krovacloud/webhook) | Verify and parse Krova Cloud webhook events |
| [`@krovacloud/mcp`](https://www.npmjs.com/package/@krovacloud/mcp) | Model Context Protocol server for Krova Cloud |
| [`n8n-nodes-krova`](https://www.npmjs.com/package/n8n-nodes-krova) | n8n community nodes for Krova Cloud |

## Requirements

- **Node.js ≥ 18** (global `fetch`).
- Works in any modern runtime with a WHATWG `fetch` (Deno, Bun, edge). Pass a custom `fetch` if the global isn't available.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Report security issues privately per [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Krova Inc.
