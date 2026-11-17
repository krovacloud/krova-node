import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { KrovaError } from "@krovacloud/sdk";

import { normalizeBaseUrl } from "../src/lib/base-url.js";
import { exitQuietlyOnBrokenPipe } from "../src/lib/output.js";
import {
  parseWaitSeconds,
  parseWaitState,
  waitForCubeState,
} from "../src/lib/wait.js";

// ── Unit: EPIPE handling ────────────────────────────────────────────────────

test("a broken pipe on stdout exits 0 and says nothing", () => {
  const stream = new EventEmitter();
  const exits: number[] = [];
  const said: string[] = [];
  exitQuietlyOnBrokenPipe(stream, (c) => void exits.push(c), (t) => void said.push(t));
  stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.deepEqual(exits, [0]);
  assert.deepEqual(said, []);
});

test("any other stdout write error is still reported and exits 1", () => {
  const stream = new EventEmitter();
  const exits: number[] = [];
  const said: string[] = [];
  exitQuietlyOnBrokenPipe(stream, (c) => void exits.push(c), (t) => void said.push(t));
  stream.emit("error", Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));
  assert.deepEqual(exits, [1]);
  assert.deepEqual(said, ["Error: no space left on device\n"]);
});

// ── Unit: waiting for a Cube ────────────────────────────────────────────────

/** A clock and a sleep that move together, so the tests never wait. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function fakeGet(states: string[]) {
  let i = 0;
  return async () => ({ id: "cube_1", state: states[Math.min(i++, states.length - 1)] as string });
}

test("waitForCubeState returns the Cube once it is running, polling every 2 seconds", async () => {
  const clock = fakeClock();
  const seen: string[] = [];
  const cube = await waitForCubeState({
    cubeRef: "web",
    target: "running",
    timeoutS: 300,
    get: fakeGet(["pending", "booting", "running"]),
    onPoll: (s) => void seen.push(s),
    ...clock,
  });
  assert.equal(cube.state, "running");
  assert.deepEqual(seen, ["pending", "booting", "running"]);
  assert.deepEqual(clock.sleeps, [2000, 2000]);
});

test("waitForCubeState returns at once when the Cube is already there", async () => {
  const clock = fakeClock();
  const cube = await waitForCubeState({
    cubeRef: "web",
    target: "running",
    timeoutS: 10,
    get: fakeGet(["running"]),
    ...clock,
  });
  assert.equal(cube.state, "running");
  assert.deepEqual(clock.sleeps, []);
});

test("waitForCubeState times out with the last state in the message", async () => {
  const clock = fakeClock();
  await assert.rejects(
    waitForCubeState({
      cubeRef: "web",
      target: "running",
      timeoutS: 5,
      get: fakeGet(["booting"]),
      ...clock,
    }),
    /timed out after 5s waiting for cube web to be running \(last state: booting\)/
  );
  assert.deepEqual(clock.sleeps, [2000, 2000, 1000], "the last sleep stops at the deadline");
});

test("waitForCubeState fails fast on an error state, and on deleted", async () => {
  for (const dead of ["error", "deleted"]) {
    const clock = fakeClock();
    await assert.rejects(
      waitForCubeState({
        cubeRef: "web",
        target: "running",
        timeoutS: 300,
        get: fakeGet(["booting", dead]),
        ...clock,
      }),
      new RegExp(`cube web is in the "${dead}" state, so it will not become running`)
    );
    assert.deepEqual(clock.sleeps, [2000]);
  }
});

test("waitForCubeState can wait for error or deleted when that is the target", async () => {
  const clock = fakeClock();
  const cube = await waitForCubeState({
    cubeRef: "web",
    target: "deleted",
    timeoutS: 10,
    get: fakeGet(["stopping", "deleted"]),
    ...clock,
  });
  assert.equal(cube.state, "deleted");
});

test("waitForCubeState rides out a dropped connection, but not a 404 or three drops in a row", async () => {
  const clock = fakeClock();
  let n = 0;
  const flaky = async () => {
    if (++n === 1) throw new TypeError("fetch failed");
    return { id: "cube_1", state: "running" };
  };
  const cube = await waitForCubeState({ cubeRef: "web", target: "running", timeoutS: 30, get: flaky, ...clock });
  assert.equal(cube.state, "running");

  await assert.rejects(
    waitForCubeState({
      cubeRef: "web",
      target: "running",
      timeoutS: 30,
      get: async () => {
        throw new KrovaError("Cube not found", { status: 404 } as never);
      },
      ...fakeClock(),
    }),
    /Cube not found/
  );

  let drops = 0;
  await assert.rejects(
    waitForCubeState({
      cubeRef: "web",
      target: "running",
      timeoutS: 30,
      get: async () => {
        drops++;
        throw new TypeError("fetch failed");
      },
      ...fakeClock(),
    }),
    /fetch failed/
  );
  assert.equal(drops, 3);
});

test("parseWaitSeconds and parseWaitState validate their input", () => {
  assert.equal(parseWaitSeconds(undefined, "--timeout"), 300);
  assert.equal(parseWaitSeconds("90", "--timeout"), 90);
  for (const bad of ["0", "-1", "1.5", "abc", "", "5m"]) {
    assert.throws(() => parseWaitSeconds(bad, "--wait-timeout"), /--wait-timeout must be a whole number of seconds/, bad);
  }
  assert.equal(parseWaitState(undefined), "running");
  assert.equal(parseWaitState("Stopped"), "stopped");
  assert.throws(() => parseWaitState("ready"), /--state must be one of pending, booting, running/);
});

// ── End to end: the built CLI against a mock API ────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl: string;
let work: string;
let handler: Handler = (_req, res) => reply(res, 404, { error: "no handler" });

before(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  work = mkdtempSync(join(tmpdir(), "krova-findings-e2e-"));
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  rmSync(work, { recursive: true, force: true });
});

function reply(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const entry = join(import.meta.dirname, "..", "dist", "index.js");

interface RunOptions {
  /** Pass the API key, space and base URL as flags (default). */
  globals?: boolean;
  xdg?: string;
  env?: Record<string, string>;
}

