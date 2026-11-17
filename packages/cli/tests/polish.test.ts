import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Command } from "commander";
import { KrovaError } from "@krovacloud/sdk";

import { completionCommand } from "../src/commands/completion.js";
import { cubesCommand } from "../src/commands/cubes.js";
import { COMPLETION_SHELLS, generateCompletion } from "../src/lib/completion.js";
import { errorHint, hintForStatus, isNetworkError } from "../src/lib/hints.js";
import { parseOutputFormat } from "../src/lib/output-format.js";
import { spinnerEnabled, startSpinner, withSpinner } from "../src/lib/spinner.js";

// ── completion ──────────────────────────────────────────────────────────────

function sampleProgram(): Command {
  const program = new Command("krova").option("-o, --output <format>", "output format");
  program.addCommand(cubesCommand());
  program.addCommand(completionCommand());
  return program;
}

for (const shell of COMPLETION_SHELLS) {
  test(`completion ${shell}: names the top-level commands, a subcommand, an alias and a long option`, () => {
    const script = generateCompletion(shell, sampleProgram());
    assert.match(script, /\bcubes\b/);
    assert.match(script, /\bcompletion\b/);
    assert.match(script, /\bcreate\b/, "a cubes subcommand");
    assert.match(script, /\bls\b/, "the `list` alias");
    // fish spells long options `-l name`; bash and zsh spell them `--name`.
    const long = (name: string) => new RegExp(shell === "fish" ? `-l ${name}\\b` : `--${name}\\b`);
    assert.match(script, long("vcpu"), "a long option of `cubes create`");
    assert.match(script, long("output"));
    assert.match(script, /json/, "the --output values");
  });
}

test("completion: a command added to the tree shows up with no other change", () => {
  const program = sampleProgram();
  program.addCommand(new Command("brand-new").alias("bn").description("a new command"));
  for (const shell of COMPLETION_SHELLS) {
    const script = generateCompletion(shell, program);
    assert.match(script, /brand-new/);
    assert.match(script, /\bbn\b/);
  }
});

test("completion: hidden commands are left out", () => {
  const program = sampleProgram();
  program.addCommand(new Command("secret-thing"), { hidden: true });
  assert.doesNotMatch(generateCompletion("bash", program), /secret-thing/);
});

