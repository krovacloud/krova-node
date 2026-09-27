import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { KrovaClient } from "@krovacloud/sdk";

import { runTool, TOOLS, type ToolContext, type ToolDef } from "../src/tools.js";

/**
 * The PROXY protocol setting on create_domain / update_domain, against a mock
 * API: what goes on the wire, and that the API's 409 for a mixed port reaches
 * the agent with the other domains named. Standalone mock server, like
 * termination-protection.test.ts.
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

const client = () => new KrovaClient({ apiKey: "kro_test", baseUrl: mock.baseUrl });
const DOMAIN = { id: "m_1", domain: "shop.example.com", port: 3000, status: "active" };

describe("schema", () => {
  it("both tools take proxyProtocol (v1, v2 or off) and the mixed-port confirmation", () => {
    for (const name of ["create_domain", "update_domain"]) {
      const schema = findTool(name).inputSchema as unknown as Record<
        string,
        { safeParse: (v: unknown) => { success: boolean }; isOptional: () => boolean }
      >;
      const field = schema.proxyProtocol;
      assert.ok(field, `${name} exposes proxyProtocol`);
      assert.equal(field.isOptional(), true, `${name}: proxyProtocol is optional`);
      for (const ok of ["v1", "v2", "off"]) {
        assert.equal(field.safeParse(ok).success, true, `${name} accepts ${ok}`);
      }
      for (const bad of ["V2", "v3", "on", null, 2]) {
        assert.equal(field.safeParse(bad).success, false, `${name} rejects ${String(bad)}`);
      }
      assert.ok(schema.confirmMixedProxyProtocol, `${name} exposes confirmMixedProxyProtocol`);
      assert.equal(schema.confirmMixedProxyProtocol.isOptional(), true);
    }
  });

  it("no longer claims HTTPS to the Cube is verified before it is applied", () => {
    // krovacloud/krova#734 removed that check: the setting applies as saved.
    for (const name of ["create_domain", "update_domain"]) {
      const schema = findTool(name).inputSchema as unknown as Record<string, { description?: string }>;
      assert.doesNotMatch(schema.originScheme?.description ?? "", /verified against the cube/i);
      assert.match(schema.originScheme?.description ?? "", /applied as saved/i);
    }
  });
});

describe("create_domain on the wire", () => {
  it("sends proxyProtocol and the confirmation when given, and nothing for off or silence", async () => {
    mock.handle((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ domain: DOMAIN, records: [] }));
    });
    const base = { spaceId: "space_abc", cubeId: "cube_1", domain: "shop.example.com", port: 3000 };

    const on = await runTool(findTool("create_domain"), client(), { ...base, proxyProtocol: "v2", confirmMixedProxyProtocol: true }, ctx);
    assert.equal(on.isError, undefined);
    assert.deepEqual(mock.requests[0]?.body, {
      domain: "shop.example.com",
      port: 3000,
      proxyProtocol: "v2",
      confirmMixedProxyProtocol: true,
    });

    for (const args of [{ ...base, proxyProtocol: "off" }, base]) {
      mock.handle((_req, res) => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ domain: DOMAIN, records: [] }));
      });
      await runTool(findTool("create_domain"), client(), args, ctx);
      assert.deepEqual(mock.requests[0]?.body, { domain: "shop.example.com", port: 3000 });
    }
  });
});

describe("update_domain on the wire", () => {
  const base = { spaceId: "space_abc", cubeId: "cube_1", mappingId: "m_1" };
  const ok = () =>
    mock.handle((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ domain: DOMAIN }));
    });

  it("sends only what was given: off is null, and the scheme is left alone", async () => {
    ok();
    await runTool(findTool("update_domain"), client(), { ...base, proxyProtocol: "off" }, ctx);
    assert.equal(mock.requests[0]?.method, "PATCH");
    assert.match(mock.requests[0]?.url ?? "", /\/domains\/m_1$/);
    assert.deepEqual(mock.requests[0]?.body, { proxyProtocol: null });

    ok();
    await runTool(findTool("update_domain"), client(), { ...base, proxyProtocol: "v1", confirmMixedProxyProtocol: true }, ctx);
    assert.deepEqual(mock.requests[0]?.body, { proxyProtocol: "v1", confirmMixedProxyProtocol: true });

    // The scheme alone still works as before, and does not touch the PROXY setting.
    ok();
    await runTool(findTool("update_domain"), client(), { ...base, originScheme: "https" }, ctx);
    assert.deepEqual(mock.requests[0]?.body, { originScheme: "https" });
  });

  it("refuses a call that changes nothing, without calling the API", async () => {
    ok();
    const res = await runTool(findTool("update_domain"), client(), base, ctx);
    assert.equal(res.isError, true);
    assert.match(res.content[0]?.text ?? "", /nothing to change/);
    assert.equal(mock.requests.length, 0);
  });

  it("relays the 409 for a mixed port with the other domains named", async () => {
    const error =
      "shop.example.com would use PROXY protocol v2 on cube port 3000, but api.example.com on the same port does not. Your app accepts PROXY headers per port, so one side fails on every request. Change them together, or confirm the mix if your app handles both on this port (API: confirmMixedProxyProtocol: true).";
    mock.handle((_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error, errorMeta: { code: "proxy_protocol_port_mismatch", port: 3000, domains: ["api.example.com"] } }));
    });
    const res = await runTool(findTool("update_domain"), client(), { ...base, proxyProtocol: "v2" }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.content[0]?.text ?? "", /\(409\)/);
    assert.match(res.content[0]?.text ?? "", /api\.example\.com/);
    assert.match(res.content[0]?.text ?? "", /confirmMixedProxyProtocol: true/);
  });
});
