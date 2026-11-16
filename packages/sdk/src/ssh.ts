/**
 * `@krovacloud/sdk/ssh` — run commands and move files on a Cube over its own SSH.
 *
 * Node only. Krova has no exec or files API: the commands and the bytes go
 * straight from your process to the Cube's sshd, authenticated with a private
 * key you supply. The Krova API is used for one thing, the Cube's address and
 * its pinned host keys (`cubes.ssh()`), so the connection is verified strictly:
 * a host key that does not match is refused, and there is no way to switch the
 * check off.
 *
 * @example
 * ```ts
 * import { KrovaClient } from "@krovacloud/sdk";
 * import { connectCube } from "@krovacloud/sdk/ssh";
 *
 * const krova = new KrovaClient({ apiKey: process.env.KROVA_API_KEY! });
 * const shell = await connectCube(krova, spaceId, cubeId, { privateKey });
 * try {
 *   const { stdout, exitCode } = await shell.run(["ls", "-la", "/srv"]);
 * } finally {
 *   await shell.close();
 * }
 * ```
 */
import { createHash } from "node:crypto";
import ssh2, { type SFTPWrapper, type Client as SshClient } from "ssh2";
import type { CubeSshInfo } from "./client.js";

// ssh2 is CommonJS; Node's named-export detection only finds some of its exports, so take them off the default.
const { Client } = ssh2;

/** A host public key as the Krova API returns it: `key` is the base64 blob of the OpenSSH `.pub` line. */
export interface HostKey {
  type: string;
  key: string;
}

/** Base class for every error this module throws on its own. */
export class SshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshError";
  }
}

/** The Cube presented a host key that is not one of the pinned keys (or there were no keys to pin). */
export class HostKeyMismatchError extends SshError {
  /** `SHA256:...` fingerprint of the key the server presented, when it presented one. */
  readonly fingerprint: string | undefined;
  constructor(message: string, fingerprint?: string) {
    super(message);
    this.name = "HostKeyMismatchError";
    this.fingerprint = fingerprint;
  }
}

/** `run()` hit its `timeoutMs`; the channel was closed. */
export class RunTimeoutError extends SshError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Command timed out after ${timeoutMs} ms.`);
    this.name = "RunTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/**
 * POSIX single-quote escape: the result is one shell word that expands to
 * exactly `arg`. Nothing inside is interpreted (`$()`, backticks, `*`, newlines).
 * A NUL byte cannot exist in a command line and is refused.
 */
export function shellQuote(arg: string): string {
  if (arg.includes("\0")) {
    throw new TypeError("Shell arguments cannot contain a NUL byte.");
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws a `TypeError` unless `name` is a valid shell variable name. */
export function assertEnvName(name: string): void {
  if (!ENV_NAME.test(name)) {
    throw new TypeError(`Invalid environment variable name: ${JSON.stringify(name)}.`);
  }
}

/**
 * Build the remote command line. A string runs as written; a string array has
 * each element quoted. `cwd` and `env` become `cd ... && export ... && ...`, with a
 * string command wrapped in a group so both apply to all of it.
 */
export function buildCommand(
  command: string | readonly string[],
  opts: { cwd?: string | undefined; env?: Readonly<Record<string, string>> | undefined } = {},
): string {
  const body =
    typeof command === "string" ? command : command.map((part) => shellQuote(part)).join(" ");
  if (body.trim() === "") throw new TypeError("Command is empty.");
  const pre: string[] = [];
  if (opts.cwd !== undefined) pre.push(`cd ${shellQuote(opts.cwd)}`);
  const entries = Object.entries(opts.env ?? {});
  if (entries.length > 0) {
    const assigns = entries.map(([name, value]) => {
      assertEnvName(name);
      return `${name}=${shellQuote(value)}`;
    });
    pre.push(`export ${assigns.join(" ")}`);
  }
  if (pre.length === 0) return body;
  const wrapped = typeof command === "string" ? `{\n${body}\n}` : body;
  return `${pre.join(" && ")} && ${wrapped}`;
}

// ---------------------------------------------------------------------------
// Host keys
// ---------------------------------------------------------------------------

/**
 * True when `presented` (the raw SSH host-key blob ssh2 hands the verifier)
 * equals the decoded `key` of one of `pinned`, byte for byte. Fails closed: an
 * empty list, an empty blob or an undecodable entry never matches.
 */
export function hostKeyMatches(presented: Uint8Array, pinned: readonly HostKey[]): boolean {
  if (presented.length === 0) return false;
  const blob = Buffer.from(presented);
  for (const entry of pinned) {
    if (typeof entry.key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.key)) continue;
    const decoded = Buffer.from(entry.key, "base64");
    if (decoded.length > 0 && decoded.equals(blob)) return true;
  }
  return false;
}

/** `SHA256:<base64>` fingerprint of a host-key blob, as `ssh-keygen -l` prints it. */
export function hostKeyFingerprint(presented: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(presented).digest("base64").replace(/=+$/, "")}`;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Working directory on the Cube; quoted by the SDK. */
  cwd?: string;
  /** Environment variables for the command; names are validated, values quoted. */
  env?: Record<string, string>;
  /** Close the channel and reject with {@link RunTimeoutError} after this many milliseconds. */
  timeoutMs?: number;
  /** Written to the command's stdin, which is then closed. Without it stdin is closed at once. */
  stdin?: string | Uint8Array;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** `null` when the command was killed by a signal or the channel closed without a status. */
  exitCode: number | null;
  /** Signal name (for example `TERM`) when the command was killed by one. */
  signal?: string;
}

