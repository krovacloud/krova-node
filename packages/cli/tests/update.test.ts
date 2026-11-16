import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { compareVersions, parseVersion } from "../src/lib/semver.js";

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
) as { version: string };
const CLI_VERSION = pkg.version;

test("compareVersions orders releases by major, minor and patch", () => {
  assert.equal(compareVersions("0.7.0", "0.7.0"), 0);
  assert.ok(compareVersions("0.7.0", "0.7.1") < 0);
  assert.ok(compareVersions("0.7.1", "0.7.0") > 0);
  assert.ok(compareVersions("0.9.9", "1.0.0") < 0);
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  // Build metadata does not affect ordering; a leading v is tolerated.
  assert.equal(compareVersions("v1.2.3+build.5", "1.2.3"), 0);
});

test("compareVersions puts a pre-release below its release", () => {
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-beta") < 0);
  assert.ok(compareVersions("1.0.0-rc.2", "1.0.0-rc.10") < 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.1-rc.1") < 0);
  assert.equal(parseVersion("nope"), undefined);
});

// ── End to end: the real CLI entry point against a mock npm registry ────────

let server: Server;
let registryUrl: string;
let reply: (res: ServerResponse) => void;
let seen: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (!req.url?.endsWith("/%2fcli/latest") && !req.url?.endsWith("/latest")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    reply(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  registryUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

function serveVersion(version: string): void {
  reply = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "@krovacloud/cli", version }));
  };
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // The BUILT entry, the file `npx krova` runs.
  const entry = join(import.meta.dirname, "..", "dist", "index.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: {
        ...process.env,
        HOME: "/nonexistent-krova-home",
        KROVA_API_KEY: "",
        KROVA_NPM_REGISTRY: registryUrl,
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

test("`krova update` says the install is current when the registry matches it", async () => {
  serveVersion(CLI_VERSION);
  const run = await runCli(["update"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `krova ${CLI_VERSION} is the latest version.\n`);
});

test("`krova update` names the newer version and the command that installs it", async () => {
  serveVersion("99.0.0");
  seen = [];
  const run = await runCli(["update"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(seen, ["GET /@krovacloud%2fcli/latest"]);
  assert.equal(
    run.stdout,
    `krova 99.0.0 is available (you have ${CLI_VERSION}). ` +
      "Update with: npm install -g @krovacloud/cli@latest\n"
  );
  assert.equal(run.stderr, "");
});

test("`krova update --json` prints the documented object on stdout", async () => {
  serveVersion("99.0.0");
  const run = await runCli(["update", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    current: CLI_VERSION,
    latest: "99.0.0",
    updateAvailable: true,
    command: "npm install -g @krovacloud/cli@latest",
  });
});

test("`krova update` fails with the registry reason when the check cannot run", async () => {
  reply = (res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  };
  const run = await runCli(["update"]);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /^Error: could not check the npm registry: .+HTTP 503/);
  // No generic "could not reach <api>" hint: this check talks to npm.
  assert.equal(run.stderr.trimEnd().split("\n").length, 1);

  reply = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not json at all");
  };
  const bad = await runCli(["update", "--json"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, "");
  assert.match(
    bad.stderr,
    /^Error: could not check the npm registry: the response was not valid JSON/
  );
});
