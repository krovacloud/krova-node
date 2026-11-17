import assert from "node:assert/strict";
import { test } from "node:test";
import type { CubeSshSource, RunOptions, RunResult } from "@krovacloud/sdk/ssh";
import { asSchema, type ToolSet } from "ai";
import {
  createKrovaSandbox,
  DEFAULT_MAX_OUTPUT_BYTES,
  type KrovaShell,
  krovaTools,
} from "../src/index.js";

/**
 * Tools against a fake shell, no network. The fake records every call so each test can
 * assert exactly what the tool asked the Cube to do.
 */
interface Calls {
  runs: { command: string | readonly string[]; options: RunOptions | undefined }[];
  reads: string[];
  writes: { path: string; data: string | Uint8Array }[];
}

function fakeShell(opts: {
  run?: (command: string | readonly string[]) => Partial<RunResult>;
  files?: Record<string, Uint8Array | string>;
}): { shell: KrovaShell; calls: Calls } {
  const calls: Calls = { runs: [], reads: [], writes: [] };
  const shell: KrovaShell = {
    async run(command, options) {
      calls.runs.push({ command, options });
      return { stdout: "", stderr: "", exitCode: 0, ...opts.run?.(command) };
    },
    files: {
      async read(path) {
        calls.reads.push(path);
        const file = opts.files?.[path];
        if (file === undefined) throw new Error(`No such file: ${path}`);
        return typeof file === "string" ? new Uint8Array(Buffer.from(file, "utf8")) : file;
      },
      async write(path, data) {
        calls.writes.push({ path, data });
      },
    },
  };
  return { shell, calls };
}

// biome-ignore lint/suspicious/noExplicitAny: the tool generics are exercised by the real call sites; here we only drive execute().
async function exec(t: { execute?: any }, input: unknown): Promise<any> {
  assert.ok(t.execute, "tool has an execute function");
  return await t.execute(input, { toolCallId: "call_1", messages: [], context: undefined });
}

test("krova_run sends the command, cwd and a default timeout, and returns the result", async () => {
  const { shell, calls } = fakeShell({
    run: () => ({ stdout: "hi\n", stderr: "warn\n", exitCode: 3 }),
  });
  const tools = krovaTools({ shell });
  const out = await exec(tools.krova_run, { command: "echo hi", cwd: "/work" });
  assert.deepEqual(out, { exitCode: 3, stdout: "hi\n", stderr: "warn\n", truncated: false });
  assert.deepEqual(calls.runs, [
    { command: "echo hi", options: { cwd: "/work", timeoutMs: 120_000 } },
  ]);
});

test("krova_run turns timeoutSeconds into milliseconds and honors defaultTimeoutMs", async () => {
  const { shell, calls } = fakeShell({});
  await exec(krovaTools({ shell }).krova_run, { command: "sleep 1", timeoutSeconds: 5 });
  await exec(krovaTools({ shell, defaultTimeoutMs: 9_000 }).krova_run, { command: "true" });
  assert.equal(calls.runs[0]?.options?.timeoutMs, 5_000);
  assert.equal(calls.runs[1]?.options?.timeoutMs, 9_000);
  assert.equal("cwd" in (calls.runs[0]?.options ?? {}), false);
});

test("krova_run reports the signal when the command was killed", async () => {
  const { shell } = fakeShell({ run: () => ({ exitCode: null, signal: "KILL" }) });
  const out = await exec(krovaTools({ shell }).krova_run, { command: "x" });
  assert.equal(out.exitCode, null);
  assert.equal(out.signal, "KILL");
});

test("krova_run truncates stdout and stderr separately and says so", async () => {
  const { shell } = fakeShell({
    run: () => ({ stdout: "a".repeat(100), stderr: "short" }),
  });
  const out = await exec(krovaTools({ shell, maxOutputBytes: 10 }).krova_run, { command: "x" });
  assert.equal(out.stdout, `${"a".repeat(10)}\n[truncated: 90 more bytes omitted]`);
  assert.equal(out.stderr, "short");
  assert.equal(out.truncated, true);
});

test("the default cap is 32 KB", async () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 32 * 1024);
  const { shell } = fakeShell({
    run: () => ({ stdout: "b".repeat(DEFAULT_MAX_OUTPUT_BYTES + 5) }),
  });
  const out = await exec(krovaTools({ shell }).krova_run, { command: "x" });
  assert.equal(out.truncated, true);
  assert.match(out.stdout, /\[truncated: 5 more bytes omitted\]$/);
});

test("truncation never splits a multi-byte character", async () => {
  // "é" is two bytes (c3 a9); a cap of 3 would land inside the second one.
  const { shell } = fakeShell({ run: () => ({ stdout: "éé" }) });
  const out = await exec(krovaTools({ shell, maxOutputBytes: 3 }).krova_run, { command: "x" });
  assert.equal(out.stdout, "é\n[truncated: 2 more bytes omitted]");
});

test("maxOutputBytes must be a positive integer", () => {
  const { shell } = fakeShell({});
  assert.throws(() => krovaTools({ shell, maxOutputBytes: 0 }), RangeError);
  assert.throws(() => krovaTools({ shell, maxOutputBytes: 1.5 }), RangeError);
});

test("krova_run does not run when the call was already aborted", async () => {
  const { shell, calls } = fakeShell({});
  const controller = new AbortController();
  controller.abort();
  const t = krovaTools({ shell }).krova_run;
  await assert.rejects(() =>
    // biome-ignore lint/suspicious/noExplicitAny: driving execute() directly
    (t.execute as any)(
      { command: "x" },
      { toolCallId: "c", messages: [], context: undefined, abortSignal: controller.signal },
    ),
  );
  assert.equal(calls.runs.length, 0);
});

