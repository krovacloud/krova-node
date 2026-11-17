import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { Command } from "commander";

import { authCommand } from "../src/commands/auth.js";
import { contextCommand } from "../src/commands/context.js";
import {
  KeychainUnavailableError,
  type KeychainBackend,
  secretToolBackend,
  setKeychainBackendForTests,
} from "../src/lib/keychain.js";
import {
  configPath,
  load,
  migrateKeysToKeychain,
  removeContext,
  renameContext,
  resolve,
  sanitizeContextName,
  save,
  setContextKey,
  type Config,
  type Context,
} from "../src/lib/config.js";
import { persistLogin } from "../src/lib/persist.js";

// --- harness ----------------------------------------------------------------

class FakeKeychain implements KeychainBackend {
  readonly name = "Fake Keychain";
  items = new Map<string, string>();
  gets = 0;
  failSet = false;
  failGet = false;
  failDelete = false;
  /** Store something other than what was written (a keychain that truncates). */
  corrupt = false;
  get(account: string): string | undefined {
    this.gets++;
    if (this.failGet) throw new Error("keychain is locked");
    return this.items.get(account);
  }
  set(account: string, secret: string): void {
    if (this.failSet) throw new Error("denied");
    this.items.set(account, this.corrupt ? secret.slice(0, 5) : secret);
  }
  delete(account: string): void {
    if (this.failDelete) throw new Error("cannot delete");
    this.items.delete(account);
  }
}

