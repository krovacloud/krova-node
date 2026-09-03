import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { type Cube, KrovaClient, KrovaError } from "../src/index.js";

/**
 * A minimal mock of the Krova Cloud API. Each test installs a handler that
 * receives the request (with its collected body) and writes a response.
 */
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // Include a path prefix so we also prove the full baseUrl (incl. path) is honored.
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

test("sends the X-API-KEY auth header", async () => {
  let seenKey: string | undefined;
  let seenPath: string | undefined;
  handler = (req, res) => {
    seenKey = req.headers["x-api-key"] as string | undefined;
    seenPath = req.url;
    json(res, 200, { data: [] });
  };

  const client = new KrovaClient({ apiKey: "kro_test_secret", baseUrl });
  await client.cubes.list("space_abc");

  assert.equal(seenKey, "kro_test_secret", "X-API-KEY header must carry the api key");
  assert.equal(seenPath, "/api/v1/spaces/space_abc/cubes", "path incl. baseUrl prefix");
});

test("sends Authorization: Bearer when authScheme is 'bearer'", async () => {
  let seenAuth: string | undefined;
  handler = (req, res) => {
    seenAuth = req.headers.authorization;
    json(res, 200, { data: [] });
  };

  const client = new KrovaClient({
    apiKey: "kro_bearer_key",
    baseUrl,
    authScheme: "bearer",
  });
  await client.cubes.list("space_abc");

  assert.equal(seenAuth, "Bearer kro_bearer_key");
});

test("cubes.list unwraps the response `data`", async () => {
  const payload = { data: [{ id: "cube_1", name: "web" }], total: 1 };
  handler = (_req, res) => json(res, 200, payload);

  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const result = await client.cubes.list("space_abc");

  assert.deepEqual(result, payload, "helper returns the parsed JSON body");
});

test("cubes.create returns the created cube from { cube }", async () => {
  const cube = {
    id: "cube_new",
    name: "api",
    state: "pending",
    publicIpv4: null,
    resources: { vcpu: 2, ramGb: 2, diskGb: 20 },
    image: "ubuntu-24.04",
    costPerHour: 0.05,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
  let seenBody: unknown;
  let seenIdemKey: string | undefined;
  handler = (req, res, body) => {
    seenBody = JSON.parse(body);
    seenIdemKey = req.headers["idempotency-key"] as string | undefined;
    json(res, 201, { cube });
  };

  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const created = await client.cubes.create(
    "space_abc",
    {
      name: "api",
      image: "ubuntu-24.04",
      resources: { vcpu: 2, ramGb: 2, diskGb: 20 },
      sshPublicKey: "ssh-ed25519 AAAA...",
    },
    { idempotencyKey: "idem-123" },
  );

  assert.deepEqual(created, cube);
  assert.deepEqual(seenBody, {
    name: "api",
    image: "ubuntu-24.04",
    resources: { vcpu: 2, ramGb: 2, diskGb: 20 },
    sshPublicKey: "ssh-ed25519 AAAA...",
  });
  assert.equal(seenIdemKey, "idem-123", "Idempotency-Key header forwarded");
});

test("non-2xx throws KrovaError with the right status, message, code, requestId", async () => {
  handler = (_req, res) => {
    res.writeHead(403, {
      "content-type": "application/json",
      "x-error-code": "forbidden",
      "x-request-id": "req_789",
    });
    res.end(JSON.stringify({ error: "Authenticated but lacks the required permission" }));
  };

  const client = new KrovaClient({ apiKey: "kro_x", baseUrl, maxRetries: 0 });
  await assert.rejects(
    () => client.cubes.list("space_abc"),
    (err: unknown) => {
      assert.ok(err instanceof KrovaError, "throws a KrovaError");
      const e = err as KrovaError;
      assert.equal(e.status, 403);
      assert.equal(e.message, "Authenticated but lacks the required permission");
      assert.equal(e.code, "forbidden");
      assert.equal(e.requestId, "req_789");
      assert.deepEqual(e.body, {
        error: "Authenticated but lacks the required permission",
      });
      return true;
    },
  );
});

test("baseUrl override is respected (requests hit the mock, not krova.cloud)", async () => {
  let hit = false;
  handler = (_req, res) => {
    hit = true;
    json(res, 200, { regions: [] });
  };

  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  assert.equal(client.baseUrl, baseUrl);
  const regions = await client.catalog.regions();

  assert.ok(hit, "the mock server received the request");
  assert.deepEqual(regions, { regions: [] });
});

test("retries once on 429 honoring Retry-After, then succeeds", async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: "Rate limit exceeded" }));
      return;
    }
    json(res, 200, { data: [] });
  };

  const client = new KrovaClient({ apiKey: "kro_x", baseUrl, maxRetries: 2 });
  const result = await client.cubes.list("space_abc");

  assert.equal(calls, 2, "one retry after the 429");
  assert.deepEqual(result, { data: [] });
});

