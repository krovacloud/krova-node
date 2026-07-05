import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { KrovaClient } from "@krovacloud/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_INFO } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

/**
 * End-to-end MCP smoke test: wire the real server to a real MCP client over the
 * in-memory transport pair (no stdio process, no network) and assert the
 * `tools/list` response advertises every tool with an input schema. This
 * exercises the same registration path the stdio bin uses.
 */
describe("MCP server (in-memory transport)", () => {
  it("advertises all tools with JSON schemas over tools/list", async () => {
    const krova = new KrovaClient({ apiKey: "kro_test", baseUrl: "http://127.0.0.1:1/unused" });
    const server = createServer(krova, { apiKey: "kro_test" });

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, TOOLS.map((t) => t.name).sort());

      for (const tool of tools) {
        assert.ok(tool.description && tool.description.length > 0, `${tool.name} has a description`);
        assert.equal(tool.inputSchema.type, "object", `${tool.name} exposes an object JSON schema`);
      }

      const createCube = tools.find((t) => t.name === "create_cube");
      assert.ok(createCube);
      const props = (createCube.inputSchema.properties ?? {}) as Record<string, unknown>;
      for (const field of ["name", "image", "region", "vcpu", "ramGb", "diskGb", "sshPublicKey"]) {
        assert.ok(field in props, `create_cube JSON schema advertises ${field}`);
      }

      // The destructive tools must advertise destructiveHint over the wire so a
      // client can gate them behind confirmation (prompt-injection defense).
      const deleteCube = tools.find((t) => t.name === "delete_cube");
      assert.ok(deleteCube);
      assert.equal(deleteCube.annotations?.destructiveHint, true, "delete_cube is destructive");
      assert.equal(createCube.annotations?.destructiveHint, true, "create_cube is destructive");

      const listCubes = tools.find((t) => t.name === "list_cubes");
      assert.ok(listCubes);
      assert.equal(listCubes.annotations?.readOnlyHint, true, "list_cubes is read-only");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects an oversized userData payload at the schema boundary (no API call)", async () => {
    // Point the client at an unroutable base URL: if validation ever let the
    // oversized payload through, the call would attempt a network request and
    // fail differently. A schema rejection never reaches the handler/network.
    const krova = new KrovaClient({ apiKey: "kro_test", baseUrl: "http://127.0.0.1:1/unused" });
    const server = createServer(krova, { apiKey: "kro_test", defaultSpaceId: "space_x" });

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "create_cube",
        arguments: {
          name: "x",
          image: "ubuntu-24.04",
          region: "us-east",
          vcpu: 1,
          ramGb: 1,
          diskGb: 10,
          sshPublicKey: "ssh-ed25519 AAAA test@krova",
          userData: "a".repeat(16 * 1024 + 1),
        },
      });
      assert.equal(result.isError, true, "oversized userData is rejected");
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "").toLowerCase();
      assert.ok(/16 kib|too big|too_big|invalid/.test(text), `error mentions the size limit: ${text}`);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports the Krova Cloud server identity, versioned in lockstep with package.json", () => {
    assert.equal(SERVER_INFO.name, "krova-mcp");

    // The advertised serverInfo.version must always match the published package
    // version, so bumping one without the other fails here.
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version: string };
    assert.equal(SERVER_INFO.version, pkg.version);
  });
});