export interface ConnectSshOptions {
  host: string;
  port?: number;
  username: string;
  /** OpenSSH or PEM private key. Used for this connection only; the SDK never stores or logs it. */
  privateKey: string | Uint8Array;
  passphrase?: string;
  /** Host keys the server must present one of. An empty list refuses the connection. */
  hostKeys: readonly HostKey[];
  /** Handshake timeout in milliseconds. Default 20000. */
  readyTimeoutMs?: number;
}

export interface ConnectCubeOptions {
  /** OpenSSH or PEM private key whose public half is in the Cube's `authorized_keys`. */
  privateKey: string | Uint8Array;
  /** For an encrypted `privateKey`. */
  passphrase?: string;
  /** Handshake timeout in milliseconds. Default 20000. */
  readyTimeoutMs?: number;
  /** Pin these keys instead of the ones `cubes.ssh()` returns, for callers that keep their own. */
  hostKeys?: readonly HostKey[];
}

/** The slice of `KrovaClient` that `connectCube` uses. */
export interface CubeSshSource {
  cubes: { ssh(spaceId: string, cubeId: string): Promise<CubeSshInfo> };
}

function redact(message: string, secrets: readonly (string | undefined)[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

/** An open SSH connection to one Cube. */
export class CubeShell {
  /** Address the connection went to. */
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly files: CubeFiles;

  readonly #client: SshClient;
  #closed = false;

  /** @internal Use {@link connectCube} or {@link connectSsh}. */
  constructor(client: SshClient, host: string, port: number, user: string) {
    this.#client = client;
    this.host = host;
    this.port = port;
    this.user = user;
    // After the handshake a dropped connection must not crash the process.
    client.on("error", () => {});
    client.on("close", () => {
      this.#closed = true;
    });
    this.files = new CubeFiles(() => this.#sftp());
  }

  #assertOpen(): void {
    if (this.#closed) throw new SshError("The SSH connection is closed.");
  }

  #sftpPromise: Promise<SFTPWrapper> | undefined;

  #sftp(): Promise<SFTPWrapper> {
    this.#assertOpen();
    this.#sftpPromise ??= new Promise<SFTPWrapper>((resolve, reject) => {
      this.#client.sftp((err, sftp) => {
        if (err) {
          this.#sftpPromise = undefined;
          reject(new SshError(`Could not open SFTP: ${err.message}`));
          return;
        }
        sftp.on("close", () => {
          this.#sftpPromise = undefined;
        });
        resolve(sftp);
      });
    });
    return this.#sftpPromise;
  }

  /** Run a command. A string runs as written by the remote shell; a string array is quoted argument by argument. */
  run(command: string | readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const { timeoutMs } = options;
    if (timeoutMs !== undefined && !(timeoutMs > 0)) {
      return Promise.reject(new TypeError("timeoutMs must be a positive number."));
    }
    let line: string;
    try {
      this.#assertOpen();
      line = buildCommand(command, { cwd: options.cwd, env: options.env });
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise<RunResult>((resolve, reject) => {
      this.#client.exec(line, (err, stream) => {
        if (err) {
          reject(new SshError(`Could not start the command: ${err.message}`));
          return;
        }
        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            timedOut = true;
            stream.close();
          }, timeoutMs);
        }
        stream.on("data", (chunk: Buffer) => out.push(chunk));
        stream.stderr.on("data", (chunk: Buffer) => errOut.push(chunk));
        stream.on("error", (e: Error) => {
          if (timer) clearTimeout(timer);
          reject(new SshError(`The command channel failed: ${e.message}`));
        });
        stream.on("close", (code?: number | null, signal?: string | null) => {
          if (timer) clearTimeout(timer);
          if (timedOut) {
            reject(new RunTimeoutError(timeoutMs as number));
            return;
          }
          const result: RunResult = {
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(errOut).toString("utf8"),
            exitCode: typeof code === "number" ? code : null,
          };
          if (typeof signal === "string" && signal !== "") result.signal = signal;
          resolve(result);
        });
        if (options.stdin !== undefined) stream.end(toBuffer(options.stdin));
        else stream.end();
      });
    });
  }

  /** Close the connection. Safe to call twice. */
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#client.once("close", () => resolve());
      this.#client.end();
    });
  }
}

