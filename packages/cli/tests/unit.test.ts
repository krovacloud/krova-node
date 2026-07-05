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
