import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { validateIdent } from "../src/commands/dbclients.js";
import { buildSCPArgs, parseCpOperands, type SshInfo, validateSSHHost, validateSSHUser } from "../src/lib/ssh.js";
import { buildTunnelArgs, findOnPath, parsePort, parseTunnelSpec, spawnTunnel } from "../src/lib/tunnel.js";

const info: SshInfo = {
  host: "cube.example.test",
  port: 2222,
  user: "ubuntu",
  hostKeys: [{ type: "ssh-ed25519", key: "AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests" }],
};

// ── Unit: ports and specs ───────────────────────────────────────────────────

test("parsePort accepts 1 to 65535 and nothing else", () => {
  assert.equal(parsePort("1", "p"), 1);
  assert.equal(parsePort("65535", "p"), 65535);
  for (const bad of ["0", "65536", "-1", "1e3", "0x50", "80.5", "", " ", "abc", "99999", "080a"]) {
    assert.throws(() => parsePort(bad, "port"), /port must be a whole number from 1 to 65535/, bad);
  }
});

test("parseTunnelSpec: cube port alone defaults the local port to it", () => {
  assert.deepEqual(parseTunnelSpec("5432"), { localPort: 5432, cubePort: 5432 });
  assert.deepEqual(parseTunnelSpec("9000:5432"), { localPort: 9000, cubePort: 5432 });
});

test("parseTunnelSpec rejects anything that is not [localPort:]cubePort", () => {
  for (const bad of [
    "",
    "abc",
    "80:",
    ":80",
    "1:2:3",
    "0",
    "70000",
    "80:70000",
    "0:80",
    "127.0.0.1:80:80",
    "localhost:80",
    "80;rm",
    "-N",
    "80 90",
  ]) {
    assert.throws(() => parseTunnelSpec(bad), Error,JSON.stringify(bad));
  }
});

// ── Unit: ssh and scp argv ──────────────────────────────────────────────────

test("buildTunnelArgs binds loopback only and keeps strict host keys", () => {
  const args = buildTunnelArgs(info, {
    identity: "/k/id",
    knownHosts: "/cfg/krova/known_hosts",
    localPort: 9000,
    cubePort: 5432,
  });
  assert.deepEqual(args, [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "UserKnownHostsFile=/cfg/krova/known_hosts",
    "-o",
    "StrictHostKeyChecking=yes",
    "-i",
    "/k/id",
    "-p",
    "2222",
    "-L",
    "127.0.0.1:9000:localhost:5432",
    "--",
    "ubuntu@cube.example.test",
  ]);
  const joined = args.join(" ");
  assert.ok(!joined.includes("0.0.0.0"));
  assert.ok(!/StrictHostKeyChecking=(no|accept-new)/.test(joined));
});

test("parseCpOperands: exactly one side is a Cube", () => {
  assert.deepEqual(parseCpOperands("./a.txt", "db:/tmp/a.txt"), {
    cube: "db",
    direction: "upload",
    remotePath: "/tmp/a.txt",
    localPath: "./a.txt",
  });
  assert.deepEqual(parseCpOperands("db:/var/log/syslog", "out/"), {
    cube: "db",
    direction: "download",
    remotePath: "/var/log/syslog",
    localPath: "out/",
  });
  // An empty remote path is the login directory.
  assert.equal(parseCpOperands("a.txt", "db:").remotePath, "");
});

test("parseCpOperands rejects both-remote, both-local and a remote path starting with '-'", () => {
  assert.throws(() => parseCpOperands("db:/a", "web:/b"), /only one side/);
  assert.throws(() => parseCpOperands("a.txt", "b.txt"), /both sides are local/);
  assert.throws(() => parseCpOperands("a.txt", "db:-oProxyCommand=x"), /must not start with '-'/);
  assert.throws(() => parseCpOperands("db:-rf", "out"), /must not start with '-'/);
  assert.throws(() => parseCpOperands("", "db:/x"), /source and a destination/);
});

test("parseCpOperands keeps a local path with a colon local", () => {
  // `./a:b` has a slash before the colon, so it is local; the Cube side is db.
  assert.equal(parseCpOperands("./a:b", "db:/x").localPath, "./a:b");
  // A bare `a:b` would be read as a Cube, so the only local reading needs ./
  assert.equal(parseCpOperands("db:/x", "/tmp/a:b").localPath, "/tmp/a:b");
});