test("completion bash: the generated function completes commands, subcommands and flag values", () => {
  const script = generateCompletion("bash", sampleProgram());
  const run = (words: string[]): string => {
    const probe = [
      script,
      `COMP_WORDS=(${words.map((w) => `'${w}'`).join(" ")})`,
      `COMP_CWORD=${words.length - 1}`,
      `COMPREPLY=()`,
      `_krova_complete`,
      `echo "\${COMPREPLY[*]}"`,
    ].join("\n");
    const out = spawnSync("bash", ["-c", probe], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  assert.match(run(["krova", "cu"]), /^cubes$/);
  assert.match(run(["krova", "cubes", "cr"]), /^create$/);
  assert.match(run(["krova", "cubes", "create", "--v"]), /^--vcpu$/);
  assert.equal(run(["krova", "-o", ""]), "table json");
});

test("completion: each choice flag completes its own values, and value flags fall back to files", () => {
  const program = new Command("krova")
    .option("-o, --output <format>", "output format")
    .option("--color <when>", "color output")
    .option("-i, --identity <file>", "key file");
  program.addCommand(new Command("run").argument("[path]"));
  const choices = { "-o": ["table", "json"], "--output": ["table", "json"], "--color": ["auto", "always"] };

  const bashScript = generateCompletion("bash", program, choices);
  const complete = (words: string[]): string => {
    const probe = [
      bashScript,
      `COMP_WORDS=(${words.map((w) => `'${w}'`).join(" ")})`,
      `COMP_CWORD=${words.length - 1}`,
      `COMPREPLY=()`,
      `_krova_complete`,
      `echo "\${COMPREPLY[*]}"`,
    ].join("\n");
    const out = spawnSync("bash", ["-c", probe], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  assert.equal(complete(["krova", "--color", ""]), "auto always");
  assert.equal(complete(["krova", "--output", ""]), "table json");
  assert.equal(complete(["krova", "-i", ""]), "", "a value flag with no choices offers nothing, so bash falls back to files");

  const zshScript = generateCompletion("zsh", program, choices);
  assert.match(zshScript, /'--color'\) compadd -- 'auto' 'always'/);
  assert.match(zshScript, /'--output'\) compadd -- 'table' 'json'/);
  assert.match(zshScript, /'--identity'\) _files/);

  const fishScript = generateCompletion("fish", program, choices);
  assert.match(fishScript, /-l color -x -a 'auto always'/);
  assert.match(fishScript, /-l output -x -a 'table json'/);
  assert.match(fishScript, /-l identity -r /, "a path flag keeps file completion");
  assert.doesNotMatch(fishScript, /^complete -c krova -f$/m, "file completion is not disabled globally");
  assert.match(fishScript, /-n 'test \(__krova_path\) = \\'root\\'' -f$/m, "only where subcommands are offered");
  assert.doesNotMatch(
    fishScript,
    /-n 'test \(__krova_path\) = \\'run\\'' -f$/m,
    "a command that takes arguments keeps file completion"
  );
});

test("every shell script parses in a shell that is installed", () => {
  const script = (s: "bash" | "zsh" | "fish") => generateCompletion(s, sampleProgram());
  for (const [shell, args] of [
    ["bash", ["-n"]],
    ["zsh", ["-n"]],
    ["fish", ["--no-execute"]],
  ] as const) {
    const probe = spawnSync(shell, ["-c", "exit 0"]);
    if (probe.error) continue; // shell not installed here
    const out = spawnSync(shell, [...args], { input: script(shell), encoding: "utf8" });
    assert.equal(out.status, 0, `${shell}: ${out.stderr}`);
  }
});

// ── -o / --output ───────────────────────────────────────────────────────────

test("parseOutputFormat: table by default, json and table accepted, anything else is a one-line error", () => {
  assert.equal(parseOutputFormat(undefined), "table");
  assert.equal(parseOutputFormat("table"), "table");
  assert.equal(parseOutputFormat("json"), "json");
  assert.throws(() => parseOutputFormat("yaml"), (e: Error) => {
    assert.equal(e.message, '--output must be "json" or "table" (got "yaml")');
    assert.doesNotMatch(e.message, /\n/);
    return true;
  });
});

// ── hints ───────────────────────────────────────────────────────────────────

test("hintForStatus maps each status to its hint", () => {
  assert.equal(hintForStatus(401), "Your API key was rejected. Run krova login, or check krova whoami.");
  assert.equal(
    hintForStatus(403),
    "Your key's member lacks the permission for this action. Ask a space owner to grant it."
  );
  assert.equal(hintForStatus(404), "Not found. Check the name or ID with the matching list command.");
  assert.equal(
    hintForStatus(409),
    "The resource is busy or in a conflicting state. Try again in a moment."
  );
  assert.equal(hintForStatus(429), "Rate limited. Wait a moment and try again.");
  for (const s of [500, 502, 503, 599]) {
    assert.equal(
      hintForStatus(s),
      "Krova had a server error. Try again; if it keeps happening, contact support."
    );
  }
  assert.equal(hintForStatus(400), undefined);
  assert.equal(hintForStatus(422), undefined);
});

test("errorHint: API errors by status, connection errors name the base URL, plain errors get nothing", () => {
  const api = (status: number) => new KrovaError("nope", { status });
  assert.equal(errorHint(api(404), "https://x"), hintForStatus(404));
  assert.equal(errorHint(api(400), "https://x"), undefined);

  const refused = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
  });
  assert.equal(
    errorHint(refused, "http://localhost:9/api/v1"),
    "Could not reach http://localhost:9/api/v1. Check your connection or KROVA_BASE_URL."
  );
  for (const code of ["ENOTFOUND", "ETIMEDOUT"]) {
    assert.ok(isNetworkError(Object.assign(new Error("x"), { code })), code);
  }
  assert.ok(isNetworkError(new TypeError("fetch failed")));

  assert.equal(errorHint(new Error("--vcpu must be a positive integer"), "https://x"), undefined);
});

test("errorHint: an error that carries its own hint keeps it and gets no second one", () => {
  const err = Object.assign(new KrovaError("nope", { status: 404 }), { hint: "Custom hint." });
  assert.equal(errorHint(err, "https://x"), "Custom hint.");
});

// ── spinner ─────────────────────────────────────────────────────────────────

