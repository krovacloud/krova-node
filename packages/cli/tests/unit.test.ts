import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_BASE_URL,
  load,
  resolve,
  sanitizeContextName,
  save,
  upsert,
} from "../src/lib/config.js";
import { safeBrowserURL } from "../src/commands/login.js";
import {
  buildSSHArgs,
  knownHostsHost,
  validateSSHHost,
  validateSSHUser,
} from "../src/lib/ssh.js";
import { flattenRows } from "../src/commands/catalog.js";
import { cubesCommand } from "../src/commands/cubes.js";
import { parseListenAddr } from "../src/commands/webhooks.js";

test("parseListenAddr handles host:port, bare host, bare port, and IPv6", () => {
  assert.deepEqual(parseListenAddr("127.0.0.1:4666"), { host: "127.0.0.1", port: 4666 });
  assert.deepEqual(parseListenAddr("0.0.0.0:8080"), { host: "0.0.0.0", port: 8080 });
  // a bare hostname must be kept (previously it was replaced with 127.0.0.1)
  assert.deepEqual(parseListenAddr("localhost"), { host: "localhost", port: 4666 });
  // a bare port
  assert.deepEqual(parseListenAddr("9000"), { host: "127.0.0.1", port: 9000 });
  // bracketed + bare IPv6
  assert.deepEqual(parseListenAddr("[::1]:4666"), { host: "::1", port: 4666 });
  assert.deepEqual(parseListenAddr("::1"), { host: "::1", port: 4666 });
  // junk port falls back to the default
  assert.deepEqual(parseListenAddr("localhost:notaport"), { host: "localhost", port: 4666 });
});

test("flattenRows expands nested objects so pricing rates aren't dropped", () => {
  // Regression: `krova pricing` used to table only the `tiers` array and drop
  // `rates`/`currency`/`note`. flattenRows must surface those scalar/object
  // fields as key/value rows.
  const rows = flattenRows(
    Object.entries({
      currency: "USD",
      rates: { vcpuPerHour: 0.001, ramGbPerHour: 0.0025, diskGbPerHour: 0.00005 },
      note: "billed by the minute",
    })
  );
  const map = new Map(rows);
  assert.equal(map.get("currency"), "USD");
  assert.equal(map.get("rates.vcpuPerHour"), "0.001"); // nested object flattened
  assert.equal(map.get("rates.diskGbPerHour"), "0.00005");
  assert.equal(map.get("note"), "billed by the minute");
});

test("upsert only overwrites baseUrl with a non-empty value (no transient --base-url persistence)", () => {
  const cfg = { contexts: [], currentContext: "" } as Parameters<typeof upsert>[0];
  upsert(cfg, { name: "prod", apiKey: "kro_a", baseUrl: "https://krova.cloud/api/v1" });
  // A later merge without a baseUrl (e.g. caching a resolved space) must NOT
  // clear or change the stored base URL.
  upsert(cfg, { name: "prod", spaceId: "space_1" });
  assert.equal(cfg.contexts?.[0]?.baseUrl, "https://krova.cloud/api/v1");
  assert.equal(cfg.contexts?.[0]?.spaceId, "space_1");
});

test("validateSSHHost rejects option/metacharacter injection", () => {
  validateSSHHost("1.2.3.4");
  validateSSHHost("host.example.com");
  assert.throws(() => validateSSHHost("-oProxyCommand=evil"), /must not start with/);
  assert.throws(() => validateSSHHost("a b"), /whitespace or control/);
  assert.throws(() => validateSSHHost("a;rm -rf"), /disallowed character/);
  assert.throws(() => validateSSHHost("a$b"), /disallowed character/);
  assert.throws(() => validateSSHHost(""), /empty host/);
});

test("validateSSHUser allows empty, rejects leading dash + metachars", () => {
  validateSSHUser("");
  validateSSHUser("root");
  assert.throws(() => validateSSHUser("-x"), /must not start with/);
  assert.throws(() => validateSSHUser("a@b"), /disallowed character/);
});

test("knownHostsHost brackets non-default ports", () => {
  assert.equal(knownHostsHost("1.2.3.4", 22), "1.2.3.4");
  assert.equal(knownHostsHost("1.2.3.4", 0), "1.2.3.4");
  assert.equal(knownHostsHost("1.2.3.4", 2222), "[1.2.3.4]:2222");
});

test("buildSSHArgs: strict host-key opts, -- before destination, remote cmd appended", () => {
  const info = { host: "1.2.3.4", port: 2222, user: "root", hostKeys: [] };
  const args = buildSSHArgs(info, {
    knownHosts: "/tmp/kh",
    identity: "/tmp/id",
    localFwd: ["8080:localhost:80"],
    remoteCmd: ["uname", "-a"],
  });
  assert.deepEqual(args, [
    "-o", "UserKnownHostsFile=/tmp/kh",
    "-o", "StrictHostKeyChecking=yes",
    "-i", "/tmp/id",
    "-p", "2222",
    "-L", "8080:localhost:80",
    "--", "root@1.2.3.4",
    "uname", "-a",
  ]);
  // the `--` always immediately precedes the destination
  assert.equal(args[args.indexOf("--") + 1], "root@1.2.3.4");
});

