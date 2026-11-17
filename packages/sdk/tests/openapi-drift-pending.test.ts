import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `scripts/check-openapi-drift.mjs` compares the SDK's snapshot with the live
 * spec, minus the JSON Pointers listed in `packages/sdk/openapi-pending.json`.
 * That list is how the snapshot can be AHEAD of the live API (an SDK method for
 * an endpoint krova-cloud has merged but not deployed) without turning every
 * unrelated CI run red, while everything else is still held to equality.
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "check-openapi-drift.mjs");

const live = {
  openapi: "3.0.3",
  paths: {
    "/space": { get: { description: "old" } },
    "/spaces/{spaceId}/cubes": { get: { description: "list" } },
  },
  components: { schemas: { Space: { type: "object", properties: { id: { type: "string" } } } } },
};

// The snapshot as it looks when it leads the API: a new path, a changed
// description and a new schema property.
const ahead = structuredClone(live) as typeof live & { paths: Record<string, unknown> };
ahead.paths["/space"] = { get: { description: "new" } };
ahead.paths["/spaces/{spaceId}/cubes/{cubeId}/resize"] = { post: {} };
(ahead.components.schemas.Space.properties as Record<string, unknown>).apiKey = { type: "object" };

const PENDING = [
  "/paths/~1space/get/description",
  "/paths/~1spaces~1{spaceId}~1cubes~1{cubeId}~1resize/post",
  "/components/schemas/Space/properties/apiKey",
];

let server: Server;
let base: string;
let served: unknown = live;
const dirs: string[] = [];

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(served));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function run(snapshot: unknown, pending: string[] | null, liveSpec: unknown = live) {
  const cwd = mkdtempSync(join(tmpdir(), "krova-drift-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "packages", "sdk"), { recursive: true });
  writeFileSync(join(cwd, "packages", "sdk", "openapi.json"), JSON.stringify(snapshot));
  if (pending) {
    writeFileSync(
      join(cwd, "packages", "sdk", "openapi-pending.json"),
      JSON.stringify({ ignore: pending }),
    );
  }
  served = liveSpec;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { cwd, env: { ...process.env, KROVA_API_BASE: base } },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test("an identical snapshot passes with no pending file", async () => {
  const r = await run(live, null);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Skipped/);
});

test("a snapshot ahead of the live API fails when nothing is pending", async () => {
  const r = await run(ahead, null);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /DRIFT/);
  assert.match(r.stderr, /openapi-pending\.json/, "the failure says how to declare pending changes");
});

test("a snapshot ahead of the live API passes when exactly those pointers are pending, and says what it skipped", async () => {
  const r = await run(ahead, PENDING);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Skipped 3 pending pointer/);
  for (const p of PENDING) assert.ok(r.stdout.includes(p), `names ${p}`);
  assert.match(r.stdout, /NOT verified against the live API/);
  assert.match(r.stdout, /Empty the ignore list after the krova-cloud deploy/);
});

test("a difference outside the pending pointers still fails", async () => {
  const changed = structuredClone(ahead) as typeof ahead;
  changed.paths["/spaces/{spaceId}/cubes"] = { get: { description: "changed" } };
  const r = await run(changed, PENDING);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /DRIFT/);
});

test("pointers the live API already serves fail the check until they are removed", async () => {
  const r = await run(ahead, PENDING, ahead);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already live or point at nothing; remove them/);
  for (const p of PENDING) assert.ok(r.stderr.includes(p), `names ${p}`);
});

test("one stale pointer among live-pending ones still fails, and names only the stale one", async () => {
  // The live API has the description change but not the new path or property.
  const partlyLive = structuredClone(live) as typeof live & { paths: Record<string, unknown> };
  partlyLive.paths["/space"] = { get: { description: "new" } };
  const r = await run(ahead, PENDING, partlyLive);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("/paths/~1space/get/description"));
  assert.ok(!r.stderr.includes("/components/schemas/Space/properties/apiKey"));
});

test("a pointer that points at nothing on both sides is stale", async () => {
  const r = await run(live, ["/paths/~1gone/get/description"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /~1gone/);
});

test("a malformed pending file is an error, never a silent pass", async () => {
  const r = await run(live, ["paths/space"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a JSON Pointer/);
});

test("pointers broader than one operation or one schema field are refused", async () => {
  for (const broad of [
    "/paths/~1space",
    "/paths",
    "/components/schemas/Space",
    "/components/schemas/Space/properties",
    "/info",
    "/paths/~1space/parameters",
  ]) {
    const r = await run(ahead, [broad]);
    assert.equal(r.code, 2, `${broad} must exit 2`);
    assert.match(r.stderr, /too broad/);
  }
});
