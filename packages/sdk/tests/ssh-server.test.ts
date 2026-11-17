import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import ssh2 from "ssh2";
import type { CubeSshInfo } from "../src/client.js";
import {
  type CubeShell,
  connectCube,
  connectSsh,
  HostKeyMismatchError,
  RunTimeoutError,
  SshError,
} from "../src/ssh.js";

const { Server, utils } = ssh2;

// An in-process ssh2 server on 127.0.0.1 that runs `exec` requests with /bin/sh,
// so the SDK's quoting is exercised by a real shell. Keys are generated here and
// never written anywhere.
const hostPair = utils.generateKeyPairSync("ed25519");
const otherHostPair = utils.generateKeyPairSync("ed25519");
const clientPair = utils.generateKeyPairSync("ed25519");
const strangerPair = utils.generateKeyPairSync("ed25519");

const pubBlob = (openssh: string) => openssh.trim().split(/\s+/)[1] as string;
const goodHostKeys = [{ type: "ssh-ed25519", key: pubBlob(hostPair.public) }];

const parsed = utils.parseKey(clientPair.public);
if (parsed instanceof Error) throw parsed;
const allowedKey = Array.isArray(parsed) ? (parsed[0] as (typeof parsed)[0]) : parsed;

let server: InstanceType<typeof Server>;
let port: number;
let shell: CubeShell;
const connections = new Set<{ end(): void }>();

before(async () => {
  server = new Server({ hostKeys: [hostPair.private] }, (client) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey" || ctx.key.algo !== allowedKey.type) return ctx.reject();
      if (!ctx.key.data.equals(allowedKey.getPublicSSH())) return ctx.reject();
      if (
        ctx.signature &&
        allowedKey.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) !== true
      ) {
        return ctx.reject();
      }
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const child = spawn("/bin/sh", ["-c", info.command], { stdio: "pipe" });
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          stream.pipe(child.stdin);
          child.on("close", (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
          stream.on("close", () => child.kill("SIGKILL"));
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  shell = await connectSsh({
    host: "127.0.0.1",
    port,
    username: "root",
    privateKey: clientPair.private,
    hostKeys: goodHostKeys,
  });
});

after(async () => {
  await shell.close();
  for (const c of connections) c.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("run returns stdout and a zero exit code", async () => {
  const r = await shell.run("echo hello");
  assert.deepEqual(r, { stdout: "hello\n", stderr: "", exitCode: 0 });
});

test("run returns stderr and a non-zero exit code", async () => {
  const r = await shell.run("echo oops >&2; exit 3");
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "oops\n");
  assert.equal(r.exitCode, 3);
});

test("run quotes an argv array", async () => {
  const r = await shell.run(["printf", "%s|", "a b", "it's", "$(echo pwned)", ""]);
  assert.equal(r.stdout, "a b|it's|$(echo pwned)||");
});

test("run quotes cwd and env", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "krova ssh '$(x) ")));
  try {
    const r = await shell.run(["sh", "-c", 'pwd; printf %s "$FOO"'], {
      cwd: dir,
      env: { FOO: "a b'c$(echo pwned)" },
    });
    assert.equal(r.stdout, `${dir}\na b'c$(echo pwned)`);
    assert.equal(r.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run applies cwd to every part of a string command", async () => {
  const r = await shell.run("pwd; pwd", { cwd: "/" });
  assert.equal(r.stdout, "/\n/\n");
});

test("run rejects a bad env name without sending anything", async () => {
  await assert.rejects(shell.run("true", { env: { "A;B": "1" } }), TypeError);
});

test("run writes stdin and closes it", async () => {
  const r = await shell.run("cat", { stdin: "from stdin" });
  assert.equal(r.stdout, "from stdin");
});

test("run times out with RunTimeoutError and the connection survives", async () => {
  await assert.rejects(shell.run("sleep 30", { timeoutMs: 300 }), RunTimeoutError);
  const r = await shell.run("echo still-here");
  assert.equal(r.stdout, "still-here\n");
});

test("a mismatched host key is refused", async () => {
  await assert.rejects(
    connectSsh({
      host: "127.0.0.1",
      port,
      username: "root",
      privateKey: clientPair.private,
      hostKeys: [{ type: "ssh-ed25519", key: pubBlob(otherHostPair.public) }],
    }),
    HostKeyMismatchError,
  );
});

test("a key the server does not accept fails without echoing the key", async () => {
  await assert.rejects(
    connectSsh({
      host: "127.0.0.1",
      port,
      username: "root",
      privateKey: strangerPair.private,
      hostKeys: goodHostKeys,
    }),
    (err: unknown) => {
      assert.ok(err instanceof SshError);
      assert.ok(!err.message.includes(strangerPair.private.trim().split("\n")[1] as string));
      return true;
    },
  );
});

const infoFor = (
  hostKeys: CubeSshInfo["hostKeys"],
  host: string | null = "127.0.0.1",
): CubeSshInfo => ({ host, port, user: "root", hostKeys });
const krovaWith = (info: CubeSshInfo) => ({
  cubes: {
    ssh: async (spaceId: string, cubeId: string) => {
      assert.equal(spaceId, "space_1");
      assert.equal(cubeId, "cube_1");
      return info;
    },
  },
});

test("connectCube pins the keys from cubes.ssh()", async () => {
  const s = await connectCube(krovaWith(infoFor(goodHostKeys)), "space_1", "cube_1", {
    privateKey: clientPair.private,
  });
  try {
    assert.equal((await s.run("echo ok")).stdout, "ok\n");
  } finally {
    await s.close();
  }
});

test("connectCube fails closed on empty or wrong host keys", async () => {
  const opts = { privateKey: clientPair.private };
  await assert.rejects(
    connectCube(krovaWith(infoFor([])), "space_1", "cube_1", opts),
    HostKeyMismatchError,
  );
  await assert.rejects(
    connectCube(
      krovaWith(infoFor([{ type: "ssh-ed25519", key: pubBlob(otherHostPair.public) }])),
      "space_1",
      "cube_1",
      opts,
    ),
    HostKeyMismatchError,
  );
});

test("connectCube honors a hostKeys override and a missing host", async () => {
  const s = await connectCube(krovaWith(infoFor([])), "space_1", "cube_1", {
    privateKey: clientPair.private,
    hostKeys: goodHostKeys,
  });
  await s.close();
  await assert.rejects(
    connectCube(krovaWith(infoFor(goodHostKeys, null)), "space_1", "cube_1", {
      privateKey: clientPair.private,
    }),
    SshError,
  );
});
