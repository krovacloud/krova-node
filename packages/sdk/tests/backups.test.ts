import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { type Backup, type BackupShare, KrovaClient, KrovaError } from "../src/index.js";

/**
 * Backups and backup shares against a local mock server: the path, method,
 * body and headers each helper sends, and how it unwraps the response. Same
 * pattern as termination-protection.test.ts; no real network is touched.
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

const client = () => new KrovaClient({ apiKey: "kro_test", baseUrl, maxRetries: 0 });

const backup: Backup = {
  id: "bk_1",
  name: "postgres-nightly",
  status: "complete",
  originalCubeId: "cube_1",
  originalCubeName: "db",
  sizeBytes: 3_221_225_472,
  diskSizeGb: 20,
  config: {
    vcpus: 2,
    ramMb: 2048,
    diskLimitGb: 20,
    imageId: "ubuntu-24.04",
    regionId: "fra",
    regionName: "Frankfurt",
    domains: [],
    tcpPorts: [],
  },
  sharedFromBackupId: null,
  redeployedCubeId: null,
  completedAt: "2026-10-06T00:00:00Z",
  createdAt: "2026-10-06T00:00:00Z",
};

const share: BackupShare = {
  id: "bs_1",
  status: "pending",
  backupId: "bk_1",
  backupName: "postgres-nightly",
  sourceSpaceId: "space_src",
  destinationSpaceId: "space_dst",
  counterpartySpaceName: "Northwind Lab",
  copyBackupId: null,
  expiresAt: "2026-10-09T00:00:00Z",
  createdAt: "2026-10-07T00:00:00Z",
};

test("backups.list and backups.get read the space's backups", async () => {
  const seen: string[] = [];
  handler = (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/backups")) json(res, 200, { backups: [backup] });
    else json(res, 200, { backup });
  };
  const krova = client();
  assert.deepEqual(await krova.backups.list("space_src"), [backup]);
  assert.deepEqual(await krova.backups.get("space_src", "bk_1"), backup);
  assert.deepEqual(seen, [
    "GET /api/v1/spaces/space_src/backups",
    "GET /api/v1/spaces/space_src/backups/bk_1",
  ]);
});

test("backups.share posts the destination and forwards the idempotency key", async () => {
  let seenBody: unknown;
  let seenUrl = "";
  let seenKey: string | undefined;
  handler = (req, res, body) => {
    seenUrl = `${req.method} ${req.url}`;
    seenBody = JSON.parse(body || "{}");
    seenKey = req.headers["idempotency-key"] as string | undefined;
    json(res, 201, { share });
  };
  const result = await client().backups.share(
    "space_src",
    "bk_1",
    { destinationSpaceId: "space_dst" },
    { idempotencyKey: "share-once" },
  );
  assert.deepEqual(result, share);
  assert.equal(seenUrl, "POST /api/v1/spaces/space_src/backups/bk_1/shares");
  assert.deepEqual(seenBody, { destinationSpaceId: "space_dst" });
  assert.equal(seenKey, "share-once");
});

test("backupShares.list returns both directions, empty when the server omits one", async () => {
  handler = (_req, res) => json(res, 200, { incoming: [share] });
  assert.deepEqual(await client().backupShares.list("space_dst"), {
    incoming: [share],
    outgoing: [],
  });
});

test("backupShares.accept returns the share and the new copy", async () => {
  const copy: Backup = { ...backup, id: "bk_copy", sharedFromBackupId: "bk_1" };
  let seenUrl = "";
  handler = (req, res) => {
    seenUrl = `${req.method} ${req.url}`;
    json(res, 200, { share: { ...share, status: "accepted", copyBackupId: "bk_copy" }, backup: copy });
  };
  const accepted = await client().backupShares.accept("space_dst", "bs_1");
  assert.equal(seenUrl, "POST /api/v1/spaces/space_dst/backup-shares/bs_1/accept");
  assert.equal(accepted.share.status, "accepted");
  assert.equal(accepted.backup.sharedFromBackupId, "bk_1");
});

test("backupShares.decline and cancel post to their own paths", async () => {
  const seen: string[] = [];
  handler = (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const status = req.url?.endsWith("/decline") ? "declined" : "canceled";
    json(res, 200, { share: { ...share, status } });
  };
  const krova = client();
  assert.equal((await krova.backupShares.decline("space_dst", "bs_1")).status, "declined");
  assert.equal((await krova.backupShares.cancel("space_src", "bs_1")).status, "canceled");
  assert.deepEqual(seen, [
    "POST /api/v1/spaces/space_dst/backup-shares/bs_1/decline",
    "POST /api/v1/spaces/space_src/backup-shares/bs_1/cancel",
  ]);
});

test("a refusal surfaces as a KrovaError carrying the API's message and status", async () => {
  handler = (_req, res) =>
    json(res, 403, {
      error:
        "Only the destination space's owner, or a member who can manage its backups, can respond to this share.",
    });
  await assert.rejects(
    () => client().backupShares.accept("space_dst", "bs_1"),
    (err: unknown) => {
      assert.ok(err instanceof KrovaError);
      assert.equal(err.status, 403);
      assert.match(err.message, /manage its backups/);
      return true;
    },
  );
});

test("a 422 from a destination that cannot take the copy is not swallowed", async () => {
  handler = (_req, res) =>
    json(res, 422, { error: "This space has no backup allowance left on its plan." });
  await assert.rejects(
    () => client().backupShares.accept("space_dst", "bs_1"),
    (err: unknown) => err instanceof KrovaError && err.status === 422,
  );
});
