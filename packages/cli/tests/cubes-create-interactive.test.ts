import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Command } from "commander";

import { buildCreateBody, createCmd, type CreateDeps } from "../src/commands/cubes.js";
import {
  type CatalogSource,
  type KeyFiles,
  type PromptIO,
  PromptAbortError,
  confirmCreate,
  findKeyCandidates,
  isInteractive,
  promptCreate,
  summarize,
} from "../src/lib/create-prompt.js";

const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLE ana@laptop";
const RSA = "ssh-rsa AAAAB3NzaC1yc2EEXAMPLE ana@old";

const IMAGES = [
  { id: "ubuntu-24.04", name: "Ubuntu", version: "24.04", description: "", defaultUser: "ubuntu" },
  { id: "debian-12", name: "Debian", version: "12", description: "", defaultUser: "debian" },
];
const REGIONS = [
  { id: "r1", slug: "fra", name: "Frankfurt" },
  { id: "r2", slug: "iad", name: "Ashburn" },
];

const fakeCatalog = (overrides: Partial<CatalogSource> = {}): CatalogSource => ({
  images: async () => ({ images: IMAGES }),
  regions: async () => ({ regions: REGIONS }),
  ...overrides,
});

/** Answers come off a queue; running dry means the input closed. */
function scriptedIO(answers: string[]): PromptIO & { asked: string[]; out: string[]; warned: string[] } {
  const queue = [...answers];
  const io = {
    asked: [] as string[],
    out: [] as string[],
    warned: [] as string[],
    ask: async (q: string) => {
      io.asked.push(q);
      const next = queue.shift();
      if (next === undefined) throw new PromptAbortError();
      return next;
    },
    write: (t: string) => void io.out.push(t),
    warn: (t: string) => void io.warned.push(t),
    close: () => undefined,
  };
  return io;
}

/** A fake ~/.ssh. Records every path read, and fails any path that is not a stored file. */
function fakeKeyFiles(files: Record<string, string>): KeyFiles & { reads: string[] } {
  const keyFiles = {
    home: "/home/ana",
    reads: [] as string[],
    readFile: async (path: string) => {
      keyFiles.reads.push(path);
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return content;
    },
  };
  return keyFiles;
}

test("isInteractive needs a TTY on both ends and no --json", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(isInteractive({ json: false, stdin: tty, stdout: tty }), true);
  assert.equal(isInteractive({ json: true, stdin: tty, stdout: tty }), false);
  assert.equal(isInteractive({ json: false, stdin: pipe, stdout: tty }), false);
  assert.equal(isInteractive({ json: false, stdin: tty, stdout: pipe }), false);
  assert.equal(isInteractive({ json: false, stdin: {}, stdout: {} }), false);
});

test("a full set of answers produces the create body", async () => {
  const io = scriptedIO([
    "web", // name
    "2", // image: debian-12
    "1", // region: fra
    "2", // vcpus
    "4", // ram
    "", // disk: default 10
    "", // key: first candidate
  ]);
  const keyFiles = fakeKeyFiles({ "/home/ana/.ssh/id_ed25519.pub": `${ED25519}\n` });
  const answers = await promptCreate({}, { io, catalog: fakeCatalog(), keyFiles });
  assert.deepEqual(answers, {
    name: "web",
    image: "debian-12",
    sshKey: ED25519,
    region: "fra",
    vcpu: "2",
    ram: "4",
    disk: "10",
  });
  assert.deepEqual(buildCreateBody(answers), {
    name: "web",
    image: "debian-12",
    sshPublicKey: ED25519,
    region: "fra",
    resources: { vcpu: 2, ramGb: 4, diskGb: 10 },
  });
  assert.match(io.out.join(""), /1\) ubuntu-24\.04/);
  assert.match(io.out.join(""), /2\) iad/);
});

test("an image can be typed as its slug, and Enter skips the region", async () => {
  const io = scriptedIO(["db", "ubuntu-24.04", "", "", "", "", ED25519]);
  const answers = await promptCreate({}, { io, catalog: fakeCatalog(), keyFiles: fakeKeyFiles({}) });
  assert.equal(answers.image, "ubuntu-24.04");
  assert.equal(answers.region, undefined);
  assert.deepEqual(
    { v: answers.vcpu, r: answers.ram, d: answers.disk },
    { v: "1", r: "1", d: "10" },
  );
  assert.equal("region" in buildCreateBody(answers), false);
});

