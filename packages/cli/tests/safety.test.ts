import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { displayKey, maskKey } from "../src/lib/config.js";
import {
  confirm,
  isOpenWhitelist,
  publicExposureWarning,
  shouldConfirm,
} from "../src/lib/safety.js";

const FULL_KEY = "kro_live_0123456789abcdef";

// --- Pure decision functions ------------------------------------------------

test("shouldConfirm asks only when stdin and stdout are both terminals", () => {
  assert.equal(shouldConfirm({}, { stdin: true, stdout: true }), true);
  assert.equal(shouldConfirm({}, { stdin: false, stdout: true }), false);
  assert.equal(shouldConfirm({}, { stdin: true, stdout: false }), false);
  assert.equal(shouldConfirm({}, { stdin: false, stdout: false }), false);
});

test("shouldConfirm never asks when --yes is given", () => {
  assert.equal(shouldConfirm({ yes: true }, { stdin: true, stdout: true }), false);
});

test("isOpenWhitelist: empty, 0.0.0.0/0 and ::/0 are open; a real CIDR is not", () => {
  assert.equal(isOpenWhitelist([]), true);
  assert.equal(isOpenWhitelist(["0.0.0.0/0"]), true);
  assert.equal(isOpenWhitelist(["::/0"]), true);
  assert.equal(isOpenWhitelist(["203.0.113.4/32", "0.0.0.0/0"]), true);
  assert.equal(isOpenWhitelist([" ::/0 "]), true);
  assert.equal(isOpenWhitelist(["203.0.113.0/24"]), false);
  assert.equal(isOpenWhitelist(["203.0.113.4/32", "2001:db8::/32"]), false);
});

test("isOpenWhitelist: any numerically zero prefix is open, however it is spelled", () => {
  for (const open of ["0.0.0.0/00", "0.0.0.0/000", "1.2.3.4/0", "::/00", "2001:db8::/0", " ::/0 "]) {
    assert.equal(isOpenWhitelist([open]), true, open);
  }
  for (const closed of ["0.0.0.0/32", "0.0.0.0/10", "10.0.0.0/8", "::/128", "0.0.0.0", "1.2.3.4/"]) {
    assert.equal(isOpenWhitelist([closed]), false, closed);
  }
});

test("isOpenWhitelist: the two IPv4 halves together cover everything, one alone does not", () => {
  assert.equal(isOpenWhitelist(["0.0.0.0/1", "128.0.0.0/1"]), true);
  assert.equal(isOpenWhitelist(["128.0.0.0/1", "203.0.113.4/32", "0.0.0.0/1"]), true);
  assert.equal(isOpenWhitelist(["0.0.0.0/1"]), false);
  assert.equal(isOpenWhitelist(["128.0.0.0/1"]), false);
  assert.equal(isOpenWhitelist(["0.0.0.0/1", "0.0.0.0/1"]), false);
  assert.equal(isOpenWhitelist(["0.0.0.0/1", "192.0.0.0/2"]), false);
});

test("confirm: y and yes say yes, anything else says no, and EOF says no with exit code 1", async () => {
  const ask = async (feed: (input: PassThrough) => void) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = confirm("Go? [y/N] ", { input, output });
    feed(input);
    return answer;
  };
  const saved = process.exitCode;
  try {
    process.exitCode = undefined;
    assert.equal(await ask((i) => i.write("y\n")), true);
    assert.equal(await ask((i) => i.write("YES\n")), true);
    assert.equal(await ask((i) => i.write("n\n")), false);
    assert.equal(await ask((i) => i.write("\n")), false);
    assert.equal(process.exitCode, undefined, "an answer, even no, is not an error");
    assert.equal(await ask((i) => i.end()), false);
    assert.equal(process.exitCode, 1, "EOF before an answer must exit non-zero");
  } finally {
    process.exitCode = saved;
  }
});

test("publicExposureWarning names the port, the cube and the tunnel alternative", () => {
  assert.equal(
    publicExposureWarning("web", 5432),
    "Warning: port 5432 on web will be reachable from the whole internet. Limit it with --whitelist <cidr>, or use a private tunnel instead: krova tunnel web 5432.",
  );
});

