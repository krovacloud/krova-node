import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { KrovaClient } from "@krovacloud/sdk";
import { runTool, TOOLS, type ToolContext, type ToolDef } from "../src/tools.js";

/** A single captured request against the mock API server. */
interface CapturedRequest {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: unknown;
}

/**
 * A minimal `node:http` mock of the Krova Cloud API. Each test installs a route
 * handler; the server records every request for assertions. No real network is
 * ever touched — the SDK is pointed at `http://127.0.0.1:<port>`.
 */
class MockApi {
  server: Server;
  baseUrl = "";
  requests: CapturedRequest[] = [];
  private route:
    | ((req: CapturedRequest, res: ServerResponse) => void)
    | undefined;

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

  /** Install the handler used for the next request(s). */
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
        headers: req.headers,
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

function makeClient(baseUrl: string): KrovaClient {
  return new KrovaClient({ apiKey: "kro_test_key", baseUrl });
}

function findTool(name: string): ToolDef {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

const ctx: ToolContext = { defaultSpaceId: undefined };

const mock = new MockApi();
before(() => mock.start());
after(() => mock.stop());

describe("tool registry", () => {
  it("exposes exactly the expected tools, each with a schema", () => {
    const expected = [
      "list_cubes",
      "get_cube",
      "create_cube",
      "power_off_cube",
      "wake_cube",
      "delete_cube",
      "list_regions",
      "list_images",
      "get_pricing",
      "list_domains",
      "create_domain",
      "delete_domain",
      "list_snapshots",
      "create_snapshot",
      "delete_snapshot",
      "restore_cube",
      "list_tcp_mappings",
      "create_tcp_mapping",
      "delete_tcp_mapping",
    ].sort();
    assert.deepEqual(TOOLS.map((t) => t.name).sort(), expected);

    for (const tool of TOOLS) {
      assert.ok(tool.title.length > 0, `${tool.name} has a title`);
      assert.ok(tool.description.length > 0, `${tool.name} has a description`);
      assert.equal(typeof tool.inputSchema, "object", `${tool.name} has an inputSchema shape`);
      assert.equal(typeof tool.handler, "function", `${tool.name} has a handler`);
    }
  });

  it("marks read-only tools readOnly and destructive tools destructive", () => {
    const readOnly = [
      "list_cubes",
      "get_cube",
      "list_regions",
      "list_images",
      "get_pricing",
      "list_domains",
      "list_snapshots",
      "list_tcp_mappings",
    ];
    for (const name of readOnly) {
      const tool = findTool(name);
      assert.equal(tool.annotations.readOnlyHint, true, `${name} is readOnlyHint`);
      assert.notEqual(tool.annotations.destructiveHint, true, `${name} is not destructive`);
    }

    // The destructive/billable mutations must advertise destructiveHint so an
    // MCP client can require human confirmation before executing — the guard
    // against a prompt-injected model firing create/delete on untrusted input.
    // restore_cube REPLACES the disk, so it is destructive too.
    for (const name of [
      "create_cube",
      "delete_cube",
      "delete_domain",
      "delete_snapshot",
      "restore_cube",
      "delete_tcp_mapping",
    ]) {
      const tool = findTool(name);
      assert.equal(tool.annotations.readOnlyHint, false, `${name} is not read-only`);
      assert.equal(tool.annotations.destructiveHint, true, `${name} is destructive`);
    }

    // Sleep/wake + the create-resource tools mutate but preserve data — not
    // read-only, not destructive.
    for (const name of [
      "power_off_cube",
      "wake_cube",
      "create_domain",
      "create_snapshot",
      "create_tcp_mapping",
    ]) {
      const tool = findTool(name);
      assert.equal(tool.annotations.readOnlyHint, false, `${name} is not read-only`);
      assert.notEqual(tool.annotations.destructiveHint, true, `${name} is not destructive`);
    }
  });

  it("gives cube tools a spaceId/cubeId schema", () => {
    const getCube = findTool("get_cube");
    assert.ok("spaceId" in getCube.inputSchema);
    assert.ok("cubeId" in getCube.inputSchema);

    const createCube = findTool("create_cube");
    for (const field of ["name", "image", "region", "vcpu", "ramGb", "diskGb", "sshPublicKey"]) {
      assert.ok(field in createCube.inputSchema, `create_cube schema has ${field}`);
    }
  });
});

describe("list_cubes", () => {
  it("returns the cubes from the API and hits the right path with X-API-KEY", async () => {
    const cubes = [
      { id: "cube_1", name: "web", state: "running" },
      { id: "cube_2", name: "db", state: "stopped" },
    ];
    mock.handle((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: cubes }));
    });

    const result = await runTool(findTool("list_cubes"), makeClient(mock.baseUrl), { spaceId: "space_abc" }, ctx);

    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]!.text) as { data: typeof cubes };
    assert.deepEqual(payload.data, cubes);

