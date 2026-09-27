import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { type Domain, KrovaClient, KrovaError } from "../src/index.js";

/**
 * The PROXY protocol setting on custom domains: what goes on the wire, and the
 * 409 the API returns for a save that would mix settings on one Cube port.
 * Same mock-server pattern as client.test.ts; no real network.
 */
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
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const domain = {
  id: "m_1",
  cubeId: "c1",
  domain: "shop.example.com",
  port: 3000,
  status: "active",
  originScheme: "http",
  proxyProtocol: "v2",
} as unknown as Domain;

test("domains.create and domains.update send proxyProtocol and the confirmation", async () => {
  const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
  handler = (req, res, body) => {
    seen.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
    json(res, req.method === "POST" ? 201 : 200, req.method === "POST" ? { domain, records: [] } : { domain });
  };
  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });

  const { domain: created } = await client.domains.create("s1", "c1", {
    domain: "shop.example.com",
    port: 3000,
    proxyProtocol: "v2",
    confirmMixedProxyProtocol: true,
  });
  assert.equal(created.proxyProtocol, "v2");
  assert.equal(created.originScheme, "http");

  // null turns it off; it must reach the API as null, not be dropped.
  await client.domains.update("s1", "c1", "m_1", { proxyProtocol: null });

  assert.deepEqual(seen, [
    {
      method: "POST",
      url: "/api/v1/spaces/s1/cubes/c1/domains",
      body: { domain: "shop.example.com", port: 3000, proxyProtocol: "v2", confirmMixedProxyProtocol: true },
    },
    { method: "PATCH", url: "/api/v1/spaces/s1/cubes/c1/domains/m_1", body: { proxyProtocol: null } },
  ]);
});

test("a save that would mix settings on one port is a KrovaError 409 naming the other domains", async () => {
  const error =
    "shop.example.com would use PROXY protocol v2 on cube port 3000, but api.example.com on the same port does not. Your app accepts PROXY headers per port, so one side fails on every request. Change them together, or confirm the mix if your app handles both on this port (API: confirmMixedProxyProtocol: true).";
  handler = (_req, res) =>
    json(res, 409, { error, errorMeta: { code: "proxy_protocol_port_mismatch", port: 3000, domains: ["api.example.com"] } });
  const client = new KrovaClient({ apiKey: "kro_test", baseUrl });

  await assert.rejects(
    () => client.domains.update("s1", "c1", "m_1", { proxyProtocol: "v2" }),
    (err: unknown) => {
      assert.ok(err instanceof KrovaError);
      assert.equal(err.status, 409);
      assert.equal(err.message, error);
      assert.equal(err.body?.error, error);
      return true;
    },
  );
});