test("displayKey masks by default and prints the full key with --show-secrets", () => {
  assert.equal(displayKey(FULL_KEY, false), maskKey(FULL_KEY));
  assert.notEqual(displayKey(FULL_KEY, false), FULL_KEY);
  assert.equal(displayKey(FULL_KEY, true), FULL_KEY);
});

// --- Built CLI against a mock API and a temp config -------------------------

let server: Server;
let baseUrl = "";
let requests: string[] = [];
let lastPostBody: unknown;
let tmp = "";

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  requests.push(`${req.method} ${req.url}`);
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "GET" && req.url?.endsWith("/cubes")) {
    return send(200, { cubes: [{ id: "cube_1", name: "web" }] });
  }
  if (req.method === "GET" && req.url?.endsWith("/snapshots")) {
    return send(200, { snapshots: [{ id: "snap_1", name: "before-upgrade" }] });
  }
  if (req.method === "POST") {
    lastPostBody = JSON.parse(body || "{}");
    return send(201, {
      tcpMapping: { id: "map_1", cubePort: 5432, hostPort: 40001, host: "web.krova.cloud" },
    });
  }
  return send(200, {});
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "krova-safety-"));
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the BUILT CLI with its own config dir. stdin is a pipe, so never a TTY. */
function runCli(args: string[], configHome: string, withApiFlags = true): Promise<Run> {
  const entry = join(import.meta.dirname, "..", "dist", "index.js");
  const flags = withApiFlags
    ? ["--api-key", FULL_KEY, "--space", "space_1", "--base-url", baseUrl]
    : [];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args, ...flags], {
      env: {
        ...process.env,
        HOME: "/nonexistent-krova-home",
        XDG_CONFIG_HOME: configHome,
        KROVA_API_KEY: "",
        KROVA_CONTEXT: "",
      },
    });
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

function makeConfig(name: string): { home: string; file: string } {
  const home = join(tmp, name);
  mkdirSync(join(home, "krova"), { recursive: true });
  const file = join(home, "krova", "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      currentContext: "work",
      contexts: [
        { name: "work", apiKey: FULL_KEY, spaceId: "space_1", baseUrl },
        { name: "personal", apiKey: "kro_live_personal_secret_key", spaceId: "space_2", baseUrl },
      ],
    }),
    { mode: 0o600 },
  );
  return { home, file };
}

test("non-TTY: `cubes delete` and `snapshots rm` still run without a prompt", async () => {
  const { home } = makeConfig("noprompt");
  requests = [];
  const del = await runCli(["cubes", "delete", "web"], home);
  assert.equal(del.code, 0, del.stderr);
  assert.match(del.stdout, /Deleting cube cube_1/);
  assert.ok(requests.includes("DELETE /api/v1/spaces/space_1/cubes/cube_1"), requests.join("\n"));

  requests = [];
  const snap = await runCli(["snapshots", "rm", "web", "snap_1"], home);
  assert.equal(snap.code, 0, snap.stderr);
  assert.ok(
    requests.includes("DELETE /api/v1/spaces/space_1/cubes/cube_1/snapshots/snap_1"),
    requests.join("\n"),
  );

  const yes = await runCli(["cubes", "delete", "web", "--yes"], home);
  assert.equal(yes.code, 0, yes.stderr);
});

test("`tcp add` with no whitelist warns on stderr, keeps stdout clean and still adds", async () => {
  const { home } = makeConfig("tcpopen");
  const run = await runCli(["tcp", "add", "web", "--port", "5432", "--json"], home);
  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stderr,
    /Warning: port 5432 on web will be reachable from the whole internet\. Limit it with --whitelist <cidr>, or use a private tunnel instead: krova tunnel web 5432\./,
  );
  assert.equal(JSON.parse(run.stdout).id, "map_1");
});

test("`tcp add --whitelist 0.0.0.0/0` and `::/0` warn; a real CIDR does not", async () => {
  const { home } = makeConfig("tcpwl");
  for (const open of ["0.0.0.0/0", "::/0"]) {
    const run = await runCli(["tcp", "add", "web", "--port", "5432", "--whitelist", open], home);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /reachable from the whole internet/, open);
  }
  const closed = await runCli(
    ["tcp", "add", "web", "--port", "5432", "--whitelist", "203.0.113.0/24"],
    home,
  );
  assert.equal(closed.code, 0, closed.stderr);
  assert.doesNotMatch(closed.stderr, /Warning/);
  assert.deepEqual((lastPostBody as { whitelistedIps: string[] }).whitelistedIps, [
    "203.0.113.0/24",
  ]);
});