test("retries a POST (with a body) and re-sends the body on the retry", async () => {
  // Regression: a retried request that has a body used to throw
  // `TypeError: unusable` — the fetched request's body stream was already
  // consumed, so cloning it in the retry path failed. The mutating POST/DELETE
  // endpoints are exactly the ones the API rate-limits + we auto-retry.
  const bodies: string[] = [];
  let calls = 0;
  handler = (_req, res, body) => {
    calls += 1;
    bodies.push(body);
    if (calls === 1) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: "temporarily unavailable" }));
      return;
    }
    json(res, 201, {
      cube: {
        id: "cube_1",
        name: "web-server",
        state: "pending",
        publicIpv4: null,
        resources: { vcpu: 2, ramGb: 4, diskGb: 40 },
        image: "ubuntu-24.04",
        costPerHour: 0.08,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
      },
    });
  };

  const client = new KrovaClient({ apiKey: "kro_x", baseUrl, maxRetries: 2 });
  const cube = await client.cubes.create("space_abc", {
    name: "web-server",
    image: "ubuntu-24.04",
    resources: { vcpu: 2, ramGb: 4, diskGb: 40 },
    sshPublicKey: "ssh-ed25519 AAAA... you@host",
  });

  assert.equal(calls, 2, "one retry after the 503");
  assert.equal(cube.id, "cube_1");
  // The body must be present AND identical on both the first attempt and the retry.
  assert.ok(bodies[0]?.includes("web-server"), "first attempt sent the body");
  assert.equal(bodies[1], bodies[0], "retry re-sent the exact same body");
});

test("caps a hostile Retry-After so the client can't be parked for hours", async () => {
  // A huge Retry-After must be clamped to MAX_BACKOFF_MS (10s), not obeyed
  // literally. We assert the call completes quickly rather than hanging.
  let calls = 0;
  handler = (_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "86400" });
      res.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    json(res, 200, { data: [] });
  };

  const client = new KrovaClient({ apiKey: "kro_x", baseUrl, maxRetries: 1 });
  const started = Date.now();
  await client.cubes.list("space_abc");
  const elapsed = Date.now() - started;

  assert.equal(calls, 2, "one retry");
  assert.ok(elapsed < 11_000, `retry waited ${elapsed}ms — Retry-After was not capped`);
});