function runCli(args: string[], o: RunOptions = {}) {
  const globals =
    o.globals === false ? [] : ["--api-key", "kro_test", "--space", "space_1", "--base-url", baseUrl];
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [entry, ...args, ...globals], {
      env: {
        ...process.env,
        HOME: "/nonexistent-krova-home",
        XDG_CONFIG_HOME: o.xdg ?? join(work, "xdg-default"),
        KROVA_API_KEY: "",
        KROVA_NO_KEYCHAIN: "1",
        ...o.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const cubeBody = (state: string) => ({
  id: "cube_1",
  name: "web",
  state,
  image: "ubuntu-24.04",
  publicIpv4: "203.0.113.5",
  terminationProtection: false,
  resources: { vcpu: 1, ramGb: 1, diskGb: 10 },
  costPerHour: 0.01,
});

function savedContexts(xdg: string): Array<{ name: string }> {
  return (JSON.parse(readFileSync(join(xdg, "krova", "config.json"), "utf8")) as { contexts: Array<{ name: string }> })
    .contexts;
}

// 1. --context names the saved context

test("e2e `krova auth login --context <name>` saves under that name", async () => {
  handler = (_req, res) => reply(res, 401, { error: "no" });
  const xdg = join(work, "xdg-auth");
  const r = await runCli(["auth", "login", "--api-key", "kro_other", "--context", "staging"], { xdg });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Saved context "staging"/);
  assert.deepEqual(savedContexts(xdg).map((c) => c.name), ["staging"]);
});

test("e2e `krova login --context <name>` saves under that name", { timeout: 30_000 }, async () => {
  handler = (req, res) => {
    const url = req.url ?? "";
    if (url.endsWith("/auth/cli/start")) {
      return reply(res, 200, { deviceCode: "dev_1", userCode: "ABCD-1234", verificationUri: "https://krova.cloud/cli", interval: 1, expiresIn: 60 });
    }
    if (url.endsWith("/auth/cli/poll")) return reply(res, 200, { apiKey: "kro_browser" });
    return reply(res, 401, { error: "no" });
  };
  const xdg = join(work, "xdg-login");
  const r = await runCli(["login", "--no-browser", "--context", "laptop", "--base-url", baseUrl], {
    xdg,
    globals: false,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Saved context "laptop"/);
  assert.deepEqual(savedContexts(xdg).map((c) => c.name), ["laptop"]);
});

// 2. one default in the help

test("`krova psql|redis|mysql --help` prints each default once", async () => {
  const psql = await runCli(["psql", "--help"], { globals: false });
  const user = psql.stdout.split("\n").find((l) => l.includes("--user")) ?? "";
  const db = psql.stdout.split("\n").find((l) => l.includes("--db")) ?? "";
  assert.equal(user.match(/default/g)?.length, 1, user);
  assert.equal(db.match(/default/g)?.length, 1, db);
  assert.match(user, /\(default: "postgres"\)/);

  const mysql = await runCli(["mysql", "--help"], { globals: false });
  const myUser = mysql.stdout.split("\n").find((l) => l.includes("--user")) ?? "";
  assert.equal(myUser.match(/default/g)?.length, 1, myUser);
  assert.match(myUser, /\(default: "root"\)/);

  const redis = await runCli(["redis", "--help"], { globals: false });
  const port = redis.stdout.split("\n").find((l) => l.includes("--port")) ?? "";
  assert.equal(port.match(/default/g)?.length, 1, port);
});

// 3. EPIPE

test("e2e `krova cubes list | head` ends quietly with status 0 when the reader closes early", { timeout: 30_000 }, async () => {
  const many = Array.from({ length: 6000 }, (_, i) => ({ ...cubeBody("running"), id: `cube_${i}`, name: `web-${i}` }));
  handler = (_req, res) => reply(res, 200, { cubes: many });
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [entry, "cubes", "list", "--api-key", "kro_test", "--space", "space_1", "--base-url", baseUrl],
      { env: { ...process.env, HOME: "/nonexistent-krova-home", XDG_CONFIG_HOME: join(work, "xdg-pipe"), KROVA_API_KEY: "" } }
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    // Read one chunk, then hang up like `head -1` does.
    child.stdout.once("data", () => child.stdout.destroy());
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
});

// 5. --wait and `cubes wait`

test("e2e `krova cubes wait` returns once the Cube is running", { timeout: 30_000 }, async () => {
  let gets = 0;
  handler = (req, res) => {
    const url = (req.url ?? "").split("?")[0] as string;
    if (url.endsWith("/cubes")) return reply(res, 200, { cubes: [cubeBody("booting")] });
    if (url.endsWith("/cubes/cube_1")) return reply(res, 200, { cube: cubeBody(++gets < 2 ? "booting" : "running") });
    return reply(res, 404, { error: "nope" });
  };
  const r = await runCli(["cubes", "wait", "web"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "Cube cube_1 is running\n");
  assert.equal(gets, 2);

  gets = 5;
  const asJson = await runCli(["cubes", "wait", "web", "--json"]);
  assert.equal(asJson.code, 0, asJson.stderr);
  assert.equal((JSON.parse(asJson.stdout) as { state: string }).state, "running");
});

test("e2e `krova cubes wait --timeout 1` gives up with a clear message and status 1", { timeout: 30_000 }, async () => {
  handler = (req, res) => {
    const url = (req.url ?? "").split("?")[0] as string;
    if (url.endsWith("/cubes")) return reply(res, 200, { cubes: [cubeBody("booting")] });
    return reply(res, 200, { cube: cubeBody("booting") });
  };
  const r = await runCli(["cubes", "wait", "web", "--timeout", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Error: timed out after 1s waiting for cube web to be running \(last state: booting\)/);
  assert.equal(r.stdout, "");
});

test("e2e `krova cubes wait` exits 1 when the Cube lands in error, and takes --state", async () => {
  handler = (req, res) => {
    const url = (req.url ?? "").split("?")[0] as string;
    if (url.endsWith("/cubes")) return reply(res, 200, { cubes: [cubeBody("error")] });
    return reply(res, 200, { cube: cubeBody("error") });
  };
  const r = await runCli(["cubes", "wait", "web"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Error: cube web is in the "error" state, so it will not become running/);

  const bad = await runCli(["cubes", "wait", "web", "--state", "ready"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--state must be one of/);

  const stopped = await runCli(["cubes", "wait", "web", "--state", "error"]);
  assert.equal(stopped.code, 0, stopped.stderr);
});

test("e2e `krova cubes create --wait` blocks until running and `--json` prints the final Cube", { timeout: 30_000 }, async () => {
  let gets = 0;
  handler = (req, res) => {
    const url = (req.url ?? "").split("?")[0] as string;
    if (req.method === "POST" && url.endsWith("/cubes")) return reply(res, 201, { cube: cubeBody("pending") });
    if (url.endsWith("/cubes/cube_1")) return reply(res, 200, { cube: cubeBody(++gets < 2 ? "booting" : "running") });
    return reply(res, 404, { error: "nope" });
  };
  const create = ["cubes", "create", "--name", "web", "--image", "ubuntu-24.04", "--ssh-key", "ssh-ed25519 AAAA test", "--wait"];

  const human = await runCli(create);
  assert.equal(human.code, 0, human.stderr);
  assert.equal(human.stdout, "Created cube cube_1 (pending)\nCube cube_1 is running\n");
  assert.equal(gets, 2);

  gets = 0;
  const json = await runCli([...create, "--json"]);
  assert.equal(json.code, 0, json.stderr);
  assert.equal((JSON.parse(json.stdout) as { state: string }).state, "running");

  // Without --wait nothing is polled and the output is what it always was.
  gets = 0;
  const plain = await runCli(create.slice(0, -1));
  assert.equal(plain.stdout, "Created cube cube_1 (pending)\n");
  assert.equal(gets, 0);
});

test("e2e `krova cubes create --wait --wait-timeout 1` fails with the cube id in the message", { timeout: 30_000 }, async () => {
  handler = (req, res) => {
    const url = (req.url ?? "").split("?")[0] as string;
    if (req.method === "POST" && url.endsWith("/cubes")) return reply(res, 201, { cube: cubeBody("pending") });
    return reply(res, 200, { cube: cubeBody("booting") });
  };
  const r = await runCli([
    "cubes", "create", "--name", "web", "--image", "ubuntu-24.04", "--ssh-key", "ssh-ed25519 AAAA test",
    "--wait", "--wait-timeout", "1",
  ]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Error: timed out after 1s waiting for cube cube_1 to be running \(last state: booting\)/);

  const bad = await runCli([
    "cubes", "create", "--name", "web", "--image", "ubuntu-24.04", "--ssh-key", "k", "--wait", "--wait-timeout", "soon",
  ]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--wait-timeout must be a whole number of seconds/);
});

// ── Base URL: a bare origin works for the CLI's own requests too ────────────

test("normalizeBaseUrl follows the SDK's rule", () => {
  assert.equal(normalizeBaseUrl("https://krova.cloud"), "https://krova.cloud/api/v1");
  assert.equal(normalizeBaseUrl("https://krova.cloud/"), "https://krova.cloud/api/v1");
  assert.equal(normalizeBaseUrl("  https://krova.cloud///  "), "https://krova.cloud/api/v1");
  assert.equal(normalizeBaseUrl("https://krova.cloud/api/v1/"), "https://krova.cloud/api/v1");
  assert.equal(normalizeBaseUrl("http://localhost:3000/custom/base"), "http://localhost:3000/custom/base");
  assert.equal(normalizeBaseUrl("https://krova.cloud/?x=1"), "https://krova.cloud/?x=1");
  assert.equal(normalizeBaseUrl("not a url"), "not a url");
});

test("e2e a bare origin in --base-url or KROVA_BASE_URL reaches /api/v1 on every request", async () => {
  const seen: string[] = [];
  handler = (req, res) => {
    seen.push(req.url ?? "");
    const url = (req.url ?? "").split("?")[0] as string;
    if (url === "/api/v1/space") return reply(res, 200, { id: "space_1", name: "Acme", slug: "acme" });
    if (url === "/api/v1/spaces/space_1/cubes") return reply(res, 200, { cubes: [] });
    return reply(res, 404, { error: "wrong path" });
  };
  const origin = baseUrl.replace(/\/api\/v1$/, "");

  // The CLI's own probe (auth status), with the flag.
  const flag = await runCli(["auth", "status", "--api-key", "kro_test", "--space", "space_1", "--base-url", `${origin}/`], {
    globals: false,
  });
  assert.equal(flag.code, 0, flag.stderr);
  assert.match(flag.stdout, /Authenticated\s+yes/i);

  // The same with the environment variable, and the SDK path (cubes list) too.
  const env = await runCli(["cubes", "list", "--api-key", "kro_test", "--space", "space_1"], {
    globals: false,
    env: { KROVA_BASE_URL: origin },
  });
  assert.equal(env.code, 0, env.stderr);
  assert.ok(seen.includes("/api/v1/space"), seen.join(", "));
  assert.ok(seen.every((u) => u.startsWith("/api/v1/")), seen.join(", "));
});