test("`whoami --show-secrets` prints the full key; the default stays masked (human and JSON)", async () => {
  const { home } = makeConfig("whoami");
  const masked = await runCli(["whoami", "--json"], home, false);
  const maskedJson = JSON.parse(masked.stdout);
  assert.equal(maskedJson.apiKeyMasked, maskKey(FULL_KEY));
  assert.equal(maskedJson.apiKey, undefined);
  assert.ok(!masked.stdout.includes(FULL_KEY));

  const human = await runCli(["whoami"], home, false);
  assert.ok(!human.stdout.includes(FULL_KEY));
  assert.ok(human.stdout.includes(maskKey(FULL_KEY)));

  const shown = await runCli(["whoami", "--show-secrets", "--json"], home, false);
  assert.equal(JSON.parse(shown.stdout).apiKey, FULL_KEY);
  const shownHuman = await runCli(["whoami", "--show-secrets"], home, false);
  assert.ok(shownHuman.stdout.includes(FULL_KEY));
});

test("`context list --json` and `auth status` honor --show-secrets", async () => {
  const { home } = makeConfig("ctxlist");
  const masked = await runCli(["context", "list", "--json"], home, false);
  assert.ok(!masked.stdout.includes(FULL_KEY));
  const shown = await runCli(["context", "list", "--json", "--show-secrets"], home, false);
  const work = JSON.parse(shown.stdout).contexts.find((c: { name: string }) => c.name === "work");
  assert.equal(work.apiKey, FULL_KEY);

  const status = await runCli(["auth", "status", "--offline"], home, false);
  assert.ok(!status.stdout.includes(FULL_KEY));
  const statusShown = await runCli(["auth", "status", "--offline", "--show-secrets"], home, false);
  assert.ok(statusShown.stdout.includes(FULL_KEY));
});

test("`auth logout` removes the current context and its key from the 0600 config", async () => {
  const { home, file } = makeConfig("logout");
  const run = await runCli(["auth", "logout"], home, false);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(
    run.stdout.trim(),
    "Logged out of work. The API key still works until you revoke it in the dashboard (Settings > API keys).\nNow using personal.",
  );
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(FULL_KEY), "the removed key must not stay in the file");
  const cfg = JSON.parse(text);
  assert.deepEqual(
    cfg.contexts.map((c: { name: string }) => c.name),
    ["personal"],
  );
  assert.equal(cfg.currentContext, "personal");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(run.stdout, /\nNow using personal\.\n$/);
});

test("`auth logout` of a non-current context does not announce a switch", async () => {
  const { home } = makeConfig("logout-quiet");
  const run = await runCli(["auth", "logout", "--context", "personal"], home, false);
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /Now using/);
});

test("`auth logout --json` of the current context reports the context that took over", async () => {
  const { home } = makeConfig("logout-json-current");
  const run = await runCli(["auth", "logout", "--json"], home, false);
  assert.deepEqual(JSON.parse(run.stdout), {
    context: "work",
    result: "logged_out",
    current: "personal",
  });
});

test("`auth logout` of the last context reports current as null", async () => {
  const { home } = makeConfig("logout-last");
  await runCli(["auth", "logout", "--context", "personal"], home, false);
  const run = await runCli(["auth", "logout", "--json"], home, false);
  assert.deepEqual(JSON.parse(run.stdout), { context: "work", result: "logged_out", current: null });
});

test("`auth logout --context <name> --json` removes that context only", async () => {
  const { home, file } = makeConfig("logout-named");
  const run = await runCli(["auth", "logout", "--context", "personal", "--json"], home, false);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    context: "personal",
    result: "logged_out",
    current: "work",
  });
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(
    cfg.contexts.map((c: { name: string }) => c.name),
    ["work"],
  );
  assert.equal(cfg.currentContext, "work");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("`auth logout` fails with one line when there is no context", async () => {
  const empty = join(tmp, "empty");
  mkdirSync(empty, { recursive: true });
  const none = await runCli(["auth", "logout"], empty, false);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /^Error: not logged in/m);

  const { home } = makeConfig("logout-missing");
  const missing = await runCli(["auth", "logout", "--context", "nope"], home, false);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Error: no context named "nope"/);
});
