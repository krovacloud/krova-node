import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { KrovaClient, KrovaError, TerminationProtectedError } from "../src/index.js";

/**
 * Re-uses the minimal mock-server pattern from client.test.ts. Each test
 * installs a handler that captures the request (method, URL, body) and writes
 * a JSON response — same shape, no real network is ever touched.
 */
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
  const { port } = server.address() as AddressInfo;
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

test("cubes.create forwards terminationProtection on the wire", async () => {
  let seenBody: Record<string, unknown> = {};
  const created = {
    id: "cube_protected",
    name: "api",
    state: "pending",
    publicIpv4: null,
    resources: { vcpu: 2, ramGb: 2, diskGb: 20 },
    image: "ubuntu-24.04",
    costPerHour: 0.05,
    createdAt: "2026-09-15T00:00:00Z",
    updatedAt: "2026-09-15T00:00:00Z",
    terminationProtection: true,
  };
  handler = (_req, res, body) => {
    seenBody = JSON.parse(body || "{}") as Record<string, unknown>;
    json(res, 201, { cube: created });
  };

  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });
  const out = await client.cubes.create("space_abc", {
    name: "api",
    image: "ubuntu-24.04",
    resources: { vcpu: 2, ramGb: 2, diskGb: 20 },
    sshPublicKey: "ssh-ed25519 AAAA",
    terminationProtection: true,
  });

  assert.equal(seenBody.terminationProtection, true, "the flag must go out on the wire");
  assert.equal(out.terminationProtection, true, "the response carries it back");
});

test("cubes.setTerminationProtection PATCHes /spaces/{spaceId}/cubes/{cubeId} and unwraps the cube", async () => {
  let seenMethod = "";
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  const cube = {
    id: "cube_1",
    name: "web",
    state: "running",
    publicIpv4: "1.2.3.4",
    resources: { vcpu: 1, ramGb: 1, diskGb: 10 },
    image: "ubuntu-24.04",
    costPerHour: 0.01,
    createdAt: "2026-09-15T00:00:00Z",
    updatedAt: "2026-09-15T00:00:00Z",
    terminationProtection: true,
    terminationProtectionChangedAt: "2026-09-15T12:00:00Z",
    terminationProtectionChangedBy: "user:abc",
  };
  handler = (req, res, body) => {
    seenMethod = req.method ?? "";
    seenUrl = req.url ?? "";
    seenBody = JSON.parse(body || "{}") as Record<string, unknown>;
    json(res, 200, { cube });
  };

  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });
  const updated = await client.cubes.setTerminationProtection("space_abc", "cube_1", true);

  assert.equal(seenMethod, "PATCH", "must PATCH");
  assert.equal(seenUrl, "/api/v1/spaces/space_abc/cubes/cube_1");
  assert.deepEqual(seenBody, { terminationProtection: true });
  assert.equal(updated.terminationProtection, true);
  assert.equal(updated.terminationProtectionChangedBy, "user:abc");
});

test("cubes.setTerminationProtection(false) sends the explicit `false` value", async () => {
  let seenBody: Record<string, unknown> = {};
  const cube = {
    id: "cube_1",
    name: "web",
    state: "running",
    publicIpv4: "1.2.3.4",
    resources: { vcpu: 1, ramGb: 1, diskGb: 10 },
    image: "ubuntu-24.04",
    costPerHour: 0.01,
    createdAt: "2026-09-15T00:00:00Z",
    updatedAt: "2026-09-15T00:00:00Z",
    terminationProtection: false,
  };
  handler = (_req, res, body) => {
    seenBody = JSON.parse(body || "{}") as Record<string, unknown>;
    json(res, 200, { cube });
  };

  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });
  await client.cubes.setTerminationProtection("space_abc", "cube_1", false);
  assert.equal(
    seenBody.terminationProtection,
    false,
    "false must be sent explicitly — silence would be ambiguous on PATCH",
  );
});

test("cubes.delete throws TerminationProtectedError on 409 with code=termination_protected", async () => {
  handler = (_req, res) => {
    json(res, 409, {
      error: {
        code: "termination_protected",
        message: "This Cube has termination protection on. Turn it off before deleting.",
        cube: {
          id: "cube_1",
          terminationProtectionChangedAt: "2026-09-15T12:00:00Z",
          terminationProtectionChangedBy: "user:abc",
        },
      },
    });
  };

  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });
  await assert.rejects(
    () => client.cubes.delete("space_abc", "cube_1"),
    (err: unknown) => {
      assert.ok(err instanceof TerminationProtectedError, "must throw TerminationProtectedError");
      assert.ok(!(err instanceof KrovaError) || err.status === 409, "inherits KrovaError status");
      const tpe = err as TerminationProtectedError;
      assert.equal(tpe.status, 409);
      assert.equal(tpe.code, "termination_protected");
      assert.equal(tpe.cubeId, "cube_1");
      assert.equal(tpe.changedAt, "2026-09-15T12:00:00Z");
      assert.equal(tpe.changedBy, "user:abc");
      // The server's human-readable message is what the CLI / MCP surface.
      assert.match(tpe.message, /termination protection on/);
      return true;
    },
  );
});

test("cubes.delete still throws a plain KrovaError on 404 (unchanged behaviour)", async () => {
  // The protected-cube branch is opt-in: any other non-2xx must still surface
  // a `KrovaError`, never a `TerminationProtectedError`.
  handler = (_req, res) => {
    json(res, 404, { error: "Cube not found" });
  };

  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });
  await assert.rejects(
    () => client.cubes.delete("space_abc", "missing"),
    (err: unknown) => {
      assert.ok(err instanceof KrovaError);
      assert.ok(
        !(err instanceof TerminationProtectedError),
        "must NOT be TerminationProtectedError",
      );
      return true;
    },
  );
});

test("cubes.delete tolerates a 409 with code=termination_protected and a missing cube block", async () => {
  // The spec defines the 409 body shape, but a defensive SDK must not blow up
  // when the server sends the code without the full `cube` object — the
  // operator-facing message is still the point.
  handler = (_req, res) => {
    json(res, 409, {
      error: { code: "termination_protected", message: "termination protection on" },
    });
  };

  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });
  await assert.rejects(
    () => client.cubes.delete("space_abc", "cube_1"),
    (err: unknown) => {
      assert.ok(err instanceof TerminationProtectedError);
      const tpe = err as TerminationProtectedError;
      assert.equal(tpe.cubeId, "cube_1", "falls back to the path id");
      assert.equal(tpe.changedAt, null);
      assert.equal(tpe.changedBy, null);
      return true;
    },
  );
});

test("TerminationProtectedError is exported from the package entrypoint", async () => {
  // The CLI and MCP both rely on the named export — keeping it discoverable
  // is half the contract. A regression here would silently fall back to a
  // plain KrovaError and the CLI's exit code would change.
  assert.equal(typeof TerminationProtectedError, "function");
  const e = new TerminationProtectedError("x", {
    status: 409,
    code: "termination_protected",
    cubeId: "c",
    changedAt: null,
    changedBy: null,
  });
  assert.equal(e.name, "TerminationProtectedError");
  assert.equal(e.code, "termination_protected");
  assert.equal(e.cubeId, "c");
});