test("values given as flags are not asked again", async () => {
  const io = scriptedIO(["1"]); // only the key
  const keyFiles = fakeKeyFiles({ "/home/ana/.ssh/id_rsa.pub": RSA });
  const answers = await promptCreate(
    { name: "api", image: "debian-12", region: "iad", vcpu: "4", ram: "8", disk: "50" },
    { io, catalog: fakeCatalog(), keyFiles },
  );
  assert.equal(io.asked.length, 1);
  assert.match(io.asked[0] as string, /SSH key/);
  assert.deepEqual(answers, {
    name: "api",
    image: "debian-12",
    sshKey: RSA,
    region: "iad",
    vcpu: "4",
    ram: "8",
    disk: "50",
  });
});

test("bad answers are asked again", async () => {
  const io = scriptedIO([
    "   ", // empty name
    "x".repeat(65), // too long
    "ok-name",
    "9", // no such image
    "1",
    "7", // no such region
    "",
    "0", // vcpus
    "two",
    "2",
    "1",
    "10",
    "not a key",
    ED25519,
  ]);
  const answers = await promptCreate({}, { io, catalog: fakeCatalog(), keyFiles: fakeKeyFiles({}) });
  assert.equal(answers.name, "ok-name");
  assert.equal(answers.image, "ubuntu-24.04");
  assert.equal(answers.vcpu, "2");
  assert.equal(answers.sshKey, ED25519);
  assert.equal(io.asked.filter((q) => q.startsWith("Name")).length, 3);
});

test("only .pub files are read, and ed25519 is offered before rsa", async () => {
  const keyFiles = fakeKeyFiles({
    "/home/ana/.ssh/id_ed25519.pub": ED25519,
    "/home/ana/.ssh/id_ed25519": "-----BEGIN OPENSSH PRIVATE KEY-----",
    "/home/ana/.ssh/id_rsa.pub": RSA,
    "/home/ana/.ssh/id_rsa": "-----BEGIN RSA PRIVATE KEY-----",
  });
  const found = await findKeyCandidates(keyFiles);
  assert.deepEqual(
    found.map((c) => c.label),
    ["~/.ssh/id_ed25519.pub", "~/.ssh/id_rsa.pub"],
  );
  assert.deepEqual(keyFiles.reads, ["/home/ana/.ssh/id_ed25519.pub", "/home/ana/.ssh/id_rsa.pub"]);
  assert.ok(keyFiles.reads.every((p) => p.endsWith(".pub")));
});

test("a missing or unreadable key file is skipped, and a private key is never shown", async () => {
  const keyFiles = fakeKeyFiles({ "/home/ana/.ssh/id_ed25519.pub": "-----BEGIN OPENSSH PRIVATE KEY-----" });
  assert.deepEqual(await findKeyCandidates(keyFiles), []);

  const io = scriptedIO([ED25519]);
  const answers = await promptCreate(
    { name: "a", image: "debian-12", region: "fra", vcpu: "1", ram: "1", disk: "10" },
    { io, catalog: fakeCatalog(), keyFiles },
  );
  assert.equal(answers.sshKey, ED25519);
  assert.match(io.asked[0] as string, /paste it/);
});

test("the key picker shows the type and comment but never the key body", async () => {
  const io = scriptedIO([""]);
  await promptCreate(
    { name: "a", image: "debian-12", region: "fra", vcpu: "1", ram: "1", disk: "10" },
    { io, catalog: fakeCatalog(), keyFiles: fakeKeyFiles({ "/home/ana/.ssh/id_ed25519.pub": ED25519 }) },
  );
  const shown = io.out.join("");
  assert.match(shown, /~\/\.ssh\/id_ed25519\.pub/);
  assert.match(shown, /ssh-ed25519 ana@laptop/);
  assert.doesNotMatch(shown, /AAAAC3NzaC1lZDI1NTE5/);
});