test("safeBrowserURL: https ok, http only for loopback, scripts rejected", () => {
  assert.equal(safeBrowserURL("https://krova.cloud/cli?code=X"), "https://krova.cloud/cli?code=X");
  assert.equal(safeBrowserURL("http://localhost:3000/cli"), "http://localhost:3000/cli");
  assert.equal(safeBrowserURL("http://127.0.0.1/cli"), "http://127.0.0.1/cli");
  assert.equal(safeBrowserURL("http://evil.example.com"), null);
  assert.equal(safeBrowserURL("javascript:alert(1)"), null);
  assert.equal(safeBrowserURL("file:///etc/passwd"), null);
  assert.equal(safeBrowserURL("not a url"), null);
});

test("config resolve precedence: flag > env > context", () => {
  const cfg = {
    currentContext: "default",
    contexts: [{ name: "default", apiKey: "kro_ctx", spaceId: "spc_ctx", baseUrl: "https://ctx.test" }],
  };
  const prev = process.env.KROVA_API_KEY;
  process.env.KROVA_API_KEY = "kro_env";
  try {
    const flagWins = resolve(cfg, { apiKey: "kro_flag" });
    assert.equal(flagWins.apiKey, "kro_flag");
    assert.equal(flagWins.apiKeySource, "flag");
    const envWins = resolve(cfg, {});
    assert.equal(envWins.apiKey, "kro_env");
    assert.equal(envWins.apiKeySource, "env");
  } finally {
    if (prev === undefined) delete process.env.KROVA_API_KEY;
    else process.env.KROVA_API_KEY = prev;
  }
  const ctxWins = resolve({ ...cfg }, {});
  assert.equal(ctxWins.spaceId, "spc_ctx");
  assert.equal(ctxWins.baseUrl, "https://ctx.test");
});

test("resolve falls back to the default base URL", () => {
  const r = resolve({ contexts: [] }, {});
  assert.equal(r.baseUrl, DEFAULT_BASE_URL);
});

test("upsert merges non-empty fields; sanitizeContextName lowercases + hyphenates", () => {
  const cfg = { contexts: [{ name: "default", apiKey: "kro_old", spaceName: "Old" }] };
  upsert(cfg, { name: "default", apiKey: "kro_new" }); // spaceName must NOT be wiped
  assert.equal(cfg.contexts[0]!.apiKey, "kro_new");
  assert.equal(cfg.contexts[0]!.spaceName, "Old");
  assert.equal(sanitizeContextName("My Space"), "my-space");
});

test("legacy single-key config migrates to a default context", () => {
  const dir = mkdtempSync(join(tmpdir(), "krova-cli-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    // hand-write a legacy config, then load()
    mkdirSync(join(dir, "krova"), { recursive: true });
    writeFileSync(
      join(dir, "krova", "config.json"),
      JSON.stringify({ apiKey: "kro_legacy", spaceId: "spc_legacy", baseUrl: "https://legacy.test" })
    );
    const cfg = load();
    assert.equal(cfg.currentContext, "default");
    assert.equal(cfg.contexts?.[0]?.apiKey, "kro_legacy");
    // round-trips through save without legacy fields
    save(cfg);
    const again = load();
    assert.equal(again.contexts?.[0]?.spaceId, "spc_legacy");
    assert.equal((again as { apiKey?: string }).apiKey, undefined);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("cubes ssh-port describes the IN-CUBE port, never the host port", () => {
  // Regression: the option was documented as "the host port to expose SSH on"
  // while the value is sent to the API as `cubePort` — the port INSIDE the
  // Cube. Following the help text set the in-Cube port to a host-style value
  // (e.g. 30201), sshd was still on 22, and SSH silently became unreachable.
  // The host port is allocated by Krova and this command does not change it.
  const cubes = cubesCommand();
  const sshPort = cubes.commands.find((c) => c.name() === "ssh-port");
  assert.ok(sshPort, "ssh-port subcommand should exist");

  const desc = sshPort.description();
  assert.match(desc, /in-Cube|inside the Cube/i, "description must say in-Cube");
  assert.doesNotMatch(
    desc.replace(/not the host port/i, ""),
    /host port/i,
    "description must not describe --port as a host port",
  );

  const portOpt = sshPort.options.find((o) => o.long === "--port");
  assert.ok(portOpt, "--port option should exist");
  assert.match(
    portOpt.description,
    /INSIDE the Cube|in-Cube/i,
    "--port help must say the port is inside the Cube",
  );
  assert.doesNotMatch(
    portOpt.description,
    /host port/i,
    "--port help must not call it a host port",
  );
});

test("cubes restart exists and is described as a COLD restart", () => {
  // A `reboot` from inside a Cube looks equivalent but cannot change the
  // kernel: Firecracker treats a guest reboot as a shutdown and the kernel is
  // supplied by the host. If this command stops saying "cold", users will
  // reach for in-Cube reboot after an image update and silently keep the old
  // kernel — the failure is invisible, which is what makes the wording matter.
  const cubes = cubesCommand();
  const restart = cubes.commands.find((c) => c.name() === "restart");
  assert.ok(restart, "restart subcommand should exist");
  assert.match(
    restart.description(),
    /cold/i,
    "description must say this is a cold restart",
  );
  assert.match(
    restart.description(),
    /kernel/i,
    "description must say it picks up a refreshed kernel",
  );
});
