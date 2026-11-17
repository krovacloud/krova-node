import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  buildCreateBody,
  cubesCommand,
  describeIdleTimeout,
  idleTimeoutApplied,
  parseIdleTimeout,
} from "../src/commands/cubes.js";

const cube = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  state: "running",
  image: "ubuntu-24.04",
  resources: { vcpu: 2, ramGb: 2, diskGb: 20 },
  publicIpv4: null,
  costPerHour: 0.01,
  terminationProtection: false,
  ...extra,
});

test("parseIdleTimeout accepts 10 to 10080 and off, and nothing else", () => {
  assert.equal(parseIdleTimeout("10"), 10);
  assert.equal(parseIdleTimeout("10080"), 10080);
  assert.equal(parseIdleTimeout("45"), 45);
  assert.equal(parseIdleTimeout("off"), null);
  for (const bad of ["9", "10081", "abc", "1e2", "", " 20", "20 ", "-20", "+20", "0x10", "12.5", "OFF", "off ", "null"]) {
    assert.throws(
      () => parseIdleTimeout(bad),
      /--idle-timeout must be a whole number of minutes from 10 to 10080, or "off"/,
      JSON.stringify(bad),
    );
  }
});

test("describeIdleTimeout says off, N min, or a dash when the server does not say", () => {
  assert.equal(describeIdleTimeout(null), "off");
  assert.equal(describeIdleTimeout(30), "30 min");
  assert.equal(describeIdleTimeout(undefined), "-");
});

test("idleTimeoutApplied: present must match; absent is fine only for off", () => {
  assert.equal(idleTimeoutApplied(30, 30), true);
  assert.equal(idleTimeoutApplied(null, null), true);
  assert.equal(idleTimeoutApplied(undefined, null), true, "a server may omit a null field");
  assert.equal(idleTimeoutApplied(undefined, 30), false);
  assert.equal(idleTimeoutApplied(null, 30), false);
  assert.equal(idleTimeoutApplied(60, 30), false);
  assert.equal(idleTimeoutApplied(30, null), false);
});

test("buildCreateBody sends idleTimeoutMinutes only when given, and null for off", () => {
  const base = { name: "web", image: "ubuntu-24.04", sshKey: "ssh-ed25519 AAAA", vcpu: "1", ram: "1", disk: "10" };
  assert.equal("idleTimeoutMinutes" in buildCreateBody(base), false);
  assert.equal(buildCreateBody({ ...base, idleTimeoutMinutes: 60 }).idleTimeoutMinutes, 60);
  const off = buildCreateBody({ ...base, idleTimeoutMinutes: null });
  assert.equal("idleTimeoutMinutes" in off, true);
  assert.equal(off.idleTimeoutMinutes, null);
});

