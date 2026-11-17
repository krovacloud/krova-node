import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { KrovaClient, KrovaError } from "../src/index.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
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

const client = () => new KrovaClient({ apiKey: "kro_test", baseUrl });

test("cubes.rename PATCHes { name } and returns the updated Cube", async () => {
  let seen: { method?: string; url?: string; body?: string } = {};
  handler = (req, res, body) => {
    seen = { method: req.method, url: req.url, body };
    json(res, 200, { cube: { id: "cube_1", name: "web-1", status: "running" } });
  };

  const cube = await client().cubes.rename("space_1", "cube_1", "web-1");

  assert.equal(seen.method, "PATCH");
  assert.equal(seen.url, "/api/v1/spaces/space_1/cubes/cube_1");
  assert.deepEqual(JSON.parse(seen.body ?? ""), { name: "web-1" });
  assert.equal(cube.name, "web-1");
});

test("cubes.rename throws KrovaError with the server message on a 400", async () => {
  handler = (_req, res) =>
    json(res, 400, { error: "name is required and must be 1–64 printable characters" });

  await assert.rejects(
    () => client().cubes.rename("space_1", "cube_1", ""),
    (err: unknown) => {
      assert.ok(err instanceof KrovaError);
      assert.equal(err.status, 400);
      assert.match(err.message, /1–64 printable characters/);
      return true;
    },
  );
});

test("cubes.rename throws when the 200 response has no cube", async () => {
  handler = (_req, res) => json(res, 200, {});

  await assert.rejects(() => client().cubes.rename("space_1", "cube_1", "x"), /had no `cube`/);
});

test("cubes.resize POSTs { resources } and returns the live result", async () => {
  let seen: { method?: string; url?: string; body?: string; idem?: string } = {};
  const result = {
    success: true,
    state: "queued",
    jobId: "job_1",
    isLive: true,
    requiresRestart: false,
    previous: { vcpu: 2, ramGb: 2, diskGb: 20 },
    requested: { vcpu: 2, ramGb: 4, diskGb: 20 },
  };
  handler = (req, res, body) => {
    seen = {
      method: req.method,
      url: req.url,
      body,
      idem: req.headers["idempotency-key"] as string | undefined,
    };
    json(res, 200, result);
  };

  const out = await client().cubes.resize("space_1", "cube_1", { ramGb: 4 });

  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/api/v1/spaces/space_1/cubes/cube_1/resize");
  assert.deepEqual(JSON.parse(seen.body ?? ""), { resources: { ramGb: 4 } });
  assert.equal(seen.idem, undefined, "no Idempotency-Key unless asked for");
  assert.deepEqual(out, result);
});

test("cubes.resize sends the Idempotency-Key header and reports requiresRestart", async () => {
  let idem: string | undefined;
  handler = (req, res) => {
    idem = req.headers["idempotency-key"] as string | undefined;
    json(res, 200, {
      success: true,
      state: "queued",
      jobId: "job_2",
      isLive: false,
      requiresRestart: true,
      previous: { vcpu: 2, ramGb: 4, diskGb: 20 },
      requested: { vcpu: 2, ramGb: 2, diskGb: 20 },
    });
  };

  const out = await client().cubes.resize(
    "space_1",
    "cube_1",
    { ramGb: 2 },
    { idempotencyKey: "resize-once" },
  );

  assert.equal(idem, "resize-once");
  assert.equal(out.requiresRestart, true);
  assert.equal(out.isLive, false);
});

test("cubes.resize throws KrovaError on a 400 validation error and a 409", async () => {
  handler = (_req, res) => json(res, 400, { error: "Disk cannot be shrunk. Current disk is 40 GB." });
  await assert.rejects(
    () => client().cubes.resize("space_1", "cube_1", { diskGb: 10 }),
    (err: unknown) => {
      assert.ok(err instanceof KrovaError);
      assert.equal(err.status, 400);
      assert.match(err.message, /Disk cannot be shrunk/);
      return true;
    },
  );

  handler = (_req, res) => json(res, 409, { error: "A resize is already in progress for this Cube." });
  await assert.rejects(
    () => client().cubes.resize("space_1", "cube_1", { vcpu: 4 }),
    (err: unknown) => {
      assert.ok(err instanceof KrovaError);
      assert.equal(err.status, 409);
      return true;
    },
  );
});

test("getSpace returns the API key expiry, and null apiKey for OAuth", async () => {
  handler = (_req, res) =>
    json(res, 200, {
      id: "space_1",
      name: "Acme",
      tier: "tier_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      apiKey: { name: "CI", expiresAt: "2026-12-16T12:00:00.000Z" },
    });
  const space = await client().getSpace();
  assert.deepEqual(space.apiKey, { name: "CI", expiresAt: "2026-12-16T12:00:00.000Z" });

  handler = (_req, res) =>
    json(res, 200, {
      id: "space_1",
      name: "Acme",
      tier: "tier_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      apiKey: null,
    });
  assert.equal((await client().getSpace()).apiKey, null);
});