test("buildSCPArgs: strict host keys, -P port, -r, and -- before the operands", () => {
  const up = buildSCPArgs(info, {
    knownHosts: "/cfg/krova/known_hosts",
    identity: "/k/id",
    recursive: true,
    operands: parseCpOperands("dir", "db:/srv"),
  });
  assert.deepEqual(up, [
    "-o",
    "UserKnownHostsFile=/cfg/krova/known_hosts",
    "-o",
    "StrictHostKeyChecking=yes",
    "-i",
    "/k/id",
    "-P",
    "2222",
    "-r",
    "--",
    "dir",
    "ubuntu@cube.example.test:/srv",
  ]);
  const down = buildSCPArgs({ ...info, host: "2001:db8::1" }, {
    knownHosts: "/k",
    operands: parseCpOperands("db:/etc/hosts", "."),
  });
  assert.deepEqual(down.slice(-3), ["--", "ubuntu@[2001:db8::1]:/etc/hosts", "."]);
});

test("validateIdent refuses anything a client could read as a connection string", () => {
  assert.equal(validateIdent("app_db-1.x", "--db"), "app_db-1.x");
  for (const bad of ["-x", "host=evil", "postgresql://h/db", "a b", "", "a;b", "a/b"]) {
    assert.throws(() => validateIdent(bad, "--db"), /--db may only use/, bad);
  }
});