test("cubes exposes update with --idle-timeout, and create takes --idle-timeout", () => {
  const cubes = cubesCommand();
  const update = cubes.commands.find((c) => c.name() === "update");
  assert.ok(update, "cubes must expose `update`");
  assert.equal(update.registeredArguments.length, 1, "<cube>");
  assert.deepEqual(update.options.map((o) => o.long), ["--idle-timeout"]);
  const create = cubes.commands.find((c) => c.name() === "create");
  assert.ok(create?.options.some((o) => o.long === "--idle-timeout"));
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

const CREATE = [
  "cubes", "create", "--name", "web", "--image", "ubuntu-24.04", "--ssh-key", "ssh-ed25519 AAAA",
];

test("`krova cubes create --idle-timeout 30` sends idleTimeoutMinutes: 30", async () => {
  let posted: Record<string, unknown> = {};
  handler = (req, res, body) => {
    assert.equal(req.method, "POST");
    posted = JSON.parse(body);
    json(res, 201, { cube: cube("cube_1", "web", { idleTimeoutMinutes: 30, lastActiveAt: null }) });
  };
  const run = await runCli([...CREATE, "--idle-timeout", "30"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(posted.idleTimeoutMinutes, 30);
  assert.equal(run.stderr, "");
});

test("`krova cubes create --idle-timeout off` sends null", async () => {
  let posted: Record<string, unknown> = {};
  handler = (_req, res, body) => {
    posted = JSON.parse(body);
    json(res, 201, { cube: cube("cube_1", "web", { idleTimeoutMinutes: null, lastActiveAt: null }) });
  };
  const run = await runCli([...CREATE, "--idle-timeout", "off"]);
  assert.equal(run.code, 0, run.stderr);
  assert.ok("idleTimeoutMinutes" in posted, "the key must be sent");
  assert.equal(posted.idleTimeoutMinutes, null);
});

test("`krova cubes create` without the flag sends no idleTimeoutMinutes", async () => {
  let posted: Record<string, unknown> = {};
  handler = (_req, res, body) => {
    posted = JSON.parse(body);
    json(res, 201, { cube: cube("cube_1", "web") });
  };
  const run = await runCli(CREATE);
  assert.equal(run.code, 0, run.stderr);
  assert.equal("idleTimeoutMinutes" in posted, false);
  assert.equal(run.stderr, "", "no warning without the flag");
});

test("`krova cubes create --idle-timeout 9` fails before any request", async () => {
  let requests = 0;
  handler = (_req, res) => {
    requests += 1;
    json(res, 201, { cube: cube("cube_1", "web") });
  };
  const run = await runCli([...CREATE, "--idle-timeout", "9"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /--idle-timeout must be a whole number of minutes from 10 to 10080, or "off"/);
  assert.equal(requests, 0);
});

test("`krova cubes create --idle-timeout 30 --json` keeps stdout JSON and warns on stderr when an older server ignores it", async () => {
  handler = (_req, res) => json(res, 201, { cube: cube("cube_1", "web") });
  const run = await runCli([...CREATE, "--idle-timeout", "30", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).id, "cube_1");
  assert.match(run.stderr, /did not report the requested idle timeout/);
});

test("`krova cubes create --idle-timeout off` does not warn when the server omits the null field", async () => {
  handler = (_req, res) => json(res, 201, { cube: cube("cube_1", "web") });
  const run = await runCli([...CREATE, "--idle-timeout", "off"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, "");
});

test("`krova cubes create --idle-timeout 30` warns when the server reports a different value", async () => {
  handler = (_req, res) => json(res, 201, { cube: cube("cube_1", "web", { idleTimeoutMinutes: null }) });
  const run = await runCli([...CREATE, "--idle-timeout", "30"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /did not report the requested idle timeout/);
});

const LIST = { cubes: [cube("cube_1", "web"), cube("cube_2", "db")], pagination: {} };

test("`krova cubes update --idle-timeout 45` PATCHes exactly { idleTimeoutMinutes: 45 }", async () => {
  const seen: string[] = [];
  let patched: unknown;
  handler = (req, res, body) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "GET") return json(res, 200, LIST);
    patched = JSON.parse(body);
    json(res, 200, { cube: cube("cube_1", "web", { idleTimeoutMinutes: 45, lastActiveAt: null }) });
  };
  const run = await runCli(["cubes", "update", "web", "--idle-timeout", "45"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(seen, [
    "GET /api/v1/spaces/space_1/cubes",
    "PATCH /api/v1/spaces/space_1/cubes/cube_1",
  ]);
  assert.deepEqual(patched, { idleTimeoutMinutes: 45 });
  assert.match(run.stdout, /Set idle auto-stop for cube cube_1 to 45 min/);
});

test("`krova cubes update --idle-timeout off` PATCHes null and says it is off", async () => {
  let patched: unknown;
  handler = (req, res, body) => {
    if (req.method === "GET") return json(res, 200, LIST);
    patched = JSON.parse(body);
    json(res, 200, { cube: cube("cube_1", "web", { idleTimeoutMinutes: null, lastActiveAt: null }) });
  };
  const run = await runCli(["cubes", "update", "cube_1", "--idle-timeout", "off", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(patched, { idleTimeoutMinutes: null });
  const printed = JSON.parse(run.stdout);
  assert.equal(printed.idleTimeoutMinutes, null);
  assert.equal(printed.id, "cube_1");
});

test("`krova cubes update` with no flag is an error and sends nothing", async () => {
  let requests = 0;
  handler = (_req, res) => {
    requests += 1;
    json(res, 200, LIST);
  };
  const run = await runCli(["cubes", "update", "web"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /nothing to update: pass --idle-timeout <minutes\|off>/);
  assert.equal(requests, 0);
});

test("`krova cubes update --idle-timeout` refuses a bad value before any request", async () => {
  let requests = 0;
  handler = (_req, res) => {
    requests += 1;
    json(res, 200, LIST);
  };
  for (const bad of ["9", "10081", "abc", "1e2"]) {
    const run = await runCli(["cubes", "update", "web", "--idle-timeout", bad]);
    assert.equal(run.code, 1, bad);
    assert.match(run.stderr, /--idle-timeout must be a whole number of minutes from 10 to 10080, or "off"/);
  }
  assert.equal(requests, 0);
});

test("`krova cubes update` shows the API's message when the server refuses the field", async () => {
  handler = (req, res) =>
    req.method === "GET"
      ? json(res, 200, LIST)
      : json(res, 400, { error: "Unsupported field: idleTimeoutMinutes. PATCH accepts name and terminationProtection." });
  const run = await runCli(["cubes", "update", "web", "--idle-timeout", "30"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /Unsupported field: idleTimeoutMinutes/);
});

test("`krova cubes update` does not claim success when a 200 does not carry the new value", async () => {
  handler = (req, res) =>
    req.method === "GET" ? json(res, 200, LIST) : json(res, 200, { cube: cube("cube_1", "web") });
  const run = await runCli(["cubes", "update", "web", "--idle-timeout", "30"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /did not apply --idle-timeout/);
  assert.doesNotMatch(run.stdout, /Set idle auto-stop/);
});

test("`krova cubes update --idle-timeout off` succeeds when the server omits the null field, and fails when it reports another value", async () => {
  handler = (req, res) =>
    req.method === "GET" ? json(res, 200, LIST) : json(res, 200, { cube: cube("cube_1", "web") });
  const ok = await runCli(["cubes", "update", "web", "--idle-timeout", "off"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Turned off idle auto-stop for cube cube_1/);

  handler = (req, res) =>
    req.method === "GET"
      ? json(res, 200, LIST)
      : json(res, 200, { cube: cube("cube_1", "web", { idleTimeoutMinutes: 60 }) });
  const bad = await runCli(["cubes", "update", "web", "--idle-timeout", "off"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /kept the idle timeout at 60 min/);
});

test("`krova cubes get` shows the idle timeout and last activity", async () => {
  handler = (req, res) => {
    if (req.url?.endsWith("/cubes")) return json(res, 200, LIST);
    json(res, 200, { cube: cube("cube_1", "web", { idleTimeoutMinutes: 30, lastActiveAt: "2026-11-16T10:00:00.000Z" }) });
  };
  const run = await runCli(["cubes", "get", "web"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^Idle timeout\s+30 min$/m);
  assert.match(run.stdout, /^Last active\s+2026-11-16T10:00:00\.000Z$/m);
});

test("`krova cubes get` says off for a null timeout and dashes for a null last activity", async () => {
  handler = (req, res) => {
    if (req.url?.endsWith("/cubes")) return json(res, 200, LIST);
    json(res, 200, { cube: cube("cube_1", "web", { idleTimeoutMinutes: null, lastActiveAt: null }) });
  };
  const run = await runCli(["cubes", "get", "web"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^Idle timeout\s+off$/m);
  assert.match(run.stdout, /^Last active\s+-$/m);
});

test("`krova cubes get` shows dashes when an older server sends neither field", async () => {
  handler = (req, res) => {
    if (req.url?.endsWith("/cubes")) return json(res, 200, LIST);
    json(res, 200, { cube: cube("cube_1", "web") });
  };
  const run = await runCli(["cubes", "get", "web"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^Idle timeout\s+-$/m);
  assert.match(run.stdout, /^Last active\s+-$/m);
});

test("`krova cubes get --json` passes both fields through", async () => {
  handler = (req, res) => {
    if (req.url?.endsWith("/cubes")) return json(res, 200, LIST);
    json(res, 200, { cube: cube("cube_1", "web", { idleTimeoutMinutes: 30, lastActiveAt: "2026-11-16T10:00:00.000Z" }) });
  };
  const run = await runCli(["cubes", "get", "web", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  const printed = JSON.parse(run.stdout);
  assert.equal(printed.idleTimeoutMinutes, 30);
  assert.equal(printed.lastActiveAt, "2026-11-16T10:00:00.000Z");
});
