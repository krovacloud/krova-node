// OS keychain access for API keys. macOS goes through the `security` CLI and
// Linux through `secret-tool` (libsecret). Both are called with argv arrays
// (spawnSync, never a shell string). Anything else, or any failure, is reported
// to the caller, which falls back to the 0600 config file.
//
// Why spawnSync: `load()` and `resolve()` in config.ts are synchronous and run
// in every command, so the keychain backend is synchronous too. The keychain is
// only touched when a stored key is actually needed (never when --api-key or
// KROVA_API_KEY wins).

import { spawnSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "krova-cli";
export const NO_KEYCHAIN_ENV = "KROVA_NO_KEYCHAIN";

const TIMEOUT_MS = 15_000;

export interface KeychainBackend {
  /** Human name for messages, e.g. "macOS Keychain". */
  readonly name: string;
  /** The stored secret, or undefined when there is no such item. Throws on any other failure. */
  get(account: string): string | undefined;
  /** Create or replace the item. Throws on failure. */
  set(account: string, secret: string): void;
  /** Remove the item; a missing item is not an error. Throws on any other failure. */
  delete(account: string): void;
}

/** Thrown when no keychain can be used at all (opted out, unsupported platform, tool missing). */
export class KeychainUnavailableError extends Error {
  constructor(
    message: string,
    readonly optOut = false,
  ) {
    super(message);
    this.name = "KeychainUnavailableError";
  }
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], input?: string, detached = false): RunResult {
  // `detached` is honored by spawnSync (libuv UV_PROCESS_DETACHED, i.e. setsid) but is
  // missing from @types/node's SpawnSyncOptions, hence the cast.
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input,
    timeout: TIMEOUT_MS,
    windowsHide: true,
    detached,
  } as Parameters<typeof spawnSync>[2] & { encoding: "utf8" });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new KeychainUnavailableError(`\`${cmd}\` was not found`);
    if (code === "ETIMEDOUT") throw new Error(`\`${cmd}\` timed out after ${TIMEOUT_MS / 1000}s`);
    throw new Error(`\`${cmd}\` failed: ${r.error.message}`);
  }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function assertSecret(secret: string): void {
  if (!secret || /[\r\n\0]/.test(secret)) throw new Error("the API key is empty or contains a line break");
}

function failure(cmd: string, r: RunResult): Error {
  const detail = r.stderr.trim().split("\n")[0] || `exit ${r.status}`;
  return new Error(`\`${cmd}\` failed: ${detail}`);
}

/** macOS: the `security` CLI (verified against `man security` on macOS and a live round trip).
 *
 *  The password never goes in argv: `add-generic-password ... -w` with NO value after
 *  the last option makes `security` prompt for it ("Put at end of command to be
 *  prompted (recommended)"), and the prompt reads stdin only when the process has no
 *  controlling terminal. A normal terminal run would read /dev/tty and ignore our pipe,
 *  so the child is spawned detached (setsid, no controlling terminal) and gets
 *  "<secret>\n<secret>\n" on stdin (prompt + retype). The write is verified by a read-back
 *  in config.ts, so a platform where this misbehaves falls back to the file. */
export function macosBackend(service = KEYCHAIN_SERVICE): KeychainBackend {
  return {
    name: "macOS Keychain",
    get(account) {
      const r = run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (r.status === 44) return undefined; // errSecItemNotFound
      if (r.status !== 0) throw failure("security", r);
      return r.stdout.replace(/\n$/, "");
    },
    set(account, secret) {
      assertSecret(secret);
      const r = run(
        "security",
        ["add-generic-password", "-U", "-s", service, "-a", account, "-l", `Krova CLI (${account})`, "-w"],
        `${secret}\n${secret}\n`,
        true,
      );
      if (r.status !== 0) throw failure("security", r);
    },
    delete(account) {
      const r = run("security", ["delete-generic-password", "-s", service, "-a", account]);
      if (r.status !== 0 && r.status !== 44) throw failure("security", r);
    },
  };
}

/** Linux: `secret-tool` from libsecret. `store` reads the secret from stdin when it is not a
 *  terminal (documented in secret-tool(1): "Everything up to EOF becomes the password"), so
 *  nothing secret is in argv. Not run on this build machine (macOS); the argv shapes follow the
 *  man page synopsis. */
export function secretToolBackend(service = KEYCHAIN_SERVICE): KeychainBackend {
  return {
    name: "Secret Service (secret-tool)",
    get(account) {
      const r = run("secret-tool", ["lookup", "service", service, "account", account]);
      if (r.status === 0) return r.stdout.replace(/\n$/, "");
      // Not found is exactly exit 1 with nothing on stdout or stderr; any other code is a failure.
      if (r.status === 1 && !r.stdout && !r.stderr.trim()) return undefined;
      throw failure("secret-tool", r);
    },
    set(account, secret) {
      assertSecret(secret);
      const r = run(
        "secret-tool",
        ["store", `--label=Krova CLI (${account})`, "service", service, "account", account],
        secret,
      );
      if (r.status !== 0) throw failure("secret-tool", r);
    },
    delete(account) {
      const r = run("secret-tool", ["clear", "service", service, "account", account]);
      if (r.status === 0) return;
      // A failed clear is only "nothing to delete" if a lookup confirms the item is gone.
      if (this.get(account) === undefined) return;
      throw failure("secret-tool", r);
    },
  };
}

/** Test seam: `undefined` uses the real platform backend, a backend replaces it,
 *  `null` means "no keychain available". */
let override: KeychainBackend | null | undefined;
export function setKeychainBackendForTests(b: KeychainBackend | null | undefined): void {
  override = b;
}

export function keychainOptedOut(): boolean {
  const v = (process.env[NO_KEYCHAIN_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** The backend to use for reads (an existing keychain context must be readable even
 *  under KROVA_NO_KEYCHAIN, which only governs where new keys are WRITTEN). */
export function readBackend(): KeychainBackend {
  if (override === null) throw new KeychainUnavailableError("no keychain is available");
  if (override) return override;
  if (process.platform === "darwin") return macosBackend();
  if (process.platform === "linux") return secretToolBackend();
  throw new KeychainUnavailableError(`no keychain support on ${process.platform}`);
}

/** The backend to use for writes: like readBackend, but KROVA_NO_KEYCHAIN=1 forces the file. */
export function writeBackend(): KeychainBackend {
  if (keychainOptedOut()) throw new KeychainUnavailableError(`${NO_KEYCHAIN_ENV} is set`, true);
  return readBackend();
}