test("a catalog that fails falls back to typing the image slug", async () => {
  const io = scriptedIO(["web", "ubuntu-24.04", "1", "1", "10", ED25519]);
  const catalog = fakeCatalog({
    images: async () => {
      throw new Error("offline");
    },
    regions: async () => {
      throw new Error("offline");
    },
  });
  const answers = await promptCreate({}, { io, catalog, keyFiles: fakeKeyFiles({}) });
  assert.equal(answers.image, "ubuntu-24.04");
  assert.equal(answers.region, undefined);
  assert.equal(io.warned.length, 2);
});

test("input that ends mid-prompt aborts", async () => {
  const io = scriptedIO(["web"]);
  await assert.rejects(
    promptCreate({}, { io, catalog: fakeCatalog(), keyFiles: fakeKeyFiles({}) }),
    PromptAbortError,
  );
});

test("confirm: Enter and yes create, no declines, anything else asks again", async () => {
  const summary = summarize({ name: "web", image: "debian-12", region: "fra", vcpu: "2", ram: "4", disk: "10" });
  assert.equal(summary, 'Create cube "web" (debian-12, region fra, 2 vCPU, 4 GB RAM, 10 GB disk)');
  assert.equal(await confirmCreate(scriptedIO([""]), summary), true);
  assert.equal(await confirmCreate(scriptedIO(["Y"]), summary), true);
  assert.equal(await confirmCreate(scriptedIO(["no"]), summary), false);
  const io = scriptedIO(["maybe", "n"]);
  assert.equal(await confirmCreate(io, summary), false);
  assert.equal(io.asked.length, 2);
  assert.match(io.asked[0] as string, /\[Y\/n\] $/);
});

test("buildCreateBody keeps the existing validation messages", () => {
  const base = { name: "a", image: "i", sshKey: "k", vcpu: "1", ram: "1", disk: "10" };
  assert.throws(() => buildCreateBody({ ...base, vcpu: "0" }), /--vcpu must be a positive integer \(got "0"\)/);
  assert.throws(() => buildCreateBody({ ...base, ram: "x" }), /--ram must be a positive integer/);
  assert.deepEqual(buildCreateBody({ ...base, terminationProtection: true, userData: "#!/bin/sh" }), {
    name: "a",
    image: "i",
    sshPublicKey: "k",
    resources: { vcpu: 1, ramGb: 1, diskGb: 10 },
    userData: "#!/bin/sh",
    terminationProtection: true,
  });
});

// ── The command itself, against a local mock API ────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let baseUrl: string;
const seen: Array<{ method?: string; url?: string; body: string }> = [];

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const handler: Handler = (req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/images")) return json(res, 200, { images: IMAGES });
  if (req.method === "GET" && req.url?.endsWith("/regions")) return json(res, 200, { regions: REGIONS });
  if (req.method === "POST" && req.url?.endsWith("/cubes")) {
    return json(res, 201, { cube: { id: "cube_1", state: "Provisioning" } });
  }
  json(res, 404, { error: "not found" });
};

const posts = () => seen.filter((r) => r.method === "POST");

/** Run `cubes create` in this process with the prompt seams injected. Returns what it printed. */
async function runCreate(
  args: string[],
  deps: CreateDeps,
): Promise<{ stdout: string; exitCode: typeof process.exitCode }> {
  const program = new Command().exitOverride();
  program.option("--api-key <key>").option("--space <id>").option("--base-url <url>").option("--json");
  const chunks: string[] = [];
  program.addCommand(createCmd({ ...deps, stdout: (text) => void chunks.push(text) }));
  const prevExit = process.exitCode;
  await program.parseAsync(
    ["node", "krova", "create", ...args, "--api-key", "kro_test", "--space", "space_1", "--base-url", baseUrl],
    { from: "node" },
  );
  const result = { stdout: chunks.join(""), exitCode: process.exitCode };
  process.exitCode = prevExit;
  return result;
}

const depsWith = (io: PromptIO, interactive = true): CreateDeps => ({
  interactive: () => interactive,
  makeIO: () => io,
  keyFiles: () => fakeKeyFiles({ "/home/ana/.ssh/id_ed25519.pub": ED25519 }),
});