/** File transfer over the connection's SFTP subsystem. Remote paths are literal: `~` and `$VAR` are not expanded. */
export class CubeFiles {
  readonly #sftp: () => Promise<SFTPWrapper>;

  /** @internal */
  constructor(sftp: () => Promise<SFTPWrapper>) {
    this.#sftp = sftp;
  }

  /** Create or overwrite `remotePath` with `data` (strings are UTF-8). */
  async write(remotePath: string, data: string | Uint8Array): Promise<void> {
    const sftp = await this.#sftp();
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath);
      ws.once("error", reject);
      ws.once("close", () => resolve());
      ws.end(toBuffer(data));
    });
  }

  /** Read the whole of `remotePath` into memory. */
  async read(remotePath: string): Promise<Uint8Array> {
    const sftp = await this.#sftp();
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const rs = sftp.createReadStream(remotePath);
      rs.on("data", (chunk: Buffer) => chunks.push(chunk));
      rs.once("error", reject);
      rs.once("close", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
  }

  /** Copy a local file to `remotePath`. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.#sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Copy `remotePath` to a local file. */
  async download(remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.#sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()));
    });
  }
}

/**
 * Connect to a server over SSH with a private key, accepting only a host key
 * from `hostKeys`. Most callers want {@link connectCube}.
 */
export function connectSsh(options: ConnectSshOptions): Promise<CubeShell> {
  const { host, username, hostKeys, passphrase } = options;
  const port = options.port ?? 22;
  if (hostKeys.length === 0) {
    return Promise.reject(
      new HostKeyMismatchError(
        `No host keys to verify ${host} against; refusing to connect without pinned host keys.`,
      ),
    );
  }
  return new Promise<CubeShell>((resolve, reject) => {
    const client = new Client();
    let mismatch: HostKeyMismatchError | undefined;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(mismatch ?? err);
    };
    client.once("ready", () => {
      if (settled) return;
      settled = true;
      resolve(new CubeShell(client, host, port, username));
    });
    client.once("error", (err: Error) => {
      fail(new SshError(`SSH connection failed: ${redact(err.message, [passphrase])}`));
    });
    client.once("close", () =>
      fail(new SshError("The SSH connection closed before it was ready.")),
    );
    try {
      client.connect({
        host,
        port,
        username,
        privateKey: toBuffer(options.privateKey),
        ...(passphrase !== undefined ? { passphrase } : {}),
        readyTimeout: options.readyTimeoutMs ?? 20_000,
        hostVerifier: (presented: Buffer) => {
          if (hostKeyMatches(presented, hostKeys)) return true;
          mismatch = new HostKeyMismatchError(
            `Host key mismatch for ${host}:${port}; the server presented ${hostKeyFingerprint(presented)}, which is not one of the pinned keys.`,
            hostKeyFingerprint(presented),
          );
          return false;
        },
      });
    } catch (err) {
      fail(
        new SshError(
          `SSH connection failed: ${redact(err instanceof Error ? err.message : String(err), [passphrase])}`,
        ),
      );
    }
  });
}

/**
 * Open an SSH connection to a Cube. The address and host keys come from
 * `krova.cubes.ssh(spaceId, cubeId)`; the connection is refused unless the Cube
 * presents one of those keys (or one of `options.hostKeys`, which replaces them).
 */
export async function connectCube(
  krova: CubeSshSource,
  spaceId: string,
  cubeId: string,
  options: ConnectCubeOptions,
): Promise<CubeShell> {
  const info = await krova.cubes.ssh(spaceId, cubeId);
  if (info.host === null || info.host === "") {
    throw new SshError("This Cube has no SSH address yet. Wait for it to finish starting.");
  }
  const connect: ConnectSshOptions = {
    host: info.host,
    port: info.port,
    username: info.user,
    privateKey: options.privateKey,
    hostKeys: options.hostKeys ?? info.hostKeys,
  };
  if (options.passphrase !== undefined) connect.passphrase = options.passphrase;
  if (options.readyTimeoutMs !== undefined) connect.readyTimeoutMs = options.readyTimeoutMs;
  return connectSsh(connect);
}