test("README quickstart flow compiles and runs (create → id/status → power-off → start)", async () => {
  const created = {
    id: "cube_readme",
    name: "web-server",
    state: "pending",
    publicIpv4: null,
    resources: { vcpu: 2, ramGb: 4, diskGb: 40 },
    image: "ubuntu-24.04",
    costPerHour: 0.08,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
  const seenMethods: string[] = [];
  handler = (req, res) => {
    seenMethods.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url?.endsWith("/cubes")) {
      json(res, 201, { cube: created });
      return;
    }
    json(res, 202, { ok: true });
  };

  const krova = new KrovaClient({ apiKey: "kro_x", baseUrl });

  const cube = await krova.cubes.create("space_123", {
    name: "web-server",
    image: "ubuntu-24.04",
    resources: { vcpu: 2, ramGb: 4, diskGb: 40 },
    sshPublicKey: "ssh-ed25519 AAAA...your-key... you@host",
  });

  // The README does `cube.id` and `cube.state` directly — these MUST be
  // non-optional on the returned `Cube` (the spec's `Cube.required` guards it).
  // `satisfies string` fails to compile if `id` ever regresses to `string | undefined`.
  const cubeId = cube.id satisfies string;
  const state: string = cube.state;
  // `resources` is a required nested object on the corrected `Cube` shape.
  const vcpu: number = cube.resources.vcpu;
  assert.equal(cubeId, "cube_readme");
  assert.equal(state, "pending");
  assert.equal(vcpu, 2);

  await krova.cubes.powerOff("space_123", cube.id);
  await krova.cubes.wake("space_123", cube.id);

  assert.deepEqual(seenMethods, [
    "POST /api/v1/spaces/space_123/cubes",
    "POST /api/v1/spaces/space_123/cubes/cube_readme/power-off",
    "POST /api/v1/spaces/space_123/cubes/cube_readme/wake",
  ]);
});

