// SSH: fetch connection info, pin host keys, build a hardened `ssh` argv, exec.
// Ports the Go CLI's option-injection guards and known_hosts pinning verbatim.

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";

import { constants as osConstants } from "node:os";

import type { Command } from "commander";

import { rawRequest } from "./client.js";
import { configDir } from "./config.js";
import { join } from "node:path";
import { resolveCube } from "./resolve.js";
import { getRuntime, makeClient, resolveSpace } from "./runtime.js";

export interface SshHostKey {
  type: string;
  key: string;
}
export interface SshInfo {
  host: string;
  port: number;
  user: string;
  hostKeys: SshHostKey[];
}

export interface SshOptions {
  /** Extra ssh flags placed before everything else (for example `-N`, `-T`). */
  preArgs?: string[];
  identity?: string;
  localFwd?: string[];
  remoteFwd?: string[];
  knownHosts?: string;
  remoteCmd?: string[];
}

// Characters an ssh host must never contain (option/metacharacter injection).
const HOST_BANNED = new Set(
  "@/\\'\"`$;&|<>(){}*?!#=,".split("")
);
// User is slightly looser — it may contain '=' (host may not).
const USER_BANNED = new Set(
  "@/\\'\"`$;&|<>(){}*?!#,:[]".split("")
);

// One DNS label: letters, digits and inner hyphens, at most 63 characters.
const DNS_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function validateSSHHost(host: string): void {
  const h = host.trim();
  if (!h) throw new Error("empty host");
  if (h.startsWith("-")) throw new Error("host must not start with '-'");
  for (const r of h) {
    const code = r.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      throw new Error("host contains whitespace or control characters");
    }
    if (HOST_BANNED.has(r)) {
      throw new Error(`host contains a disallowed character ${JSON.stringify(r)}`);
    }
  }
  if (isIP(h) === 0 && !DNS_NAME.test(h)) {
    throw new Error("host must be an IP address or a DNS hostname");
  }
}

export function validateSSHUser(user: string): void {
  const u = user.trim();
  if (!u) return; // empty user is allowed
  if (u.startsWith("-")) throw new Error("user must not start with '-'");
  for (const r of u) {
    const code = r.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      throw new Error("user contains whitespace or control characters");
    }
    if (USER_BANNED.has(r)) {
      throw new Error(`user contains a disallowed character ${JSON.stringify(r)}`);
    }
  }
}

/** known_hosts host field: "[host]:port" when the port isn't the default 22. */
export function knownHostsHost(host: string, port: number): string {
  if (port > 0 && port !== 22) return `[${host}]:${port}`;
  return host;
}

export function knownHostsPath(): string {
  return join(configDir(), "known_hosts");
}

/** True for a DNS hostname (e.g. the Cube's stable SSH hostname), false for a
 *  bare IPv4/IPv6 address. */
export function isHostname(host: string): boolean {
  return isIP(host) === 0;
}

/** True when `host:port` has no existing known_hosts pin yet — used to print a
 *  one-time note the first time we pin a Cube's hostname rather than its IP. */
export function isUnpinned(host: string, port: number): boolean {
  const field = knownHostsHost(host, port);
  let existing = "";
  try {
    existing = readFileSync(knownHostsPath(), "utf8");
  } catch {
    existing = "";
  }
  return !existing.split("\n").some((line) => line.split(/\s+/)[0] === field);
}

/** Pin the cube's host keys to ~/.config/krova/known_hosts (0600), pruning any
 *  stale line for the same host:port (rebuilt cubes can reuse an IP+DNAT port). */
export function writeKnownHosts(info: SshInfo): string {
  const path = knownHostsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const field = knownHostsHost(info.host, info.port);

  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = "";
  }
  const kept = existing
    .split("\n")
    .filter((line) => line.trim() && line.split(/\s+/)[0] !== field);
  writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
  chmodSync(path, 0o600);

  for (const k of info.hostKeys) {
    appendFileSync(path, `${field} ${k.type} ${k.key}\n`);
  }
  return path;
}

/** Build the ssh argv. `--` is placed immediately before the destination —
 *  the primary option-injection guard (with the validators above). */