const fakeStream = (isTTY: boolean) => {
  const writes: string[] = [];
  const stream = { isTTY, write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WriteStream;
  return { stream, writes };
};

test("spinner is a no-op when stderr is not a TTY or the output is JSON", async () => {
  const pipe = fakeStream(false);
  startSpinner("Working", { stream: pipe.stream }).stop();
  assert.equal(await withSpinner("Working", { stream: pipe.stream }, async () => 7), 7);
  assert.deepEqual(pipe.writes, []);

  const tty = fakeStream(true);
  startSpinner("Working", { json: true, stream: tty.stream }).stop();
  assert.deepEqual(tty.writes, []);
  assert.equal(spinnerEnabled(false, pipe.stream), false);
  assert.equal(spinnerEnabled(true, tty.stream), false);
  assert.equal(spinnerEnabled(false, tty.stream), true);
});

test("spinner draws on a TTY and clears its line on success and on failure", async () => {
  const ok = fakeStream(true);
  await withSpinner("Working", { stream: ok.stream }, async () => undefined);
  assert.match(ok.writes[0]!, /Working/);
  assert.equal(ok.writes.at(-1), "\r\x1b[K");

  const bad = fakeStream(true);
  await assert.rejects(
    withSpinner("Working", { stream: bad.stream }, async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(bad.writes.at(-1), "\r\x1b[K");

  const twice = fakeStream(true);
  const sp = startSpinner("Working", { stream: twice.stream });
  sp.stop();
  const n = twice.writes.length;
  sp.stop();
  assert.equal(twice.writes.length, n, "a second stop writes nothing");
});

// ── end to end: the built CLI against a mock API ────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl: string;
let handler: Handler;

before(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

function reply(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function runCli(
  args: string[],
  opts: { base?: string; withGlobals?: boolean } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // The BUILT entry, the file `npx krova` runs (CI builds before it tests).
  const entry = join(import.meta.dirname, "..", "dist", "index.js");
  const globals =
    opts.withGlobals === false
      ? []
      : ["--api-key", "kro_test", "--space", "space_1", "--base-url", opts.base ?? baseUrl];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args, ...globals], {
      env: { ...process.env, HOME: "/nonexistent-krova-home", KROVA_API_KEY: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const cube = {
  id: "cube_1",
  name: "web",
  state: "running",
  image: "ubuntu-24.04",
  publicIpv4: "203.0.113.5",
  terminationProtection: false,
  resources: { vcpu: 1, ramGb: 1, diskGb: 10 },
};

test("`-o json` prints exactly what `--json` prints", async () => {
  handler = (_req, res) => reply(res, 200, { cubes: [cube] });
  const long = await runCli(["cubes", "list", "--json"]);
  const short = await runCli(["cubes", "list", "-o", "json"]);
  const root = await runCli(["-o", "json", "cubes", "list"]);
  assert.equal(long.code, 0, long.stderr);
  assert.deepEqual(JSON.parse(long.stdout), [cube]);
  assert.equal(short.stdout, long.stdout);
  assert.equal(root.stdout, long.stdout);

  const table = await runCli(["cubes", "list", "-o", "table"]);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /^ID\s+NAME/);
});

test("an invalid `-o` value fails with one line", async () => {
  handler = (_req, res) => reply(res, 200, { cubes: [] });
  const run = await runCli(["cubes", "list", "-o", "yaml"]);
  assert.equal(run.code, 1);
  assert.equal(run.stderr.trim(), 'Error: --output must be "json" or "table" (got "yaml")');
  assert.equal(run.stdout, "");
});

test("an API error gets one hint line under the error; JSON mode stays as it was", async () => {
  handler = (_req, res) => reply(res, 404, { error: "Cube not found" });
  const plain = await runCli(["cubes", "list"]);
  assert.equal(plain.code, 1);
  assert.deepEqual(plain.stderr.trim().split("\n"), [
    "Error: Cube not found",
    "Not found. Check the name or ID with the matching list command.",
  ]);

  const asJson = await runCli(["cubes", "list", "--json"]);
  assert.equal(asJson.code, 1);
  assert.equal(asJson.stderr.trim(), "Error: Cube not found");
  assert.equal(asJson.stdout, "");
});

test("a 401 hint is printed once", async () => {
  handler = (_req, res) => reply(res, 401, { error: "Invalid API key" });
  const run = await runCli(["cubes", "list"]);
  const hint = "Your API key was rejected. Run krova login, or check krova whoami.";
  assert.equal(run.stderr.split(hint).length - 1, 1, run.stderr);
});

test("an unreachable server names the base URL it tried", async () => {
  const closed = await new Promise<number>((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
  const dead = `http://127.0.0.1:${closed}/api/v1`;
  const run = await runCli(["cubes", "list"], { base: dead });
  assert.equal(run.code, 1);
  assert.match(run.stderr, new RegExp(`Could not reach ${dead.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\. Check your connection or KROVA_BASE_URL\\.`));
});

test("`krova completion <shell>` prints a script for each shell and rejects others", async () => {
  for (const shell of COMPLETION_SHELLS) {
    const run = await runCli(["completion", shell], { withGlobals: false });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /login/);
    assert.match(run.stdout, /backups/);
    assert.match(run.stdout, /share/);
    assert.match(run.stdout, /completion/);
  }
  const bad = await runCli(["completion", "tcsh"], { withGlobals: false });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /bash, zsh, fish|bash.*zsh.*fish/);
});

test("`krova completion --help` shows how to install it for each shell", async () => {
  const run = await runCli(["completion", "--help"], { withGlobals: false });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /\$\{fpath\[1\]\}\/_krova/);
  assert.match(run.stdout, /bash-completion\/completions\/krova/);
  assert.match(run.stdout, /fish\/completions\/krova\.fish/);
});
