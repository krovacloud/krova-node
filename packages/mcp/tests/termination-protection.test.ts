import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { KrovaClient } from "@krovacloud/sdk";

import { runTool, TOOLS, type ToolContext, type ToolDef } from "../src/tools.js";

/**
 * Tests for the MCP termination-protection surface. Standalone mock server —
 * mirrors the structure of `tools.test.ts` (which owns a shared `MockApi`)
 * but keeps this file independent so the suite can grow without touching the
 * tool-registry invariants locked in there.
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

function findTool(name: string): ToolDef {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

const ctx: ToolContext = { defaultSpaceId: undefined };

const mock = new MockApi();
before(() => mock.start());
after(() => mock.stop());

describe("tool registry: termination protection", () => {
  it("registers protect_cube and unprotect_cube", () => {
    const names = TOOLS.map((t) => t.name).sort();
    assert.ok(names.includes("protect_cube"), "must expose protect_cube");
    assert.ok(names.includes("unprotect_cube"), "must expose unprotect_cube");
  });

  it("exposes terminationProtection on create_cube", () => {
    const tool = findTool("create_cube");
    assert.ok(
      "terminationProtection" in tool.inputSchema,
      "create_cube inputSchema must include terminationProtection",
    );
  });

  it("does NOT mark protect_cube or unprotect_cube as destructive (they are reversible toggles)", () => {
    for (const name of ["protect_cube", "unprotect_cube"]) {
      const tool = findTool(name);
      assert.notEqual(
        tool.annotations.destructiveHint,
        true,
        `${name} is a reversible toggle, not destructive`,
      );
      assert.equal(
        tool.annotations.idempotentHint,
        true,
        `${name} is idempotent on the server side — repeat calls are no-ops`,
      );
    }
  });

  it("describes protect_cube as opt-in and clarifies what remains allowed", () => {
    const tool = findTool("protect_cube");
    // An agent deciding whether to flip the flag relies on the description
    // being honest about scope. The wording must say what is blocked AND
    // what remains allowed — a one-sided description is how an agent picks
    // a worse tool (delete_cube + force) when power-off was the right answer.
    assert.match(tool.description, /termination protection/i);
    assert.match(
      tool.description,
      /power-?off|wake|restart|snapshot|restore/i,
      "must mention what remains allowed (NOT just what is blocked)",
    );
  });
});

describe("create_cube: forwards terminationProtection", () => {
  it("sends the flag on the wire when set, and omits it on silence", async () => {
    let calls = 0;
    mock.handle((_req, res) => {
      calls += 1;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ cube: { id: `cube_${calls}`, terminationProtection: calls === 1 } }));
    });

    const client = new KrovaClient({ apiKey: "kro_test", baseUrl: mock.baseUrl });

    const on = await runTool(
      findTool("create_cube"),
      client,
      {
        spaceId: "space_abc",
        name: "p",
        image: "ubuntu-24.04",
        vcpu: 1,
        ramGb: 1,
        diskGb: 10,
        sshPublicKey: "ssh-ed25519 AAAA",
        terminationProtection: true,
      },
      ctx,
    );
    assert.equal(on.isError, undefined);
    assert.equal(
      (mock.requests[0]!.body as { terminationProtection?: boolean }).terminationProtection,
      true,
    );

    const off = await runTool(
      findTool("create_cube"),
      client,
      {
        spaceId: "space_abc",
        name: "p",
        image: "ubuntu-24.04",
        vcpu: 1,
        ramGb: 1,
        diskGb: 10,
        sshPublicKey: "ssh-ed25519 AAAA",
        // Intentionally omitted — the server defaults it to `false`. The SDK
        // / MCP wire must NOT send a `false` on silence: PATCH semantics
        // distinguish "set to false" from "leave alone", and the agent did
        // not opt in.
      },
      ctx,
    );
    assert.equal(off.isError, undefined);
    const sentBody = mock.requests[1]!.body as Record<string, unknown>;
    assert.ok(
      !("terminationProtection" in sentBody),
      "an omitted terminationProtection must not be sent on the wire (create is a fresh start)",
    );
  });
});

describe("protect_cube / unprotect_cube", () => {
  it("protect_cube PATCHes the cube with { terminationProtection: true }", async () => {
    mock.handle((req, res) => {
      assert.equal(req.method, "PATCH");
      assert.equal(req.url, "/spaces/space_abc/cubes/cube_1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          cube: {
            id: "cube_1",
            terminationProtection: true,
            terminationProtectionChangedAt: "2026-09-15T12:00:00Z",
            terminationProtectionChangedBy: "user:abc",
          },
        }),
      );
    });
    const client = new KrovaClient({ apiKey: "kro_test", baseUrl: mock.baseUrl });
    const result = await runTool(
      findTool("protect_cube"),
      client,
      { spaceId: "space_abc", cubeId: "cube_1" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    const sent = mock.requests[0]!.body as { terminationProtection: boolean };
    assert.equal(sent.terminationProtection, true);
  });

  it("unprotect_cube PATCHes the cube with { terminationProtection: false }", async () => {
    mock.handle((req, res) => {
      assert.equal(req.method, "PATCH");
      assert.equal(req.url, "/spaces/space_abc/cubes/cube_1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ cube: { id: "cube_1", terminationProtection: false } }),
      );
    });
    const client = new KrovaClient({ apiKey: "kro_test", baseUrl: mock.baseUrl });
    const result = await runTool(
      findTool("unprotect_cube"),
      client,
      { spaceId: "space_abc", cubeId: "cube_1" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    const sent = mock.requests[0]!.body as { terminationProtection: boolean };
    assert.equal(sent.terminationProtection, false);
  });
});

describe("delete_cube: surfaces termination_protected as isError: true", () => {
  it("returns isError with the server message when the cube is protected", async () => {
    mock.handle((req, res) => {
      assert.equal(req.method, "DELETE");
      assert.equal(req.url, "/spaces/space_abc/cubes/cube_1");
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "termination_protected",
            message:
              "This Cube has termination protection on. Turn it off before deleting.",
            cube: {
              id: "cube_1",
              terminationProtectionChangedAt: "2026-09-15T12:00:00Z",
              terminationProtectionChangedBy: "user:abc",
            },
          },
        }),
      );
    });
    const client = new KrovaClient({ apiKey: "kro_test", baseUrl: mock.baseUrl });
    const result = await runTool(
      findTool("delete_cube"),
      client,
      { spaceId: "space_abc", cubeId: "cube_1" },
      ctx,
    );
    assert.equal(result.isError, true, "delete on a protected cube MUST be isError");
    assert.match(result.content[0]!.text, /termination protection on/);
  });
});
