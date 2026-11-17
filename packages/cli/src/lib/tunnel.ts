// Private tunnels: `ssh -N -L 127.0.0.1:<local>:localhost:<cube port>` over the
// same strict host-key path as `krova ssh`, plus the helpers the database
// client commands use (free loopback port, readiness wait, client on PATH).

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { createServer, connect } from "node:net";
import { delimiter, join } from "node:path";

import { type SshInfo, buildSSHArgs, exitCodeFor } from "./ssh.js";

/** The only address a tunnel ever binds. Never 0.0.0.0. */
export const LOOPBACK = "127.0.0.1";

/** Parse a TCP port: digits only, 1 to 65535. */
export function parsePort(value: string, label: string): number {
  const s = String(value ?? "").trim();
  const n = Number(s);
  if (!/^\d{1,5}$/.test(s) || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label} must be a whole number from 1 to 65535`);
  }
  return n;
}

/** Parse `[localPort:]cubePort`. The local port defaults to the Cube port. */
export function parseTunnelSpec(spec: string): { localPort: number; cubePort: number } {
  const m = /^(\d+)(?::(\d+))?$/.exec(String(spec ?? "").trim());
  if (!m) {
    throw new Error(`invalid port spec "${spec}": use <cubePort> or <localPort>:<cubePort>`);
  }
  if (m[2] === undefined) {
    const cubePort = parsePort(m[1] as string, "cube port");
    return { localPort: cubePort, cubePort };
  }
  return {
    localPort: parsePort(m[1] as string, "local port"),
    cubePort: parsePort(m[2], "cube port"),
  };
}

/** Build the tunnel argv: loopback-only bind, no remote command, and ssh exits
 *  if the forward cannot be set up. Host keys stay strictly checked. */
export function buildTunnelArgs(
  info: SshInfo,
  o: { identity?: string; knownHosts?: string; localPort: number; cubePort: number }
): string[] {
  return buildSSHArgs(info, {
    preArgs: ["-N", "-o", "ExitOnForwardFailure=yes"],
    identity: o.identity,
    knownHosts: o.knownHosts,
    localFwd: [`${LOOPBACK}:${o.localPort}:localhost:${o.cubePort}`],
  });
}

/** Ask the OS for a free loopback port (bind to port 0, read it, release it). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, LOOPBACK, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("couldn't find a free local port")));
      }
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: LOOPBACK, port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

const READY_GRACE_MS = 150;

/** Wait until the local forward accepts a connection. ssh opens the listener
 *  once it has authenticated, so a refused connect means "not yet": retry with a
 *  short growing delay and stop at once if ssh exits or attempts run out. */
export async function waitForPort(
  port: number,
  ssh: { exited: Promise<number> },
  maxAttempts = 480
): Promise<"ready" | "ssh-exited" | "timeout"> {
  let sshDone = false;
  const markDone = () => {
    sshDone = true;
  };
  void ssh.exited.then(markDone, markDone);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (sshDone) return "ssh-exited";
    if (await canConnect(port)) {
      // Something answered. If another process holds the port, ssh fails to bind
      // (ExitOnForwardFailure) and exits right after: give it a short bounded
      // moment to do so, and only call the tunnel ready if ssh is still running.
      await Promise.race([
        ssh.exited.then(markDone, markDone),
        new Promise((r) => setTimeout(r, READY_GRACE_MS)),
      ]);
      return sshDone ? "ssh-exited" : "ready";
    }
    await new Promise((r) => setTimeout(r, Math.min(20 * 2 ** Math.min(attempt, 4), 250)));
  }
  return "timeout";
}

/** True when `name` is an executable file in one of the PATH directories. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

export interface Spawned {
  child: ChildProcess;
  /** Resolves with a shell-style exit code when the process ends. */
  exited: Promise<number>;
}

/** Start the tunnel's ssh. stdin and stdout are not used (ssh prompts for a
 *  passphrase on the terminal itself); stderr stays visible.
 *
 *  `ignoreSigint` keeps a terminal Ctrl+C (sent to the whole foreground process
 *  group) from killing the tunnel while a database client is using it: ssh is
 *  started through `sh` with SIGINT ignored, which survives the exec. It is NOT
 *  `detached: true`, because that calls setsid(), so ssh would lose the
 *  controlling terminal and could no longer ask for a key passphrase. */
export function spawnTunnel(args: string[], o: { ignoreSigint?: boolean } = {}): Spawned {
  const stdio: ["ignore", "ignore", "inherit"] = ["ignore", "ignore", "inherit"];
  const child =
    o.ignoreSigint && process.platform !== "win32"
      ? spawn("/bin/sh", ["-c", 'trap "" INT; exec ssh "$@"', "sh", ...args], { stdio })
      : spawn("ssh", args, { stdio });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") reject(new Error("`ssh` was not found on your PATH"));
      else reject(err);
    });
    child.once("exit", (code, signal) => resolve(exitCodeFor(code, signal)));
  });
  return { child, exited };
}

const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Hold a tunnel open until it ends. Ctrl+C (or SIGTERM) stops it cleanly and
 *  exits 0; otherwise the exit code is ssh's own. `onReady` runs once the local
 *  port accepts connections, when a `readyPort` is given. */
export async function holdTunnel(
  args: string[],
  opts: { readyPort?: number; onReady?: () => void } = {}
): Promise<number> {
  const ssh = spawnTunnel(args);
  let stopped = false;
  const stop = (sig: NodeJS.Signals) => {
    stopped = true;
    ssh.child.kill(sig);
  };
  for (const sig of STOP_SIGNALS) process.on(sig, stop);
  try {
    if (opts.readyPort !== undefined) {
      const state = await waitForPort(opts.readyPort, ssh);
      if (state === "ready") {
        opts.onReady?.();
      } else if (state === "timeout") {
        ssh.child.kill("SIGTERM");
        await ssh.exited;
        throw new Error("the tunnel didn't come up in time");
      }
    }
    const code = await ssh.exited;
    return stopped ? 0 : code;
  } finally {
    for (const sig of STOP_SIGNALS) process.off(sig, stop);
  }
}

/** Open a tunnel, run `client` against the local port with stdio inherited,
 *  then close the tunnel. Exits with the client's code. */
export async function runClientThroughTunnel(o: {
  sshArgs: string[];
  localPort: number;
  client: string;
  clientArgs: string[];
}): Promise<number> {
  const ssh = spawnTunnel(o.sshArgs, { ignoreSigint: true });
  let client: ChildProcess | undefined;
  const onSignal = (sig: NodeJS.Signals) => {
    if (sig === "SIGINT") {
      // Once the client runs, Ctrl+C belongs to it (psql cancels the query) and
      // the tunnel ignores it. Before that, it is how the user gives up waiting.
      if (!client) ssh.child.kill("SIGTERM");
      return;
    }
    client?.kill(sig);
    ssh.child.kill(sig);
  };
  // Never leave the tunnel behind, whatever way this process ends.
  const killTunnel = () => {
    if (ssh.child.exitCode === null && ssh.child.signalCode === null) ssh.child.kill("SIGTERM");
  };
  process.on("exit", killTunnel);
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  try {
    const state = await waitForPort(o.localPort, ssh);
    if (state === "ssh-exited") {
      const code = await ssh.exited;
      throw new Error(`ssh exited (code ${code}) before the tunnel was ready`);
    }
    if (state === "timeout") {
      ssh.child.kill("SIGTERM");
      await ssh.exited;
      throw new Error("the tunnel didn't come up in time");
    }
    const running = spawn(o.client, o.clientArgs, { stdio: "inherit" });
    client = running;
    return await new Promise<number>((resolve, reject) => {
      running.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") reject(new Error(`\`${o.client}\` was not found on your PATH`));
        else reject(err);
      });
      running.once("exit", (code, signal) => resolve(exitCodeFor(code, signal)));
    });
  } finally {
    killTunnel();
    await ssh.exited.catch(() => 0);
    for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    process.off("exit", killTunnel);
  }
}