test("cubes create in a terminal asks for what is missing, confirms, then posts", async () => {
  seen.length = 0;
  const io = scriptedIO(["web", "1", "2", "2", "2", "20", "", ""]); // ..., key Enter, confirm Enter
  const run = await runCreate([], depsWith(io));
  assert.equal(posts().length, 1);
  assert.deepEqual(JSON.parse(posts()[0]?.body as string), {
    name: "web",
    image: "ubuntu-24.04",
    sshPublicKey: ED25519,
    region: "iad",
    resources: { vcpu: 2, ramGb: 2, diskGb: 20 },
  });
  assert.match(io.asked.at(-1) as string, /^Create cube "web" \(ubuntu-24\.04, region iad, 2 vCPU, 2 GB RAM, 20 GB disk\)\? \[Y\/n\] $/);
  assert.match(run.stdout, /Created cube cube_1 \(Provisioning\)/);
});

test("cubes create --yes skips the confirmation", async () => {
  seen.length = 0;
  const io = scriptedIO(["web", "2", "", "", "", "", ""]);
  await runCreate(["--yes"], depsWith(io));
  assert.equal(posts().length, 1);
  assert.ok(!io.asked.some((q) => q.includes("[Y/n]")));
});

test("answering no at the confirmation creates nothing", async () => {
  seen.length = 0;
  const io = scriptedIO(["web", "1", "", "", "", "", "", "n"]);
  const run = await runCreate([], depsWith(io));
  assert.equal(posts().length, 0);
  assert.match(run.stdout, /Aborted\./);
});

test("input ending mid-prompt creates nothing and exits 1", async () => {
  seen.length = 0;
  const io = scriptedIO(["web"]);
  const run = await runCreate([], depsWith(io));
  assert.equal(posts().length, 0);
  assert.equal(run.exitCode, 1);
});

test("a fully flagged create never prompts, even in a terminal", async () => {
  seen.length = 0;
  const io = scriptedIO([]);
  let ioMade = false;
  const deps: CreateDeps = { ...depsWith(io), makeIO: () => ((ioMade = true), io) };
  await runCreate(["--name", "a", "--image", "debian-12", "--ssh-key", ED25519], deps);
  assert.equal(ioMade, false);
  assert.equal(posts().length, 1);
  assert.equal(io.asked.length, 0);
});

test("a flag given in a terminal is kept and only the rest is asked", async () => {
  seen.length = 0;
  const io = scriptedIO(["1", "", "", "", ""]); // image, region Enter, ram, disk, key; vcpu from flag
  await runCreate(["--name", "web", "--vcpu", "4", "--yes"], depsWith(io));
  const body = JSON.parse(posts()[0]?.body as string);
  assert.equal(body.name, "web");
  assert.equal(body.resources.vcpu, 4);
  assert.ok(!io.asked.some((q) => q.startsWith("Name") || q.startsWith("vCPUs")));
});

// ── Without a terminal: byte for byte what it was ───────────────────────────

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entry = join(import.meta.dirname, "..", "dist", "index.js");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [entry, "cubes", "create", ...args, "--api-key", "kro_test", "--space", "space_1", "--base-url", baseUrl],
      { env: { ...process.env, KROVA_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("without a terminal a missing flag fails with commander's error, in order, and calls nothing", async () => {
  seen.length = 0;
  const cases: Array<[string[], string]> = [
    [[], "--name <name>"],
    [["--name", "a"], "--image <slug>"],
    [["--name", "a", "--image", "x"], "--ssh-key <key>"],
    [["--ssh-key", "k", "--image", "x"], "--name <name>"],
  ];
  for (const [args, flag] of cases) {
    const run = await runCli(args);
    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, `error: required option '${flag}' not specified\n`);
  }
  assert.equal(seen.length, 0, "no API call before the flags are complete");
});

test("without a terminal a fully flagged create posts the same body as before", async () => {
  seen.length = 0;
  const run = await runCli([
    "--name",
    "web",
    "--image",
    "debian-12",
    "--ssh-key",
    ED25519,
    "--vcpu",
    "2",
    "--termination-protection",
    "--json",
  ]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(posts()[0]?.body as string), {
    name: "web",
    image: "debian-12",
    sshPublicKey: ED25519,
    resources: { vcpu: 2, ramGb: 1, diskGb: 10 },
    terminationProtection: true,
  });
  assert.equal(JSON.parse(run.stdout).id, "cube_1");
  assert.ok(!seen.some((r) => r.url?.endsWith("/images") || r.url?.endsWith("/regions")), "no catalog calls");
});