test("list/get/catalog responses are typed (not unknown)", async () => {
  const sampleCube = {
    id: "cube_typed",
    name: "typed",
    state: "running",
    publicIpv4: "1.2.3.4",
    resources: { vcpu: 1, ramGb: 1, diskGb: 10 },
    image: "ubuntu-24.04",
    sshUser: "ubuntu",
    costPerHour: 0.01,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies Cube;

  const krova = new KrovaClient({ apiKey: "kro_test", baseUrl });

  // get → unwrapped Cube. The `satisfies` lines fail to compile if the return
  // type ever regresses to `unknown`.
  handler = (_req, res) => json(res, 200, { cube: sampleCube });
  const cube = await krova.cubes.get("space_1", "cube_typed");
  assert.deepEqual(cube, sampleCube);
  cube.id satisfies string;
  cube.resources.vcpu satisfies number;

  // list → { cubes: Cube[]; pagination }.
  handler = (_req, res) =>
    json(res, 200, {
      cubes: [sampleCube],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
  const listed = await krova.cubes.list("space_1");
  assert.equal(listed.cubes.length, 1);
  const firstCube = listed.cubes[0];
  assert.ok(firstCube);
  firstCube.id satisfies string;
  listed.pagination.total satisfies number;

  // catalog.pricing → typed envelope with PricingTier[].
  handler = (_req, res) =>
    json(res, 200, {
      currency: "USD",
      rates: { vcpuPerHour: 1, ramGbPerHour: 1, diskGbPerHour: 1 },
      tiers: [{ minVcpus: 1, maxVcpus: 2, multiplier: 1, label: "Standard" }],
      note: "n",
    });
  const pricing = await krova.catalog.pricing();
  pricing.currency satisfies string;
  const firstTier = pricing.tiers[0];
  assert.ok(firstTier);
  firstTier.multiplier satisfies number;
  assert.equal(firstTier.label, "Standard");

  // catalog.images → { images: Image[] }.
  handler = (_req, res) =>
    json(res, 200, {
      images: [
        {
          id: "ubuntu-24.04",
          name: "Ubuntu 24.04",
          version: "24.04",
          description: "Ubuntu 24.04 (Debian-based)",
        },
      ],
    });
  const images = await krova.catalog.images();
  const firstImage = images.images[0];
  assert.ok(firstImage);
  firstImage.id satisfies string;
  assert.equal(firstImage.version, "24.04");
});

test("getSpace resolves the Space the key is scoped to", async () => {
  handler = (req, res) => {
    assert.equal(req.url, "/api/v1/space", "hits GET /space");
    json(res, 200, {
      id: "space_1",
      name: "Prod",
      tier: "tier_2",
      createdAt: "2026-07-01T00:00:00Z",
    });
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const space = await client.getSpace();
  assert.equal(space.id, "space_1");
  assert.equal(space.name, "Prod");
});

test("cubes.ssh returns a Cube's SSH connection info", async () => {
  handler = (req, res) => {
    assert.equal(req.url, "/api/v1/spaces/space_1/cubes/cube_1/ssh", "hits the ssh endpoint");
    json(res, 200, { host: "1.2.3.4", port: 2222, user: "root", hostKeys: [] });
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const ssh = await client.cubes.ssh("space_1", "cube_1");
  assert.equal(ssh.host, "1.2.3.4");
  assert.equal(ssh.port, 2222);
  assert.equal(ssh.user, "root");
});

test("domains.list unwraps { domains }; create returns the domain AND its records", async () => {
  handler = (req, res) => {
    if (req.method === "GET") {
      assert.equal(req.url, "/api/v1/spaces/s1/cubes/c1/domains");
      json(res, 200, { domains: [{ id: "dom_1", domain: "app.example.com" }] });
    } else {
      assert.equal(req.url, "/api/v1/spaces/s1/cubes/c1/domains");
      json(res, 201, {
        domain: { id: "dom_2", domain: "api.example.com" },
        records: [
          {
            id: "routing",
            type: "CNAME",
            host: "api.example.com",
            value: "dns.krova.cloud",
            purpose: "routing",
            mustBeGrey: false,
            proxyOk: true,
          },
        ],
      });
    }
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const list = await client.domains.list("s1", "c1");
  assert.equal(list[0]?.id, "dom_1");
  const created = await client.domains.create("s1", "c1", { domain: "api.example.com", port: 8080 });
  assert.equal(created.domain.id, "dom_2");
  // The whole point of the 0.4.0 change: the caller can publish DNS straight
  // away instead of making a second call or hard-coding record shapes.
  assert.equal(created.records[0]?.host, "api.example.com");
  assert.equal(created.records[0]?.value, "dns.krova.cloud");
});

test("domains.create tolerates a server that sends no records", async () => {
  // Defensive: an older control plane, or a response shape that changes again,
  // must not make `create` throw — the domain was still created.
  handler = (_req, res) => {
    json(res, 201, { domain: { id: "dom_3", domain: "x.example.com" } });
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const created = await client.domains.create("s1", "c1", { domain: "x.example.com", port: 80 });
  assert.equal(created.domain.id, "dom_3");
  assert.deepEqual(created.records, []);
});

test("domains.records returns each record with its live state", async () => {
  handler = (req, res) => {
    assert.equal(req.url, "/api/v1/spaces/s1/cubes/c1/domains/dom_9/records");
    json(res, 200, {
      domain: "*.example.com",
      isWildcard: true,
      records: [
        {
          id: "certificate",
          type: "CNAME",
          host: "_acme-challenge.example.com",
          value: "tok.acme.krova.cloud",
          purpose: "certificate",
          mustBeGrey: true,
          proxyOk: false,
          state: "missing",
          detail: "Not found yet. Add this record, then check again.",
        },
      ],
      summary: { found: 0, total: 1, complete: false },
      checkedAt: "2026-08-27T00:00:00.000Z",
    });
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const out = await client.domains.records("s1", "c1", "dom_9");
  assert.equal(out.summary.complete, false);
  assert.equal(out.records[0]?.state, "missing");
  // ⛔ Both Cloudflare flags reach the caller. They are opposites, and an
  // integration that saw only one could orange-cloud the record that must
  // stay grey.
  assert.equal(out.records[0]?.mustBeGrey, true);
  assert.equal(out.records[0]?.proxyOk, false);
});

test("snapshots.create unwraps { snapshot } and list unwraps { snapshots }", async () => {
  handler = (req, res) => {
    if (req.method === "GET") json(res, 200, { snapshots: [{ id: "snap_1", name: "nightly" }] });
    else json(res, 201, { snapshot: { id: "snap_2", name: "manual" } });
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  assert.equal((await client.snapshots.list("s1", "c1"))[0]?.id, "snap_1");
  assert.equal((await client.snapshots.create("s1", "c1", { name: "manual" })).id, "snap_2");
});

test("tcpMappings.create unwraps { tcpMapping }", async () => {
  handler = (req, res) => {
    assert.equal(req.url, "/api/v1/spaces/s1/cubes/c1/tcp-mappings");
    json(res, 201, { tcpMapping: { id: "tcp_1", cubePort: 5432, hostPort: 15432 } });
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const m = await client.tcpMappings.create("s1", "c1", { cubePort: 5432 });
  assert.equal(m.id, "tcp_1");
  assert.equal(m.hostPort, 15432);
});

test("cubes.restore posts the snapshotId to the restore endpoint", async () => {
  let seenBody = "";
  handler = (req, res, body) => {
    assert.equal(req.url, "/api/v1/spaces/s1/cubes/c1/restore");
    seenBody = body;
    json(res, 200, { success: true });
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  await client.cubes.restore("s1", "c1", "snap_1");
  assert.ok(seenBody.includes("snap_1"), "restore sends the snapshotId");
});

test("backups.download returns the signed URL body", async () => {
  handler = (req, res) => {
    assert.equal(req.url, "/api/v1/spaces/s1/backups/bak_1/download");
    json(res, 200, { url: "https://x/y", filename: "cube.cube", sizeBytes: 10, expiresAt: "2026-07-05T00:00:00Z" });
  };
  const client = new KrovaClient({ apiKey: "kro_x", baseUrl });
  const dl = await client.backups.download("s1", "bak_1");
  assert.equal(dl?.filename, "cube.cube");
});

/**
 * ⛔ Regression lock for the allow-list field name.
 *
 * The published OpenAPI spec named this request field `whitelistIps` while the
 * server has always read `whitelistedIps`. Every IP-restricted mapping created
 * through this SDK — and through the CLI and MCP server that wrap it — was
 * therefore created **publicly reachable**: the server saw no allow-list,
 * skipped the CIDR block entirely, and still answered 201.
 *
 * Reproduced live on production 2026-09-02: a mapping added with
 * `--whitelist 203.0.113.0/24` served content to an address outside that CIDR.
 *
 * This asserts the WIRE body, not the TypeScript type. A type-level check
 * would have passed throughout the entire period the bug existed — the types
 * were generated from the same wrong spec, so they agreed with it perfectly.
 */
test("⛔ createTcpMapping sends `whitelistedIps` on the wire", async () => {
  let seenBody: Record<string, unknown> = {};
  handler = (_req, res, body) => {
    seenBody = JSON.parse(body || "{}") as Record<string, unknown>;
    json(res, 201, { tcpMapping: { id: "map_1", cubePort: 8443, hostPort: 30001 } });
  };

  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });
  await client.tcpMappings.create("space_abc", "cube_abc", {
    cubePort: 8443,
    whitelistedIps: ["203.0.113.0/24"],
  });

  assert.deepEqual(
    seenBody.whitelistedIps,
    ["203.0.113.0/24"],
    "the allow-list must go out as `whitelistedIps` — the name the server reads",
  );
  assert.equal(
    seenBody.whitelistIps,
    undefined,
    "the deprecated `whitelistIps` name must not be emitted",
  );
});

test("an omitted allow-list sends no allow-list key at all", async () => {
  // Publishing a port with no allow-list is legitimate and documented — it is
  // open to the internet. What must never happen is the SDK inventing an empty
  // array, which would read as "restrict to nobody" if the server ever changed
  // its handling of `[]`.
  let seenBody: Record<string, unknown> = {};
  handler = (_req, res, body) => {
    seenBody = JSON.parse(body || "{}") as Record<string, unknown>;
    json(res, 201, { tcpMapping: { id: "map_2", cubePort: 80, hostPort: 30002 } });
  };

  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });
  await client.tcpMappings.create("space_abc", "cube_abc", { cubePort: 80 });

  assert.ok(!("whitelistedIps" in seenBody));
  assert.ok(!("whitelistIps" in seenBody));
});
