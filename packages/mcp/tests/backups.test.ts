import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { KrovaClient } from "@krovacloud/sdk";

import { runTool, TOOLS, type ToolContext, type ToolDef } from "../src/tools.js";

/**
 * The backup and backup-share tools against a local mock API: the request each
 * one sends, the hints a client uses to decide what needs the user's
 * confirmation, and how a refusal reaches the model. Standalone, like
 * `termination-protection.test.ts`.
 */
interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

class MockApi {
  server: Server;
  baseUrl = "";
  requests: CapturedRequest[] = [];
  private route: ((req: CapturedRequest, res: ServerResponse) => void) | undefined;

  constructor() {
    this.server = createServer((req, res) => this.onRequest(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  handle(route: (req: CapturedRequest, res: ServerResponse) => void): void {
    this.route = route;
    this.requests = [];
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
      };
      this.requests.push(captured);
      if (this.route) this.route(captured, res);
      else {
        res.writeHead(500);
        res.end("no route installed");
      }
    });
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function findTool(name: string): ToolDef {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

const ctx: ToolContext = { defaultSpaceId: "space_default" };
const mock = new MockApi();
let client: KrovaClient;
before(async () => {
  await mock.start();
  client = new KrovaClient({ apiKey: "kro_test_key", baseUrl: mock.baseUrl, maxRetries: 0 });
});
after(() => mock.stop());

const share = {
  id: "bs_1",
  status: "pending",
  backupId: "bk_1",
  backupName: "postgres-nightly",
  sourceSpaceId: "space_default",
  destinationSpaceId: "space_dst",
  counterpartySpaceName: "Northwind Lab",
  copyBackupId: null,
  expiresAt: "2026-10-09T00:00:00Z",
  createdAt: "2026-10-07T00:00:00Z",
};

describe("backup tools", () => {
  it("never offers a download link to the model", () => {
    // The presigned link downloads the whole disk with no further auth.
    assert.equal(
      TOOLS.some((t) => /download/i.test(t.name)),
      false,
    );
  });

  it("marks sharing and accepting for confirmation, and reads as read-only", () => {
    // A share hands a copy of the disk to another space, and an accept adds a
    // recurring bill: both must reach the user before they run.
    for (const name of ["share_backup", "accept_backup_share"]) {
      assert.equal(findTool(name).annotations.destructiveHint, true, `${name} is destructive`);
    }
    for (const name of ["list_backups", "get_backup", "list_backup_shares"]) {
      assert.equal(findTool(name).annotations.readOnlyHint, true, `${name} is read-only`);
    }
  });

  it("share_backup posts the destination for the default space", async () => {
    mock.handle((_req, res) => json(res, 201, { share }));
    const result = await runTool(
      findTool("share_backup"),
      client,
      { backupId: "bk_1", destinationSpaceId: "space_dst" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(mock.requests[0]?.method, "POST");
    assert.equal(mock.requests[0]?.url, "/spaces/space_default/backups/bk_1/shares");
    assert.deepEqual(mock.requests[0]?.body, { destinationSpaceId: "space_dst" });
    assert.equal(JSON.parse(result.content[0]!.text).id, "bs_1");
  });

  it("list, accept, decline and cancel hit their own paths", async () => {
    mock.handle((req, res) => {
      if (req.url.endsWith("/backup-shares")) return json(res, 200, { incoming: [share], outgoing: [] });
      if (req.url.endsWith("/accept"))
        return json(res, 200, {
          share: { ...share, status: "accepted" },
          backup: { id: "bk_copy" },
        });
      json(res, 200, { share: { ...share, status: req.url.endsWith("/decline") ? "declined" : "canceled" } });
    });
    for (const name of ["list_backup_shares", "accept_backup_share", "decline_backup_share", "cancel_backup_share"]) {
      const result = await runTool(findTool(name), client, { spaceId: "space_x", shareId: "bs_1" }, ctx);
      assert.equal(result.isError, undefined, `${name}: ${result.content[0]?.text}`);
    }
    assert.deepEqual(
      mock.requests.map((r) => `${r.method} ${r.url}`),
      [
        "GET /spaces/space_x/backup-shares",
        "POST /spaces/space_x/backup-shares/bs_1/accept",
        "POST /spaces/space_x/backup-shares/bs_1/decline",
        "POST /spaces/space_x/backup-shares/bs_1/cancel",
      ],
    );
  });

  it("a refused accept reaches the model as an error carrying the API's reason", async () => {
    mock.handle((_req, res) =>
      json(res, 403, {
        error:
          "Only the destination space's owner, or a member who can manage its backups, can respond to this share.",
      }),
    );
    const result = await runTool(findTool("accept_backup_share"), client, { shareId: "bs_1" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /\(403\).*manage its backups/);
  });

  it("list_backups and get_backup read the space's backups", async () => {
    mock.handle((req, res) =>
      req.url.endsWith("/backups")
        ? json(res, 200, { backups: [{ id: "bk_1" }] })
        : json(res, 200, { backup: { id: "bk_1" } }),
    );
    await runTool(findTool("list_backups"), client, {}, ctx);
    await runTool(findTool("get_backup"), client, { backupId: "bk_1" }, ctx);
    assert.deepEqual(
      mock.requests.map((r) => `${r.method} ${r.url}`),
      ["GET /spaces/space_default/backups", "GET /spaces/space_default/backups/bk_1"],
    );
  });
});