let dir: string;
let fake: FakeKeychain;
let stderr: string;
let stdout: string;
const savedEnv: Record<string, string | undefined> = {};
const realErr = process.stderr.write.bind(process.stderr);
const realOut = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "krova-keychain-"));
  for (const k of ["XDG_CONFIG_HOME", "KROVA_NO_KEYCHAIN", "KROVA_API_KEY", "KROVA_CONTEXT", "KROVA_SPACE_ID", "KROVA_BASE_URL"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.XDG_CONFIG_HOME = dir;
  fake = new FakeKeychain();
  setKeychainBackendForTests(fake);
  stderr = "";
  stdout = "";
  process.stderr.write = ((s: string | Uint8Array) => {
    stderr += String(s);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => {
    stdout += String(s);
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stderr.write = realErr;
  process.stdout.write = realOut;
  setKeychainBackendForTests(undefined);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "kro_live_0123456789abcdef";
const fileText = () => readFileSync(configPath(), "utf8");

function writeRaw(cfg: unknown): void {
  mkdirSync(join(dir, "krova"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg), { mode: 0o600 });
}

async function run(cmd: Command, argv: string[]): Promise<void> {
  // The real program adds these persistent flags to every command (see src/index.ts).
  const program = new Command()
    .exitOverride()
    .option("--json")
    .option("--api-key <key>")
    .option("--context <name>")
    .option("--timeout <duration>");
  program.addCommand(cmd);
  await program.parseAsync(["node", "krova", ...argv]);
}

// --- writes -----------------------------------------------------------------

test("login stores the key in the keychain and keeps it out of the config file", async () => {
  const r = await persistLogin({
    apiKey: KEY,
    baseUrl: "http://127.0.0.1:1",
    ctxName: "work",
    timeoutMs: 500,
  });
  assert.deepEqual(r.stored, { storage: "keychain", backend: "Fake Keychain" });
  assert.equal(fake.items.get("work"), KEY);
  assert.ok(!fileText().includes(KEY), "key must not be in the file");
  assert.match(fileText(), /"keyStorage": "keychain"/);
  assert.equal(stderr, "");
  assert.equal(statSync(configPath()).mode & 0o777, 0o600);
  // and it reads back through the normal resolve path
  const res = resolve(load(), {});
  assert.equal(res.apiKey, KEY);
  assert.equal(res.apiKeySource, "context");
  assert.equal(res.apiKeyStorage, "keychain");
});

test("no keychain: falls back to the 0600 file with one stderr line", () => {
  setKeychainBackendForTests(null);
  const ctxA: Context = { name: "a" };
  const cfg: Config = { contexts: [ctxA] };
  const r = setContextKey(ctxA, KEY);
  assert.equal(r.storage, "file");
  save(cfg);
  assert.match(fileText(), new RegExp(KEY));
  assert.equal(statSync(configPath()).mode & 0o777, 0o600);
  const lines = stderr.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^krova: OS keychain unavailable \(.+\); storing the API key in .+ \(mode 0600\) instead$/);
  assert.equal(load().contexts?.[0]?.keyStorage, "file");
});

test("a keychain that fails to write falls back to the file", () => {
  fake.failSet = true;
  const ctx = { name: "a" };
  assert.equal(setContextKey(ctx, KEY).storage, "file");
  assert.equal((ctx as { apiKey?: string }).apiKey, KEY);
  assert.match(stderr, /OS keychain unavailable \(denied\)/);
});

test("a keychain that returns something else is rejected, cleaned up and falls back", () => {
  fake.corrupt = true;
  const ctx = { name: "a" };
  assert.equal(setContextKey(ctx, KEY).storage, "file");
  assert.equal(fake.items.has("a"), false, "the bad item is removed");
  assert.match(stderr, /did not return the stored key/);
});

test("KROVA_NO_KEYCHAIN=1 forces the file, silently, without touching the keychain", async () => {
  process.env.KROVA_NO_KEYCHAIN = "1";
  const r = await persistLogin({ apiKey: KEY, baseUrl: "http://127.0.0.1:1", ctxName: "ci", timeoutMs: 500 });
  assert.equal(r.stored.storage, "file");
  assert.equal(fake.items.size, 0);
  assert.equal(fake.gets, 0);
  assert.equal(stderr, "");
  assert.match(fileText(), new RegExp(KEY));
});

test("re-login that falls back to the file drops the stale keychain item", () => {
  const ctx = { name: "a", keyStorage: "keychain" as const };
  fake.items.set("a", "old");
  process.env.KROVA_NO_KEYCHAIN = "1";
  assert.equal(setContextKey(ctx, KEY).storage, "file");
  assert.equal(fake.items.has("a"), false);
});

// --- reads ------------------------------------------------------------------

test("--api-key and KROVA_API_KEY win and never read the keychain", () => {
  writeRaw({ currentContext: "a", contexts: [{ name: "a", keyStorage: "keychain" }] });
  fake.items.set("a", KEY);
  const viaFlag = resolve(load(), { apiKey: "flag_key" });
  assert.equal(viaFlag.apiKey, "flag_key");
  assert.equal(viaFlag.apiKeySource, "flag");
  assert.equal(viaFlag.apiKeyStorage, "");
  process.env.KROVA_API_KEY = "env_key";
  const viaEnv = resolve(load(), {});
  assert.equal(viaEnv.apiKey, "env_key");
  assert.equal(viaEnv.apiKeySource, "env");
  assert.equal(fake.gets, 0);
});

test("file contexts keep working unchanged and never touch the keychain", () => {
  writeRaw({ currentContext: "old", contexts: [{ name: "old", apiKey: KEY, spaceId: "sp_1" }] });
  const res = resolve(load(), {});
  assert.equal(res.apiKey, KEY);
  assert.equal(res.apiKeyStorage, "file");
  assert.equal(fake.gets, 0);
  // a plain save does not rewrite the shape of an untouched file context
  save(load());
  assert.deepEqual(JSON.parse(fileText()).contexts[0], { name: "old", apiKey: KEY, spaceId: "sp_1" });
});

test("an unreadable keychain warns on stderr and yields no key instead of crashing", () => {
  writeRaw({ currentContext: "a", contexts: [{ name: "a", keyStorage: "keychain" }] });
  fake.failGet = true;
  const res = resolve(load(), {});
  assert.equal(res.apiKey, "");
  assert.match(stderr, /could not read the API key for context "a" from the OS keychain \(keychain is locked\)/);
});

test("a keychain context whose item is gone says so", () => {
  writeRaw({ currentContext: "a", contexts: [{ name: "a", keyStorage: "keychain" }] });
  assert.equal(resolve(load(), {}).apiKey, "");
  assert.match(stderr, /is not in the OS keychain/);
});

// --- logout, delete, rename -------------------------------------------------

function seedKeychainContexts(): void {
  writeRaw({
    currentContext: "a",
    contexts: [
      { name: "a", keyStorage: "keychain", spaceId: "sp_a" },
      { name: "b", keyStorage: "keychain", spaceId: "sp_b" },
    ],
  });
  fake.items.set("a", "key_a");
  fake.items.set("b", "key_b");
}

test("auth logout removes the keychain item", async () => {
  seedKeychainContexts();
  await run(authCommand(), ["auth", "logout", "--context", "a"]);
  assert.equal(fake.items.has("a"), false);
  assert.equal(fake.items.get("b"), "key_b");
  assert.deepEqual(load().contexts!.map((c) => c.name), ["b"]);
});

test("context delete removes the keychain item", async () => {
  seedKeychainContexts();
  await run(contextCommand(), ["context", "delete", "b"]);
  assert.equal(fake.items.has("b"), false);
  assert.equal(fake.items.get("a"), "key_a");
});

test("context rename moves the keychain item and the key never reaches the file", async () => {
  seedKeychainContexts();
  await run(contextCommand(), ["context", "rename", "a", "prod"]);
  assert.equal(fake.items.has("a"), false);
  assert.equal(fake.items.get("prod"), "key_a");
  assert.ok(!fileText().includes("key_a"));
  const cfg = load();
  assert.equal(cfg.currentContext, "prod");
  assert.equal(resolve(cfg, {}).apiKey, "key_a");
});

test("context rename leaves everything alone when the keychain cannot take the new item", async () => {
  seedKeychainContexts();
  fake.failSet = true;
  await assert.rejects(run(contextCommand(), ["context", "rename", "a", "prod"]), /could not move the key/);
  assert.equal(fake.items.get("a"), "key_a");
  assert.equal(load().contexts?.[0]?.name, "a");
});

test("context list --json shows where each key lives and masks it unless --show-secrets", async () => {
  seedKeychainContexts();
  await run(contextCommand(), ["context", "list", "--json"]);
  const masked = JSON.parse(stdout);
  assert.equal(masked.contexts[0].keyStorage, "keychain");
  assert.notEqual(masked.contexts[0].apiKey, "key_a");
  stdout = "";
  const withSecrets = contextCommand();
  await run(withSecrets, ["context", "list", "--json", "--show-secrets"]);
  assert.equal(JSON.parse(stdout).contexts[0].apiKey, "key_a");
});

// --- migrate ----------------------------------------------------------------

test("migrate-keychain moves file keys into the keychain after a matching read-back", async () => {
  writeRaw({
    currentContext: "a",
    contexts: [
      { name: "a", apiKey: "key_a" },
      { name: "b", apiKey: "key_b", keyStorage: "file" },
      { name: "c", keyStorage: "keychain" },
    ],
  });
  fake.items.set("c", "key_c");
  await run(authCommand(), ["auth", "migrate-keychain", "--json"]);
  const out = JSON.parse(stdout);
  assert.deepEqual(
    out.results.map((x: { context: string; result: string }) => [x.context, x.result]),
    [["a", "migrated"], ["b", "migrated"], ["c", "skipped"]],
  );
  assert.equal(fake.items.get("a"), "key_a");
  assert.equal(fake.items.get("b"), "key_b");
  assert.ok(!fileText().includes("key_a") && !fileText().includes("key_b"));
  assert.equal(resolve(load(), {}).apiKey, "key_a");
});

test("migrate-keychain keeps the file key when the read-back does not match", () => {
  writeRaw({ currentContext: "a", contexts: [{ name: "a", apiKey: KEY }] });
  fake.corrupt = true;
  const { entries } = migrateKeysToKeychain(load());
  assert.equal(entries[0]?.result, "failed");
  assert.equal(fake.items.has("a"), false);
  assert.match(fileText(), new RegExp(KEY));
  assert.equal(load().contexts?.[0]?.keyStorage, undefined);
});

test("migrate-keychain explains when there is no keychain or it is opted out", async () => {
  writeRaw({ currentContext: "a", contexts: [{ name: "a", apiKey: KEY }] });
  setKeychainBackendForTests(null);
  await assert.rejects(run(authCommand(), ["auth", "migrate-keychain"]), /no OS keychain available/);
  setKeychainBackendForTests(fake);
  process.env.KROVA_NO_KEYCHAIN = "1";
  await assert.rejects(run(authCommand(), ["auth", "migrate-keychain"]), /unset KROVA_NO_KEYCHAIN/);
  assert.match(fileText(), new RegExp(KEY));
  assert.ok(new KeychainUnavailableError("x", true).optOut);
});

// --- status -----------------------------------------------------------------

test("auth status --offline --json reports the storage", async () => {
  seedKeychainContexts();
  await run(authCommand(), ["auth", "status", "--offline", "--json"]);
  const out = JSON.parse(stdout);
  assert.equal(out.apiKeySource, "context");
  assert.equal(out.apiKeyStorage, "keychain");
  assert.equal(out.apiKey, undefined);
});

// --- review fixes -----------------------------------------------------------

/** A fake `secret-tool` on PATH: `lookup` prints FAKE_KEY (exit FAKE_LOOKUP_EXIT, default 0 when
 *  FAKE_KEY is set, else 1 with no output); `clear` exits FAKE_CLEAR_EXIT silently. */
function withFakeSecretTool(env: Record<string, string>, fn: () => void): void {
  const bin = mkdtempSync(join(tmpdir(), "krova-fake-st-"));
  const script = join(bin, "secret-tool");
  writeFileSync(
    script,
    `#!/bin/sh
case "$1" in
  lookup)
    if [ -n "$FAKE_LOOKUP_EXIT" ]; then echo "boom" >&2; exit "$FAKE_LOOKUP_EXIT"; fi
    if [ -n "$FAKE_KEY" ]; then printf %s "$FAKE_KEY"; exit 0; fi
    exit 1;;
  clear) exit "\${FAKE_CLEAR_EXIT:-0}";;
esac
exit 3
`,
    { mode: 0o755 },
  );
  const saved: Record<string, string | undefined> = { PATH: process.env.PATH };
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  process.env.PATH = `${bin}:${process.env.PATH}`;
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(bin, { recursive: true, force: true });
  }
}

test("secret-tool lookup: only exit 1 with no output is 'not found'; other codes throw", () => {
  const b = secretToolBackend();
  withFakeSecretTool({}, () => assert.equal(b.get("a"), undefined));
  withFakeSecretTool({ FAKE_KEY: "k1" }, () => assert.equal(b.get("a"), "k1"));
  withFakeSecretTool({ FAKE_LOOKUP_EXIT: "2" }, () => assert.throws(() => b.get("a"), /secret-tool.*failed/));
  withFakeSecretTool({ FAKE_LOOKUP_EXIT: "1" }, () => assert.throws(() => b.get("a"), /boom/));
});

test("secret-tool clear that fails silently is an error while lookup still finds the key", () => {
  const b = secretToolBackend();
  withFakeSecretTool({ FAKE_CLEAR_EXIT: "1", FAKE_KEY: "still-here" }, () =>
    assert.throws(() => b.delete("a"), /secret-tool.*failed/),
  );
  // a failed clear with nothing left to delete is fine
  withFakeSecretTool({ FAKE_CLEAR_EXIT: "1" }, () => b.delete("a"));
  withFakeSecretTool({ FAKE_CLEAR_EXIT: "0", FAKE_KEY: "x" }, () => b.delete("a"));
});

test("context list without --show-secrets does not read the keychain", async () => {
  seedKeychainContexts();
  await run(contextCommand(), ["context", "list", "--json"]);
  assert.equal(fake.gets, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.contexts[0].apiKey, "****");
  assert.equal(out.contexts[0].keyStorage, "keychain");
  stdout = "";
  await run(contextCommand(), ["context", "list"]);
  assert.equal(fake.gets, 0);
});

test("save writes atomically: no temp file is left and the mode stays 0600", () => {
  save({ currentContext: "a", contexts: [{ name: "a", apiKey: KEY }] });
  save({ currentContext: "a", contexts: [{ name: "a", apiKey: KEY, spaceId: "sp" }] });
  assert.deepEqual(readdirSync(join(dir, "krova")), ["config.json"]);
  assert.equal(statSync(configPath()).mode & 0o777, 0o600);
});

test("a save that fails during rename leaves the old keychain item and the old name", () => {
  seedKeychainContexts();
  const cfg = load();
  assert.throws(
    () =>
      renameContext(cfg, "a", "prod", () => {
        throw new Error("disk full");
      }),
    /disk full/,
  );
  assert.equal(fake.items.get("a"), "key_a");
  assert.equal(fake.items.has("prod"), false, "the new item is rolled back");
  assert.equal(cfg.contexts?.[0]?.name, "a");
  assert.equal(cfg.currentContext, "a");
});

test("a save that fails during delete leaves the keychain item and the context", () => {
  seedKeychainContexts();
  const cfg = load();
  assert.throws(
    () =>
      removeContext(cfg, "a", () => {
        throw new Error("disk full");
      }),
    /disk full/,
  );
  assert.equal(fake.items.get("a"), "key_a");
  assert.deepEqual(cfg.contexts?.map((c) => c.name), ["a", "b"]);
  assert.equal(cfg.currentContext, "a");
});

test("context names that start with '-' are rejected", async () => {
  assert.throws(() => sanitizeContextName("-x"), /cannot start with "-"/);
  assert.throws(() => sanitizeContextName("  --evil"), /cannot start with "-"/);
  assert.equal(sanitizeContextName(" My Space "), "my-space");
  await assert.rejects(
    persistLogin({ apiKey: KEY, baseUrl: "http://127.0.0.1:1", ctxName: "-a", timeoutMs: 500 }),
    /cannot start with "-"/,
  );
  seedKeychainContexts();
  await assert.rejects(run(contextCommand(), ["context", "rename", "a", "--", "-b"]), /cannot start with "-"/);
  assert.equal(fake.items.get("a"), "key_a");
});
