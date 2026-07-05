// SSH: fetch connection info, pin host keys, build a hardened `ssh` argv, exec.
// Ports the Go CLI's option-injection guards and known_hosts pinning verbatim.

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { configDir } from "./config.js";
import { join } from "node:path";

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
  "@/\\'\"`$;&|<>(){}*?!#,".split("")
);

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
  const args: string[] = [];
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