export function buildSSHArgs(info: SshInfo, o: SshOptions): string[] {
  const args: string[] = [...(o.preArgs ?? [])];
  if (o.knownHosts) {
    args.push("-o", `UserKnownHostsFile=${o.knownHosts}`, "-o", "StrictHostKeyChecking=yes");
  }
  if ((o.identity ?? "").trim()) args.push("-i", o.identity as string);
  if (info.port > 0) args.push("-p", String(info.port));
  for (const l of o.localFwd ?? []) if (l.trim()) args.push("-L", l);
  for (const r of o.remoteFwd ?? []) if (r.trim()) args.push("-R", r);
  const user = info.user.trim();
  const target = user ? `${user}@${info.host}` : info.host;
  args.push("--", target);
  args.push(...(o.remoteCmd ?? []));
  return args;
}

/** Exec system ssh, inheriting stdio (interactive unless a remote cmd is given). */
export function execSSH(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/** Map a child's (code, signal) to a shell-style exit code. */
export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) return 128 + (osConstants.signals[signal] ?? 0);
  return 1;
}

/** Exec a binary with inherited stdio and resolve to its exit code. A signal
 *  death maps to 128 + the signal number; a missing binary names itself. */
export function execInherit(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    // Ctrl+C already reaches the child through the terminal; a signal sent only
    // to this process (kill, a supervisor) is passed on, and we keep running
    // until the child has exited so its exit code is not lost.
    const forward = (sig: NodeJS.Signals) => {
      child.kill(sig);
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const sig of signals) process.on(sig, forward);
    const done = () => {
      for (const sig of signals) process.off(sig, forward);
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      done();
      if (err.code === "ENOENT") reject(new Error(`\`${bin}\` was not found on your PATH`));
      else reject(err);
    });
    child.on("exit", (code, signal) => {
      done();
      resolve(exitCodeFor(code, signal));
    });
  });
}

export interface SshTarget {
  cubeId: string;
  info: SshInfo;
  /** Path of the pinned known_hosts file, or "" when the server sent no host keys. */
  knownHosts: string;
}

/** Resolve a Cube (name or ID) to its validated SSH endpoint and pin its host
 *  keys. Shared by `ssh`, `tunnel`, `connect`, `psql`, `redis`, `mysql`, `exec`
 *  and `cp`, so every one of them keeps the same strict host-key checking. */
export async function resolveSshTarget(
  cmd: Command,
  cubeRef: string,
  o: { requireHostKeys?: boolean } = {}
): Promise<SshTarget> {
  const rt = getRuntime(cmd);
  const client = makeClient(rt.res);
  const space = await resolveSpace(rt);
  const id = await resolveCube(client, space, cubeRef);

  const { status, data } = await rawRequest<SshInfo>({
    method: "GET",
    baseUrl: rt.res.baseUrl,
    path: `/spaces/${space}/cubes/${id}/ssh`,
    apiKey: rt.res.apiKey,
    timeoutMs: rt.timeoutMs,
  });
  if (status === 404) {
    throw new Error(
      `SSH info isn't available on this server yet — try \`krova cubes get ${cubeRef}\` for the Cube's IP and ssh manually`
    );
  }
  if (status === 401 || status === 403) {
    throw new Error(`SSH info request was rejected (HTTP ${status})`);
  }
  if (status !== 200 || !data?.host) {
    throw new Error(`couldn't fetch SSH info (HTTP ${status})`);
  }

  const info: SshInfo = {
    host: data.host,
    port: data.port ?? 0,
    user: data.user ?? "",
    hostKeys: data.hostKeys ?? [],
  };
  validateSSHHost(info.host);
  validateSSHUser(info.user);
  if (info.port < 0 || info.port > 65535) throw new Error("invalid ssh port");

  if (o.requireHostKeys && !info.hostKeys.length) {
    // Fail closed: without a recorded key there is nothing to pin, and these
    // commands never fall back to trusting whatever key the host presents.
    throw new Error(
      "Krova has no recorded host key for this Cube yet; use `krova ssh` to connect interactively"
    );
  }

  let knownHosts = "";
  if (info.hostKeys.length) {
    if (isHostname(info.host) && isUnpinned(info.host, info.port)) {
      process.stderr.write(
        "note: this Cube now has a stable SSH hostname (it stays the same even if the Cube migrates to another server) — pinning it is expected and only happens once.\n"
      );
    }
    knownHosts = writeKnownHosts(info);
  } else {
    process.stderr.write(
      "note: this server didn't provide host keys — using ssh trust-on-first-use (host-key checking stays on).\n"
    );
  }
  return { cubeId: id, info, knownHosts };
}

