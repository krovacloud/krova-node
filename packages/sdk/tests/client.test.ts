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

test("README quickstart flow compiles and runs (create → id/status → sleep → wake)", async () => {
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

  await krova.cubes.sleep("space_123", cube.id);
  await krova.cubes.wake("space_123", cube.id);

  assert.deepEqual(seenMethods, [
    "POST /api/v1/spaces/space_123/cubes",
    "POST /api/v1/spaces/space_123/cubes/cube_readme/sleep",
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