    const req = mock.requests[0]!;
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/spaces/space_abc/cubes");
    assert.equal(req.headers["x-api-key"], "kro_test_key");
  });

  it("falls back to the default space id from context", async () => {
    mock.handle((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });

    const result = await runTool(
      findTool("list_cubes"),
      makeClient(mock.baseUrl),
      {},
      { defaultSpaceId: "space_default" },
    );

    assert.equal(result.isError, undefined);
    assert.equal(mock.requests[0]!.url, "/spaces/space_default/cubes");
  });

  it("errors when no spaceId is available", async () => {
    mock.handle((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    const result = await runTool(findTool("list_cubes"), makeClient(mock.baseUrl), {}, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /No spaceId provided/);
    assert.equal(mock.requests.length, 0, "no API call should be made");
  });
});

describe("create_cube", () => {
  it("sends the correct POST body (resources nested) and returns the created cube", async () => {
    const created = { id: "cube_new", name: "api", state: "pending" };
    // The Krova Cloud create-Cube endpoint wraps the created resource in a
    // `{ cube: ... }` envelope; the SDK unwraps it and returns the Cube.
    mock.handle((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ cube: created }));
    });

    const result = await runTool(
      findTool("create_cube"),
      makeClient(mock.baseUrl),
      {
        spaceId: "space_xyz",
        name: "api",
        image: "ubuntu-24.04",
        region: "us-east",
        vcpu: 2,
        ramGb: 4,
        diskGb: 40,
        sshPublicKey: "ssh-ed25519 AAAA test@krova",
      },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0]!.text), created);

    const req = mock.requests[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/spaces/space_xyz/cubes");
    assert.deepEqual(req.body, {
      name: "api",
      image: "ubuntu-24.04",
      region: "us-east",
      resources: { vcpu: 2, ramGb: 4, diskGb: 40 },
      sshPublicKey: "ssh-ed25519 AAAA test@krova",
    });
  });
});

describe("error handling", () => {
  it("surfaces a non-2xx API response as a tool error with the API message", async () => {
    mock.handle((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Cube not found" }));
    });

    const result = await runTool(
      findTool("get_cube"),
      makeClient(mock.baseUrl),
      { spaceId: "space_abc", cubeId: "missing" },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /404/);
    assert.match(result.content[0]!.text, /Cube not found/);
  });
});

describe("catalog tools", () => {
  it("list_regions / list_images / get_pricing hit their endpoints", async () => {
    for (const [name, path, body] of [
      ["list_regions", "/regions", { data: [{ slug: "us-east" }] }],
      ["list_images", "/images", { data: [{ slug: "ubuntu-24.04" }] }],
      ["get_pricing", "/pricing", { compute: { vcpuHour: 0.01 } }],
    ] as const) {
      mock.handle((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
      const result = await runTool(findTool(name), makeClient(mock.baseUrl), {}, ctx);
      assert.equal(result.isError, undefined, `${name} should succeed`);
      assert.equal(mock.requests[0]!.url, path);
      assert.deepEqual(JSON.parse(result.content[0]!.text), body);
    }
  });
});

describe("resource tools (domains, snapshots, tcp)", () => {
  it("list_domains unwraps { domains } and hits the right path", async () => {
    mock.handle((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ domains: [{ id: "dom_1", domain: "app.example.com" }] }));
    });
    const result = await runTool(
      findTool("list_domains"),
      makeClient(mock.baseUrl),
      { spaceId: "space_abc", cubeId: "cube_1" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(mock.requests[0]!.url, "/spaces/space_abc/cubes/cube_1/domains");
    const payload = JSON.parse(result.content[0]!.text) as Array<{ id: string }>;
    assert.equal(payload[0]!.id, "dom_1");
  });

  it("create_snapshot posts to the snapshots endpoint and returns the snapshot", async () => {
    mock.handle((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ snapshot: { id: "snap_1", name: "nightly" } }));
    });
    const result = await runTool(
      findTool("create_snapshot"),
      makeClient(mock.baseUrl),
      { spaceId: "space_abc", cubeId: "cube_1", name: "nightly" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(mock.requests[0]!.method, "POST");
    assert.equal(mock.requests[0]!.url, "/spaces/space_abc/cubes/cube_1/snapshots");
    const snap = JSON.parse(result.content[0]!.text) as { id: string };
    assert.equal(snap.id, "snap_1");
  });

  it("restore_cube is destructive and posts the snapshotId", async () => {
    mock.handle((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    const result = await runTool(
      findTool("restore_cube"),
      makeClient(mock.baseUrl),
      { spaceId: "space_abc", cubeId: "cube_1", snapshotId: "snap_9" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(mock.requests[0]!.url, "/spaces/space_abc/cubes/cube_1/restore");
    assert.equal((mock.requests[0]!.body as { snapshotId: string }).snapshotId, "snap_9");
  });
});
