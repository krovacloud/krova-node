import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { Backup, BackupShare, KrovaClient } from "@krovacloud/sdk";

import { backupsCommand, resolveBackup, shareRows } from "../src/commands/backups.js";

const backup = (id: string, name: string): Backup => ({
  id,
  name,
  status: "complete",
  originalCubeId: "cube_1",
  originalCubeName: "db",
  sizeBytes: 1024,
  diskSizeGb: 20,
  config: {
    vcpus: 2,
    ramMb: 2048,
    diskLimitGb: 20,
    imageId: "ubuntu-24.04",
    regionId: "fra",
    regionName: "Frankfurt",
    domains: [],
    tcpPorts: [],
  },
  sharedFromBackupId: null,
  redeployedCubeId: null,
  completedAt: "2026-10-06T00:00:00Z",
  createdAt: "2026-10-06T00:00:00Z",
});

const share = (id: string, name: string, other: string): BackupShare => ({
  id,
  status: "pending",
  backupId: "bk_1",
  backupName: name,
  sourceSpaceId: "space_src",
  destinationSpaceId: "space_dst",
  counterpartySpaceName: other,
  copyBackupId: null,
  expiresAt: "2026-10-09T00:00:00Z",
  createdAt: "2026-10-07T00:00:00Z",
});

const fakeClient = (backups: Backup[]) =>
  ({ backups: { list: async () => backups } }) as unknown as KrovaClient;

test("backups exposes list, get, download, share, shares, accept, decline and cancel", () => {
  const names = backupsCommand()
    .commands.map((c) => c.name())
    .sort();
  assert.deepEqual(names, [
    "accept",
    "cancel",
    "decline",
    "download",
    "get",
    "list",
    "share",
    "shares",
  ]);
  const shareCmd = backupsCommand().commands.find((c) => c.name() === "share");
  assert.ok(shareCmd);
  assert.equal(shareCmd.registeredArguments.length, 2, "backup, destination space id");
  assert.ok(shareCmd.options.some((o) => o.long === "--idempotency-key"));
  // The description is what a user reads before offering a copy: it must say the
  // destination pays and that the offer expires.
  assert.match(shareCmd.description(), /pays/);
  assert.match(shareCmd.description(), /48 hours/);
});

test("resolveBackup: an id wins, a unique name resolves, and ambiguity is refused", async () => {
  const client = fakeClient([
    backup("bk_1", "nightly"),
    backup("bk_2", "weekly"),
    backup("bk_3", "weekly"),
  ]);
  assert.equal(await resolveBackup(client, "space", "bk_2"), "bk_2");
  assert.equal(await resolveBackup(client, "space", "nightly"), "bk_1");
  await assert.rejects(() => resolveBackup(client, "space", "weekly"), /ambiguous.*bk_2, bk_3/);
  await assert.rejects(() => resolveBackup(client, "space", "monthly"), /no backup named/);
});

test("shareRows lists incoming before outgoing and names the other space", () => {
  const rows = shareRows({
    incoming: [share("bs_in", "lab", "Harbor Studio")],
    outgoing: [share("bs_out", "nightly", "Northwind Lab")],
  });
  assert.deepEqual(
    rows.map((r) => [r[0], r[1], r[3]]),
    [
      ["bs_in", "incoming", "Harbor Studio"],
      ["bs_out", "outgoing", "Northwind Lab"],
    ]
  );
});

// ── End to end: the real CLI entry point against a local mock API ───────────

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let baseUrl: string;
let handler: Handler;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // The BUILT entry, the file `npx krova` runs (CI builds before it tests).
  // `src/` cannot run directly: `version.ts` reads `../package.json` relative to `dist/`.
  const entry = join(import.meta.dirname, "..", "dist", "index.js");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        entry,
        ...args,
        "--api-key",
        "kro_test",
        "--space",
        "space_src",
        "--base-url",
        baseUrl,
      ],
      // An empty HOME keeps the run away from the developer's saved contexts.
      { env: { ...process.env, HOME: "/nonexistent-krova-home", KROVA_API_KEY: "" } }
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

test("`krova backups share <name> <space>` resolves the name and posts the destination", async () => {
  const seen: string[] = [];
  let posted: unknown;
  handler = (req, res, body) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "GET") return json(res, 200, { backups: [backup("bk_1", "nightly")] });
    posted = JSON.parse(body || "{}");
    json(res, 201, { share: share("bs_1", "nightly", "Northwind Lab") });
  };
  const run = await runCli(["backups", "share", "nightly", "space_dst"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(seen, [
    "GET /api/v1/spaces/space_src/backups",
    "POST /api/v1/spaces/space_src/backups/bk_1/shares",
  ]);
  assert.deepEqual(posted, { destinationSpaceId: "space_dst" });
  assert.match(run.stdout, /Share bs_1 requested\. Northwind Lab has until/);
});

test("`krova backups accept` exits non-zero with the API's reason when refused", async () => {
  handler = (_req, res) =>
    json(res, 403, {
      error:
        "Only the destination space's owner, or a member who can manage its backups, can respond to this share.",
    });
  const run = await runCli(["backups", "accept", "bs_1"]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /manage its backups/);
});

test("`krova backups download` warns that the link is a credential", async () => {
  handler = (req, res) =>
    req.url?.endsWith("/backups")
      ? json(res, 200, { backups: [backup("bk_1", "nightly")] })
      : json(res, 200, {
      url: "https://s3.example.test/backups/x.cube?sig=abc",
      filename: "nightly.cube",
      sizeBytes: 1024,
      expiresAt: "2026-10-07T00:15:00Z",
    });
  const run = await runCli(["backups", "download", "bk_1"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /https:\/\/s3\.example\.test/);
  assert.match(run.stderr, /Anyone with this link can download/);
});