// ── scp ────────────────────────────────────────────────────────────────────

export interface CpOperands {
  /** Cube name or ID of the one remote side. */
  cube: string;
  direction: "upload" | "download";
  /** Path on the Cube (may be empty: the login directory). */
  remotePath: string;
  /** Path on this machine, made safe to hand to scp as a local operand. */
  localPath: string;
}

/** Split `<cube>:<path>`. A prefix with a slash in it (`./a:b`, `/tmp/x:y`) is
 *  a local path, and on Windows a one-letter prefix is a drive letter. */
function splitRemote(arg: string): { cube: string; path: string } | undefined {
  const i = arg.indexOf(":");
  if (i <= 0) return undefined;
  const cube = arg.slice(0, i);
  if (cube.includes("/") || cube.includes("\\")) return undefined;
  if (process.platform === "win32" && cube.length === 1) return undefined;
  return { cube, path: arg.slice(i + 1) };
}

/** scp reads `a:b` as host `a`; a local path with a colon before its first
 *  slash gets a `./` so it stays local. */
function safeLocalPath(p: string): string {
  const colon = p.indexOf(":");
  // A Windows drive letter (`C:\\x`) is not a host.
  if (process.platform === "win32" && colon === 1) return p;
  const slash = p.indexOf("/");
  if (colon !== -1 && (slash === -1 || colon < slash)) return `./${p}`;
  return p;
}

/** Decide which side of `krova cp` is the Cube. Exactly one must be. */
export function parseCpOperands(src: string, dst: string): CpOperands {
  if (!src || !dst) throw new Error("cp needs a source and a destination");
  const s = splitRemote(src);
  const d = splitRemote(dst);
  if (s && d) {
    throw new Error("cp copies between this machine and a Cube: only one side can be <cube>:<path>");
  }
  if (!s && !d) {
    throw new Error("one side must be a Cube path like <cube>:<path> (both sides are local)");
  }
  const remote = (s ?? d) as { cube: string; path: string };
  if (remote.path.startsWith("-")) {
    throw new Error("a remote path must not start with '-'");
  }
  if (/[\0\r\n]/.test(remote.path)) {
    throw new Error("a remote path must not contain control characters");
  }
  return s
    ? { cube: s.cube, direction: "download", remotePath: s.path, localPath: safeLocalPath(dst) }
    : { cube: remote.cube, direction: "upload", remotePath: remote.path, localPath: safeLocalPath(src) };
}

/** Build the scp argv: strict host keys, `-P` port, and `--` before the operands. */
export function buildSCPArgs(
  info: SshInfo,
  o: { knownHosts?: string; identity?: string; recursive?: boolean; operands: CpOperands }
): string[] {
  // scp splits `user@host:path` on colons, so neither part may carry one.
  const user = info.user.trim();
  if (/[:\[\]]/.test(user)) throw new Error("user contains a disallowed character");
  if (info.host.includes(":") && isIP(info.host) !== 6) {
    throw new Error("host contains a disallowed character");
  }
  const args: string[] = [];
  if (o.knownHosts) {
    args.push("-o", `UserKnownHostsFile=${o.knownHosts}`, "-o", "StrictHostKeyChecking=yes");
  }
  if ((o.identity ?? "").trim()) args.push("-i", o.identity as string);
  if (info.port > 0) args.push("-P", String(info.port));
  if (o.recursive) args.push("-r");
  const host = isIP(info.host) === 6 ? `[${info.host}]` : info.host;
  const remote = `${user ? `${user}@` : ""}${host}:${o.operands.remotePath}`;
  const { direction, localPath } = o.operands;
  args.push("--", ...(direction === "upload" ? [localPath, remote] : [remote, localPath]));
  return args;
}