test("krova_read_file returns text content and size", async () => {
  const { shell, calls } = fakeShell({ files: { "/etc/hostname": "cube-1\n" } });
  const out = await exec(krovaTools({ shell }).krova_read_file, { path: "/etc/hostname" });
  assert.deepEqual(out, {
    path: "/etc/hostname",
    sizeBytes: 7,
    binary: false,
    content: "cube-1\n",
    truncated: false,
  });
  assert.deepEqual(calls.reads, ["/etc/hostname"]);
});

test("krova_read_file truncates long files and reports the full size", async () => {
  const { shell } = fakeShell({ files: { "/big": "z".repeat(50) } });
  const out = await exec(krovaTools({ shell, maxOutputBytes: 20 }).krova_read_file, {
    path: "/big",
  });
  assert.equal(out.sizeBytes, 50);
  assert.equal(out.truncated, true);
  assert.equal(out.content, `${"z".repeat(20)}\n[truncated: 30 more bytes omitted]`);
});

test("krova_read_file does not return binary content", async () => {
  const { shell } = fakeShell({ files: { "/bin/x": new Uint8Array([0x7f, 0x45, 0x00, 0x01]) } });
  const out = await exec(krovaTools({ shell }).krova_read_file, { path: "/bin/x" });
  assert.deepEqual(out, { path: "/bin/x", sizeBytes: 4, binary: true });
});

test("krova_read_file lets a missing file surface as an error", async () => {
  const { shell } = fakeShell({});
  await assert.rejects(
    () => exec(krovaTools({ shell }).krova_read_file, { path: "/nope" }),
    /No such file/,
  );
});

test("krova_write_file creates parent directories, then writes", async () => {
  const { shell, calls } = fakeShell({});
  const out = await exec(krovaTools({ shell }).krova_write_file, {
    path: "/work/src/a.txt",
    content: "héllo",
  });
  assert.deepEqual(out, { path: "/work/src/a.txt", bytesWritten: 6 });
  assert.deepEqual(
    calls.runs.map((r) => r.command),
    [["mkdir", "-p", "/work/src"]],
  );
  assert.deepEqual(calls.writes, [{ path: "/work/src/a.txt", data: "héllo" }]);
});

test("krova_write_file skips mkdir for createParents false, a bare name and the root", async () => {
  const { shell, calls } = fakeShell({});
  const t = krovaTools({ shell }).krova_write_file;
  await exec(t, { path: "/work/a", content: "1", createParents: false });
  await exec(t, { path: "a.txt", content: "2" });
  await exec(t, { path: "/a.txt", content: "3" });
  assert.equal(calls.runs.length, 0);
  assert.equal(calls.writes.length, 3);
});

test("krova_write_file stops and explains when mkdir fails", async () => {
  const { shell, calls } = fakeShell({
    run: () => ({ exitCode: 1, stderr: "Permission denied\n" }),
  });
  await assert.rejects(
    () => exec(krovaTools({ shell }).krova_write_file, { path: "/root/x/a", content: "1" }),
    /Could not create \/root\/x: Permission denied/,
  );
  assert.equal(calls.writes.length, 0);
});

test("the tools are named for the model and describe the Cube honestly", () => {
  const { shell } = fakeShell({});
  const tools = krovaTools({ shell });
  assert.deepEqual(Object.keys(tools), ["krova_run", "krova_read_file", "krova_write_file"]);
  assert.match(tools.krova_run.description as string, /CPU-only Linux VM/);
  assert.match(tools.krova_run.description as string, /SSH/);
});

test("input schemas require the right fields", async () => {
  const { shell } = fakeShell({});
  const tools = krovaTools({ shell });
  const required = async (t: { inputSchema: Parameters<typeof asSchema>[0] }) =>
    ((await asSchema(t.inputSchema).jsonSchema) as { required?: string[] }).required ?? [];
  assert.deepEqual(await required(tools.krova_run), ["command"]);
  assert.deepEqual(await required(tools.krova_read_file), ["path"]);
  assert.deepEqual(await required(tools.krova_write_file), ["path", "content"]);
});

// Type-level check: the tools are accepted wherever `ai` wants a ToolSet. If `ai` changes the
// Tool shape, `pnpm typecheck` fails here, not in a customer's build.
test("the tools satisfy the ai ToolSet type", () => {
  const { shell } = fakeShell({});
  const tools = krovaTools({ shell }) satisfies ToolSet;
  const asToolSet: ToolSet = tools;
  assert.equal(Object.keys(asToolSet).length, 3);
});

test("createKrovaSandbox refuses a bad maxOutputBytes before it connects", async () => {
  let asked = false;
  const krova = {
    cubes: {
      ssh: async () => {
        asked = true;
        throw new Error("should not be called");
      },
    },
  };
  await assert.rejects(
    () =>
      createKrovaSandbox({ krova, spaceId: "s", cubeId: "c", privateKey: "k", maxOutputBytes: 0 }),
    RangeError,
  );
  assert.equal(asked, false);
});

test("createKrovaSandbox surfaces a Cube with no SSH address", async () => {
  const krova = {
    cubes: {
      ssh: async () => ({ host: null, port: 22, user: "root", hostKeys: [] }),
    },
  };
  await assert.rejects(
    () =>
      createKrovaSandbox({
        krova: krova as unknown as CubeSshSource,
        spaceId: "s",
        cubeId: "c",
        privateKey: "k",
      }),
    /no SSH address/,
  );
});
