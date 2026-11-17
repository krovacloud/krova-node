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

test("cubes.setIdleTimeout PATCHes { idleTimeoutMinutes } and returns the updated Cube", async () => {
  let seen: { method?: string; url?: string; body?: string } = {};
  handler = (req, res, body) => {
    seen = { method: req.method, url: req.url, body };
    json(res, 200, { cube: { id: "cube_1", idleTimeoutMinutes: 30, lastActiveAt: null } });
  };

  const cube = await client().cubes.setIdleTimeout("space_1", "cube_1", 30);

  assert.equal(seen.method, "PATCH");
  assert.equal(seen.url, "/api/v1/spaces/space_1/cubes/cube_1");
  assert.deepEqual(JSON.parse(seen.body ?? ""), { idleTimeoutMinutes: 30 });
  assert.equal(cube.idleTimeoutMinutes, 30);
});

test("cubes.setIdleTimeout sends null to turn it off", async () => {
  let body = "";
  handler = (_req, res, raw) => {
    body = raw;
    json(res, 200, { cube: { id: "cube_1", idleTimeoutMinutes: null } });
  };

  const cube = await client().cubes.setIdleTimeout("space_1", "cube_1", null);

  assert.deepEqual(JSON.parse(body), { idleTimeoutMinutes: null });
  assert.equal(cube.idleTimeoutMinutes, null);
});

test("cubes.setIdleTimeout throws KrovaError with the server message on a 400", async () => {
  handler = (_req, res) =>
    json(res, 400, { error: "idleTimeoutMinutes must be an integer between 10 and 10080, or null" });

  await assert.rejects(
    () => client().cubes.setIdleTimeout("space_1", "cube_1", 5),
    (err: unknown) => {
      assert.ok(err instanceof KrovaError);
      assert.equal(err.status, 400);
      assert.match(err.message, /between 10 and 10080/);
      return true;
    },
  );
});

test("cubes.setIdleTimeout throws when the 200 response has no cube", async () => {
  handler = (_req, res) => json(res, 200, {});

  await assert.rejects(
    () => client().cubes.setIdleTimeout("space_1", "cube_1", 30),
    /had no `cube`/,
  );
});

test("cubes.create passes idleTimeoutMinutes through, including null", async () => {
  const bodies: unknown[] = [];
  handler = (_req, res, raw) => {
    bodies.push(JSON.parse(raw));
    json(res, 201, { cube: { id: "cube_1", name: "web" } });
  };
  const base = {
    name: "web",
    image: "ubuntu-24.04",
    resources: { vcpu: 1, ramGb: 1, diskGb: 10 },
    sshPublicKey: "ssh-ed25519 AAAA",
  };

  await client().cubes.create("space_1", { ...base, idleTimeoutMinutes: 60 });
  await client().cubes.create("space_1", { ...base, idleTimeoutMinutes: null });

  assert.equal((bodies[0] as { idleTimeoutMinutes?: unknown }).idleTimeoutMinutes, 60);
  assert.equal((bodies[1] as { idleTimeoutMinutes?: unknown }).idleTimeoutMinutes, null);
});
