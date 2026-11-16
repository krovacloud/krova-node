import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { cubesCommand, parseCubeName, parseSize } from "../src/commands/cubes.js";
import { describeExpiry } from "../src/commands/whoami.js";

const cube = (id: string, name: string, resources = { vcpu: 2, ramGb: 2, diskGb: 20 }) => ({
  id,
  name,
  state: "running",
  image: "ubuntu-24.04",
  resources,
  publicIpv4: null,
  costPerHour: 0.01,
  terminationProtection: false,
});

test("cubes exposes rename and resize with their flags", () => {
  const cubes = cubesCommand();
  const rename = cubes.commands.find((c) => c.name() === "rename");
  assert.ok(rename, "cubes must expose `rename`");
  assert.equal(rename.registeredArguments.length, 2, "<cube> <new-name>");

  const resize = cubes.commands.find((c) => c.name() === "resize");
  assert.ok(resize, "cubes must expose `resize`");
  assert.equal(resize.registeredArguments.length, 1, "<cube>");
  assert.deepEqual(resize.options.map((o) => o.long).sort(), ["--disk", "--ram", "--vcpu", "--yes"]);
});

test("parseSize accepts plain decimals only", () => {
  assert.equal(parseSize("--vcpu", "4", true), 4);
  assert.equal(parseSize("--ram", "0.5", false), 0.5);
  assert.equal(parseSize("--ram", "8", false), 8);
  for (const bad of ["0x10", "1e1", " 5", "5 ", "", "-1", "0", "+4", ".5", "5.", "Infinity", "1_0"]) {
    assert.throws(() => parseSize("--ram", bad, false), /--ram must be a positive number/, `ram ${JSON.stringify(bad)}`);
  }
  for (const bad of ["1.5", "0x10", "1e1", "0"]) {
    assert.throws(() => parseSize("--vcpu", bad, true), /--vcpu must be a positive whole number/, `vcpu ${bad}`);
  }
});

test("parseCubeName trims and enforces 1 to 64 printable characters", () => {
  assert.equal(parseCubeName("  web-1  "), "web-1");
  assert.equal(parseCubeName("x".repeat(64)), "x".repeat(64));
  assert.equal(parseCubeName("web \u00e9\u{1F680}"), "web \u00e9\u{1F680}");
  for (const bad of ["", "   ", "x".repeat(65), "a\nb", "a\u0000b", "a\tb", "a\u2028b", "a\u202Eb"]) {
    assert.throws(() => parseCubeName(bad), /1 to 64 printable characters/, JSON.stringify(bad));
  }
});

test("describeExpiry says never, counts days, and flags a date in the past", () => {
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  assert.equal(describeExpiry(null, now), "never");
  assert.equal(
    describeExpiry("2026-12-16T12:00:00.000Z", now),
    "2026-12-16T12:00:00.000Z (in 30 days)",
  );
  assert.equal(
    describeExpiry("2026-11-17T12:00:00.000Z", now),
    "2026-11-17T12:00:00.000Z (in 1 day)",
  );
  assert.equal(
    describeExpiry("2026-11-16T18:00:00.000Z", now),
    "2026-11-16T18:00:00.000Z (within a day)",
  );
  assert.equal(
    describeExpiry("2026-11-01T00:00:00.000Z", now),
    "2026-11-01T00:00:00.000Z (expired)",
  );
});