test("findOnPath finds an executable file and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "krova-path-"));
  try {
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n");
    chmodSync(join(dir, "tool"), 0o755);
    writeFileSync(join(dir, "plain"), "x");
    chmodSync(join(dir, "plain"), 0o644);
    mkdirSync(join(dir, "adir"));
    const env = { PATH: dir };
    assert.equal(findOnPath("tool", env), true);
    assert.equal(findOnPath("plain", env), process.platform === "win32");
    assert.equal(findOnPath("adir", env), false);
    assert.equal(findOnPath("missing", env), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── End to end: the built CLI, a mock API and fake ssh, scp and clients ─────

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl: string;
let work: string;
let binDir: string;
let xdg: string;
let logPath: string;
let calls = 0;
let sshInfoBody: unknown = info;
const handler: Handler = (req, res) => {
  calls++;
  const url = (req.url ?? "").split("?")[0] as string;
  res.writeHead(200, { "content-type": "application/json" });
  if (url.endsWith("/cubes")) {
    res.end(JSON.stringify({ cubes: [{ id: "cube_1", name: "db" }] }));
  } else if (url.endsWith("/cubes/cube_1/ssh")) {
    res.end(JSON.stringify(sshInfoBody));
  } else {
    res.writeHead(404);
    res.end("{}");
  }
};

// One script plays ssh, scp, psql, redis-cli and mysql: it logs its argv, and
// as ssh with -L it listens on the forwarded local port like a real tunnel.
const FAKE = `#!${process.execPath}
const fs = require("fs");
const net = require("net");
const path = require("path");
const name = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\\n");
log({ bin: name, argv });
if (name === "ssh" || name === "scp") {
  const i = argv.indexOf("-L");
  if (process.env.FAKE_SSH_HANG) {
    process.on("SIGTERM", () => { log({ bin: name, event: "SIGTERM" }); process.exit(0); });
    process.stderr.write("FAKE_READY\\n");
    setInterval(() => {}, 1 << 30);
  } else if (i >= 0 && process.env.FAKE_SSH_EXIT === undefined) {
    const [host, port] = argv[i + 1].split(":");
    net.createServer((s) => {
      s.end();
      // A port squatter: ssh could not bind, so it exits after the first probe.
      if (process.env.FAKE_SSH_SQUAT) setTimeout(() => process.exit(255), 50);
    }).listen(Number(port), host);
    process.on("SIGTERM", () => { log({ bin: name, event: "SIGTERM" }); process.exit(0); });
    setInterval(() => {}, 1 << 30);
  } else {
    process.exit(Number(process.env.FAKE_SSH_EXIT || 0));
  }
} else {
  setTimeout(
    () => process.exit(Number(process.env.FAKE_CLIENT_EXIT || 0)),
    Number(process.env.FAKE_CLIENT_DELAY_MS || 0)
  );
}
`;

before(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  work = mkdtempSync(join(tmpdir(), "krova-ssh-e2e-"));
  binDir = join(work, "bin");
  xdg = join(work, "xdg");
  logPath = join(work, "log.jsonl");
  mkdirSync(binDir);
  for (const name of ["ssh", "scp", "psql", "redis-cli", "mysql"]) {
    writeFileSync(join(binDir, name), FAKE);
    chmodSync(join(binDir, name), 0o755);
  }
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  rmSync(work, { recursive: true, force: true });
});

const entry = join(import.meta.dirname, "..", "dist", "index.js");
// Global flags go first: anything after a `--` belongs to the remote command.
const cliArgs = (args: string[]) => [
  entry,
  "--api-key",
  "kro_test",
  "--space",
  "space_src",
  "--base-url",
  baseUrl,
  ...args,
];
const cliEnv = (extra: Record<string, string> = {}) => ({
  // PATH holds only the fakes: the real ssh, scp and clients can never run.
  PATH: binDir,
  HOME: "/nonexistent-krova-home",
  XDG_CONFIG_HOME: xdg,
  KROVA_API_KEY: "",
  FAKE_LOG: logPath,
  ...extra,
});

function runCli(args: string[], extra: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, cliArgs(args), { env: cliEnv(extra) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type LogEntry = { bin: string; argv?: string[]; event?: string };
function readLog(): LogEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry);
}
function resetLog() {
  rmSync(logPath, { force: true });
}
const knownHostsFile = () => join(xdg, "krova", "known_hosts");

test("e2e `krova tunnel`: loopback bind, strict host keys, ssh's exit code, stderr message", async () => {
  resetLog();
  const r = await runCli(["tunnel", "db", "9000:5432", "-i", "/k/id"], { FAKE_SSH_EXIT: "7" });
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stderr, /Forwarding localhost:9000 -> db:5432\. Press Ctrl\+C to stop\./);
  assert.equal(r.stdout, "");
  assert.deepEqual(readLog(), [
    {
      bin: "ssh",
      argv: [
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        `UserKnownHostsFile=${knownHostsFile()}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-i",
        "/k/id",
        "-p",
        "2222",
        "-L",
        "127.0.0.1:9000:localhost:5432",
        "--",
        "ubuntu@cube.example.test",
      ],
    },
  ]);
  assert.match(readFileSync(knownHostsFile(), "utf8"), /^\[cube\.example\.test\]:2222 ssh-ed25519 /m);
  if (process.platform !== "win32") assert.equal(statSync(knownHostsFile()).mode & 0o777, 0o600);
});

test("e2e `krova tunnel` defaults the local port to the cube port and rejects a bad spec", async () => {
  resetLog();
  const ok = await runCli(["tunnel", "db", "6379"], { FAKE_SSH_EXIT: "0" });
  assert.equal(ok.code, 0, ok.stderr);
  const argv = readLog()[0]?.argv ?? [];
  assert.equal(argv[argv.indexOf("-L") + 1], "127.0.0.1:6379:localhost:6379");

  resetLog();
  for (const bad of ["0", "70000", "80:", "x", "1:2:3"]) {
    const r = await runCli(["tunnel", "db", bad], { FAKE_SSH_EXIT: "0" });
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /Error: /);
  }
  assert.deepEqual(readLog(), [], "a bad spec never reaches ssh");
});

test("e2e `krova connect --json` prints the endpoint, holds the tunnel, and stops on SIGINT", { timeout: 30_000 }, async () => {
  resetLog();
  const child = spawn(process.execPath, cliArgs(["connect", "db", "--port", "5432", "--json"]), {
    env: cliEnv(),
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const endpoint = await new Promise<{ host: string; port: number; cube: string; cubePort: number }>(
    (resolve, reject) => {
      child.stdout.on("data", (d) => {
        stdout += d;
        try {
          resolve(JSON.parse(stdout));
        } catch {
          // wait for the rest of the JSON
        }
      });
      child.once("close", () => reject(new Error(`exited before printing the endpoint: ${stderr}`)));
    }
  );
  assert.equal(endpoint.host, "127.0.0.1");
  assert.equal(endpoint.cube, "db");
  assert.equal(endpoint.cubePort, 5432);
  assert.ok(endpoint.port > 0 && endpoint.port < 65536);
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.kill("SIGINT");
  });
  assert.equal(code, 0, stderr);
  const argv = readLog()[0]?.argv ?? [];
  assert.equal(argv[argv.indexOf("-L") + 1], `127.0.0.1:${endpoint.port}:localhost:5432`);
  assert.ok(argv.includes("StrictHostKeyChecking=yes"));
});

test("e2e `krova psql`: tunnel on a free loopback port, client gets host 127.0.0.1, exit code follows the client, ssh is stopped", { timeout: 30_000 }, async () => {
  resetLog();
  const r = await runCli(["psql", "db", "--user", "app", "--db", "shop", "--port", "5433"], {
    FAKE_CLIENT_EXIT: "3",
  });
  assert.equal(r.code, 3, r.stderr);
  const log = readLog();
  const sshArgv = log.find((e) => e.bin === "ssh" && e.argv)?.argv ?? [];
  const fwd = (sshArgv[sshArgv.indexOf("-L") + 1] as string).split(":");
  assert.equal(fwd[0], "127.0.0.1");
  assert.deepEqual(fwd.slice(2), ["localhost", "5433"]);
  const localPort = fwd[1] as string;
  assert.deepEqual(log.find((e) => e.bin === "psql")?.argv, [
    "-h",
    "127.0.0.1",
    "-p",
    localPort,
    "-U",
    "app",
    "-d",
    "shop",
  ]);
  assert.ok(
    log.some((e) => e.bin === "ssh" && e.event === "SIGTERM"),
    "the tunnel is closed when the client exits"
  );
});

test("e2e `krova redis` and `krova mysql` use their defaults and client flags", { timeout: 30_000 }, async () => {
  resetLog();
  const redis = await runCli(["redis", "db"]);
  assert.equal(redis.code, 0, redis.stderr);
  let log = readLog();
  let ssh = log.find((e) => e.bin === "ssh" && e.argv)?.argv ?? [];
  assert.equal((ssh[ssh.indexOf("-L") + 1] as string).split(":").slice(2).join(":"), "localhost:6379");
  const redisArgs = log.find((e) => e.bin === "redis-cli")?.argv ?? [];
  assert.deepEqual(redisArgs.slice(0, 2), ["-h", "127.0.0.1"]);
  assert.equal(redisArgs[2], "-p");

  resetLog();
  const mysql = await runCli(["mysql", "db", "--db", "shop"]);
  assert.equal(mysql.code, 0, mysql.stderr);
  log = readLog();
  ssh = log.find((e) => e.bin === "ssh" && e.argv)?.argv ?? [];
  assert.equal((ssh[ssh.indexOf("-L") + 1] as string).split(":").slice(2).join(":"), "localhost:3306");
  const mysqlArgs = log.find((e) => e.bin === "mysql")?.argv ?? [];
  assert.deepEqual(mysqlArgs.slice(0, 2), ["-h", "127.0.0.1"]);
  assert.deepEqual(mysqlArgs.slice(4), ["--protocol=tcp", "-u", "root", "--database=shop"]);
});

test("e2e a missing client fails with a one-line message naming it, before any tunnel or API call", async () => {
  resetLog();
  const before = calls;
  const emptyBin = join(work, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  for (const [cmd, client] of [
    ["psql", "psql"],
    ["redis", "redis-cli"],
    ["mysql", "mysql"],
  ] as const) {
    const r = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, cliArgs([cmd, "db"]), {
        env: { ...cliEnv(), PATH: emptyBin },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(r.code, 1, cmd);
    assert.match(r.stderr, new RegExp(`Error: \`${client}\` was not found on your PATH`));
    assert.equal(r.stderr.trim().split("\n").length, 1, "one line");
  }
  assert.equal(calls, before, "no API call was made");
  assert.deepEqual(readLog(), [], "ssh never ran");
});

test("e2e psql refuses a db name that could carry a connection string", async () => {
  resetLog();
  const r = await runCli(["psql", "db", "--db", "host=evil.example"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--db may only use/);
  assert.deepEqual(readLog(), []);
});

test("e2e `krova exec` runs ssh -T with the words after --, and propagates the remote exit code", async () => {
  resetLog();
  const r = await runCli(["exec", "db", "-i", "/k/id", "--", "uname", "-a"], { FAKE_SSH_EXIT: "42" });
  assert.equal(r.code, 42, r.stderr);
  assert.deepEqual(readLog(), [
    {
      bin: "ssh",
      argv: [
        "-T",
        "-o",
        `UserKnownHostsFile=${knownHostsFile()}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-i",
        "/k/id",
        "-p",
        "2222",
        "--",
        "ubuntu@cube.example.test",
        "uname",
        "-a",
      ],
    },
  ]);
  const ok = await runCli(["exec", "db", "--", "true"], { FAKE_SSH_EXIT: "0" });
  assert.equal(ok.code, 0);
});

test("e2e `krova exec` needs at least one command word", async () => {
  resetLog();
  const none = await runCli(["exec", "db"]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /missing required argument 'command'/);
  const blank = await runCli(["exec", "db", "--", " "]);
  assert.equal(blank.code, 1);
  assert.match(blank.stderr, /exec needs a command/);
  assert.deepEqual(readLog(), []);
});

test("e2e `krova cp` builds the scp argv for an upload and a download", async () => {
  resetLog();
  const up = await runCli(["cp", "-r", "-i", "/k/id", "./site", "db:/srv/"], { FAKE_SSH_EXIT: "0" });
  assert.equal(up.code, 0, up.stderr);
  assert.deepEqual(readLog(), [
    {
      bin: "scp",
      argv: [
        "-o",
        `UserKnownHostsFile=${knownHostsFile()}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-i",
        "/k/id",
        "-P",
        "2222",
        "-r",
        "--",
        "./site",
        "ubuntu@cube.example.test:/srv/",
      ],
    },
  ]);

  resetLog();
  const down = await runCli(["cp", "db:/var/log/syslog", "out.log"], { FAKE_SSH_EXIT: "5" });
  assert.equal(down.code, 5, "scp's exit code is propagated");
  const argv = readLog()[0]?.argv ?? [];
  assert.deepEqual(argv.slice(-3), ["--", "ubuntu@cube.example.test:/var/log/syslog", "out.log"]);
});

test("e2e `krova cp` rejects both-remote, both-local and a '-' remote path before anything runs", async () => {
  resetLog();
  const before = calls;
  for (const [a, b, msg] of [
    ["db:/a", "db:/b", /only one side/],
    ["a.txt", "b.txt", /both sides are local/],
    ["a.txt", "db:-oProxyCommand=x", /must not start with '-'/],
  ] as const) {
    const r = await runCli(["cp", a, b]);
    assert.equal(r.code, 1, `${a} ${b}`);
    assert.match(r.stderr, msg);
  }
  assert.equal(calls, before, "no API call was made");
  assert.deepEqual(readLog(), []);
});

test("help for tunnel, connect and psql says private tunnels beat a public tcp mapping", async () => {
  for (const cmd of ["tunnel", "connect", "psql"]) {
    const r = await runCli([cmd, "--help"]);
    assert.equal(r.code, 0, cmd);
    assert.match(r.stdout.replace(/\s+/g, " "), /krova tcp add/, cmd);
  }
});

// ── Hardening ───────────────────────────────────────────────────────────────

test("validateSSHHost accepts an IP or a DNS name and nothing else", () => {
  for (const ok of ["1.2.3.4", "2001:db8::1", "cube-1.example.test", "a"]) validateSSHHost(ok);
  for (const bad of ["a_b.test", "-x.test", "a..b", "a.b-", "host:22", "[::1]", "a b", "x".repeat(64) + ".test"]) {
    assert.throws(() => validateSSHHost(bad), Error, bad);
  }
});

test("validateSSHUser bans ':', '[' and ']'", () => {
  validateSSHUser("ubuntu");
  for (const bad of ["a:b", "a[b", "a]b"]) assert.throws(() => validateSSHUser(bad), /disallowed character/, bad);
});

test("buildSCPArgs refuses a host or user that scp would split on ':'", () => {
  const operands = parseCpOperands("a.txt", "db:/x");
  assert.throws(() => buildSCPArgs({ ...info, user: "u:x" }, { operands }), /user contains/);
  assert.throws(() => buildSCPArgs({ ...info, user: "u[x]" }, { operands }), /user contains/);
  assert.throws(() => buildSCPArgs({ ...info, host: "evil:80" }, { operands }), /host contains/);
  // A real IPv6 address is fine and gets brackets.
  buildSCPArgs({ ...info, host: "2001:db8::1" }, { operands });
});

test("a Windows drive letter stays a local path", () => {
  const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    assert.equal(parseCpOperands("C:\\x\\a.txt", "db:/y").localPath, "C:\\x\\a.txt");
    assert.equal(parseCpOperands("db:/y", "D:out").localPath, "D:out");
  } finally {
    Object.defineProperty(process, "platform", real);
  }
  // Elsewhere a local name with a colon is written ./a:b; a backslash name is safe too.
  assert.equal(parseCpOperands("./a:b", "db:/y").localPath, "./a:b");
  assert.equal(parseCpOperands("db:/y", "a\\b:c").localPath, "./a\\b:c");
});

test("e2e the new commands fail closed when the API has no host keys; krova ssh keeps its behavior", async () => {
  resetLog();
  sshInfoBody = { ...info, hostKeys: [] };
  try {
    for (const args of [
      ["exec", "db", "--", "true"],
      ["cp", "a.txt", "db:/x"],
      ["tunnel", "db", "5432"],
      ["connect", "db", "--port", "5432"],
      ["psql", "db"],
      ["redis", "db"],
      ["mysql", "db"],
    ]) {
      const r = await runCli(args, { FAKE_SSH_EXIT: "0" });
      assert.equal(r.code, 1, args.join(" "));
      assert.match(
        r.stderr,
        /Error: Krova has no recorded host key for this Cube yet; use `krova ssh` to connect interactively/
      );
    }
    assert.deepEqual(readLog(), [], "no ssh, scp or client ran");
    const ssh = await runCli(["ssh", "db", "--", "true"], { FAKE_SSH_EXIT: "0" });
    assert.equal(ssh.code, 0, ssh.stderr);
    assert.match(ssh.stderr, /didn't provide host keys/);
    assert.equal(readLog().length, 1);
  } finally {
    sshInfoBody = info;
  }
});

test("e2e psql refuses to start the client when ssh exits right after the probe (port squat)", { timeout: 30_000 }, async () => {
  resetLog();
  const r = await runCli(["psql", "db"], { FAKE_SSH_SQUAT: "1" });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /Error: ssh exited \(code 255\) before the tunnel was ready/);
  assert.ok(!readLog().some((e) => e.bin === "psql"), "the client never started");
});

test("spawnTunnel({ ignoreSigint }) starts ssh with SIGINT ignored, and a plain spawn does not", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  // A sh fake: Node resets signal dispositions on start, a shell keeps them.
  const dir = mkdtempSync(join(tmpdir(), "krova-sigint-"));
  const log = join(dir, "log");
  writeFileSync(join(dir, "ssh"), `#!/bin/sh\nkill -INT $$\necho survived >> "${log}"\n`);
  chmodSync(join(dir, "ssh"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const shielded = spawnTunnel([], { ignoreSigint: true });
    assert.equal(await shielded.exited, 0);
    assert.equal(readFileSync(log, "utf8"), "survived\n");
    const plain = spawnTunnel([]);
    assert.equal(await plain.exited, 130, "without the shield SIGINT kills it");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e exec forwards SIGTERM to ssh and still returns its exit code", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  resetLog();
  const child = spawn(process.execPath, cliArgs(["exec", "db", "--", "sleep", "60"]), {
    env: cliEnv({ FAKE_SSH_HANG: "1" }),
  });
  await new Promise<void>((resolve, reject) => {
    child.stderr.on("data", (d) => String(d).includes("FAKE_READY") && resolve());
    child.once("close", () => reject(new Error("exited before ssh started")));
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.kill("SIGTERM");
  });
  assert.equal(code, 0);
  assert.ok(readLog().some((e) => e.bin === "ssh" && e.event === "SIGTERM"), "ssh was sent SIGTERM");
});