// ── End to end: the real CLI entry point against a local mock API ───────────

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

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // The BUILT entry, the file `npx krova` runs (CI builds before it tests).
  const entry = join(import.meta.dirname, "..", "dist", "index.js");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [entry, ...args, "--api-key", "kro_test", "--space", "space_1", "--base-url", baseUrl],
      // An empty HOME keeps the run away from the developer's saved contexts.
      { env: { ...process.env, HOME: "/nonexistent-krova-home", KROVA_API_KEY: "" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const LIST = { cubes: [cube("cube_1", "web"), cube("cube_2", "db")], pagination: {} };

test("`krova cubes rename` resolves the name and PATCHes the new one", async () => {
  const seen: string[] = [];
  let patched: unknown;
  handler = (req, res, body) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "GET") return json(res, 200, LIST);
    patched = JSON.parse(body);
    json(res, 200, { cube: cube("cube_1", "web-1") });
  };
  const run = await runCli(["cubes", "rename", "web", "web-1"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(seen, [
    "GET /api/v1/spaces/space_1/cubes",
    "PATCH /api/v1/spaces/space_1/cubes/cube_1",
  ]);
  assert.deepEqual(patched, { name: "web-1" });
  assert.match(run.stdout, /Renamed cube cube_1 to web-1/);
});

test("`krova cubes rename --json` prints only the Cube as JSON", async () => {
  handler = (req, res) =>
    req.method === "GET" ? json(res, 200, LIST) : json(res, 200, { cube: cube("cube_1", "web-1") });
  const run = await runCli(["cubes", "rename", "cube_1", "web-1", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).name, "web-1");
});

test("`krova cubes rename` refuses a bad name before any request, and sends the trimmed one", async () => {
  let requests = 0;
  let patched: unknown;
  handler = (req, res, body) => {
    requests += 1;
    if (req.method === "GET") return json(res, 200, LIST);
    patched = JSON.parse(body);
    json(res, 200, { cube: cube("cube_1", "web-1") });
  };
  for (const bad of ["x".repeat(65), "   ", "a\u0007b"]) {
    const run = await runCli(["cubes", "rename", "web", bad]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /1 to 64 printable characters/);
  }
  assert.equal(requests, 0);

  const ok = await runCli(["cubes", "rename", "web", "  web-1  "]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(patched, { name: "web-1" });
});

test("`krova cubes rename` shows the API's message when the server refuses the name", async () => {
  handler = (req, res) =>
    req.method === "GET"
      ? json(res, 200, LIST)
      : json(res, 403, { error: "Forbidden: missing permission cube.manage" });
  const run = await runCli(["cubes", "rename", "web", "web-1"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /missing permission cube\.manage/);
});

test("`krova cubes resize` live: posts only the flags given and says no restart", async () => {
  const seen: string[] = [];
  let posted: unknown;
  handler = (req, res, body) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "GET") return json(res, 200, LIST);
    posted = JSON.parse(body);
    json(res, 200, {
      success: true,
      state: "queued",
      jobId: "job_1",
      isLive: true,
      requiresRestart: false,
      previous: { vcpu: 2, ramGb: 2, diskGb: 20 },
      requested: { vcpu: 2, ramGb: 4, diskGb: 40 },
    });
  };
  const run = await runCli(["cubes", "resize", "web", "--ram", "4", "--disk", "40"]);
  assert.equal(run.code, 0, run.stderr);
  // No terminal here, so no confirmation read of the Cube: list, then the POST.
  assert.deepEqual(seen, [
    "GET /api/v1/spaces/space_1/cubes",
    "POST /api/v1/spaces/space_1/cubes/cube_1/resize",
  ]);
  assert.deepEqual(posted, { resources: { ramGb: 4, diskGb: 40 } });
  assert.match(run.stdout, /Resize queued for cube cube_1 \(job job_1\)/);
  assert.match(run.stdout, /vCPU: 2 \(unchanged\)/);
  assert.match(run.stdout, /RAM: 2 GB -> 4 GB/);
  assert.match(run.stdout, /Disk: 20 GB -> 40 GB/);
  assert.match(run.stdout, /Applied live: the Cube does not restart\./);
  assert.match(run.stdout, /krova cubes get cube_1/);
});

test("`krova cubes resize` cold: says the Cube restarts", async () => {
  handler = (req, res) =>
    req.method === "GET"
      ? json(res, 200, LIST)
      : json(res, 200, {
          success: true,
          state: "queued",
          jobId: "job_2",
          isLive: false,
          requiresRestart: true,
          previous: { vcpu: 2, ramGb: 2, diskGb: 20 },
          requested: { vcpu: 4, ramGb: 2, diskGb: 20 },
        });
  const run = await runCli(["cubes", "resize", "cube_1", "--vcpu", "4", "-y"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /vCPU: 2 -> 4/);
  assert.match(run.stdout, /The Cube restarts to apply this change\./);
});

test("`krova cubes resize --json` prints the API result with the Cube id and nothing else", async () => {
  handler = (req, res) =>
    req.method === "GET"
      ? json(res, 200, LIST)
      : json(res, 200, {
          success: true,
          state: "queued",
          jobId: "job_3",
          isLive: true,
          requiresRestart: false,
          previous: { vcpu: 2, ramGb: 2, diskGb: 20 },
          requested: { vcpu: 2, ramGb: 4, diskGb: 20 },
        });
  const run = await runCli(["cubes", "resize", "web", "--ram", "4", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.id, "cube_1");
  assert.equal(out.jobId, "job_3");
  assert.equal(out.isLive, true);
});

test("`krova cubes resize` exits 1 with the API's reason on a 400, and hints when the host is full", async () => {
  handler = (req, res) =>
    req.method === "GET"
      ? json(res, 200, LIST)
      : json(res, 400, {
          error: "Disk cannot be shrunk. Current disk is 20 GB.",
        });
  const shrink = await runCli(["cubes", "resize", "web", "--disk", "10"]);
  assert.equal(shrink.code, 1);
  assert.match(shrink.stderr, /Disk cannot be shrunk/);

  handler = (req, res) =>
    req.method === "GET"
      ? json(res, 200, LIST)
      : json(res, 400, {
          error: "Server does not have enough CPU capacity for this resize.",
          code: "insufficient_host_capacity",
          dimension: "cpu",
        });
  const full = await runCli(["cubes", "resize", "web", "--vcpu", "64"]);
  assert.equal(full.code, 1);
  assert.match(full.stderr, /does not have enough CPU capacity/);
  assert.match(full.stderr, /no room for that size/);
});

test("`krova cubes resize` maps a 409 to the busy hint", async () => {
  handler = (req, res) =>
    req.method === "GET"
      ? json(res, 200, LIST)
      : json(res, 409, { error: "A resize is already in progress for this Cube." });
  const run = await runCli(["cubes", "resize", "web", "--vcpu", "4"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /already in progress/);
  assert.match(run.stderr, /Try again in a moment/);
});

test("`krova cubes resize` rejects bad flags before any request", async () => {
  let requests = 0;
  handler = (_req, res) => {
    requests += 1;
    json(res, 200, LIST);
  };
  const none = await runCli(["cubes", "resize", "web"]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /at least one of --vcpu, --ram or --disk/);

  const frac = await runCli(["cubes", "resize", "web", "--vcpu", "1.5"]);
  assert.equal(frac.code, 1);
  assert.match(frac.stderr, /--vcpu must be a positive whole number/);

  const neg = await runCli(["cubes", "resize", "web", "--ram", "-2"]);
  assert.equal(neg.code, 1);
  assert.match(neg.stderr, /--ram must be a positive number/);

  const hex = await runCli(["cubes", "resize", "web", "--disk", "0x10"]);
  assert.equal(hex.code, 1);
  assert.match(hex.stderr, /--disk must be a positive whole number/);
  assert.equal(requests, 0);
});

const SPACE = { id: "space_1", name: "Acme", tier: "tier_1", createdAt: "2026-01-01T00:00:00Z" };

test("`krova whoami` shows when the key expires, and `never` for a key that does not", async () => {
  handler = (_req, res) =>
    json(res, 200, { ...SPACE, apiKey: { name: "CI", expiresAt: "2099-12-16T12:00:00.000Z" } });
  const dated = await runCli(["whoami"]);
  assert.equal(dated.code, 0, dated.stderr);
  assert.match(dated.stdout, /Key expires\s+2099-12-16T12:00:00\.000Z \(in \d+ days\)/);

  handler = (_req, res) => json(res, 200, { ...SPACE, apiKey: { name: "CLI", expiresAt: null } });
  const never = await runCli(["whoami"]);
  assert.match(never.stdout, /Key expires\s+never/);

  const asJson = await runCli(["whoami", "--json"]);
  assert.equal(JSON.parse(asJson.stdout).apiKeyExpiresAt, null);
});

test("`krova whoami` omits the expiry when the server does not say (older server, OAuth)", async () => {
  handler = (_req, res) => json(res, 200, SPACE);
  const old = await runCli(["whoami"]);
  assert.equal(old.code, 0, old.stderr);
  assert.doesNotMatch(old.stdout, /Key expires/);
  assert.equal("apiKeyExpiresAt" in JSON.parse((await runCli(["whoami", "--json"])).stdout), false);

  handler = (_req, res) => json(res, 200, { ...SPACE, apiKey: null });
  assert.doesNotMatch((await runCli(["whoami"])).stdout, /Key expires/);
});

test("`krova whoami` on a 401 says the key may be invalid, revoked or expired", async () => {
  handler = (_req, res) => json(res, 401, { error: "Invalid API key" });
  const run = await runCli(["whoami"]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /invalid, revoked or expired/);
});
