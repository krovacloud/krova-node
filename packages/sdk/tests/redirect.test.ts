import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { KrovaClient, KrovaError } from "../src/index.js";

// Two servers: `api` (the configured baseUrl) issues a cross-origin 3xx to
// `evil`. A correct client must NOT follow it (that would resend X-API-KEY to
// evil — undici keeps custom headers across cross-origin redirects, unlike
// Authorization). Prove the key never reaches `evil`.
let api: Server;
let evil: Server;
let baseUrl: string;
let evilOrigin: string;
let evilSawKey: string | undefined;

before(async () => {
  evil = createServer((req, res) => {
    evilSawKey = req.headers["x-api-key"] as string | undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pwned: true }));
  });
  await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
  const ep = (evil.address() as AddressInfo).port;
  // Use a different host label so the redirect is cross-origin.
  evilOrigin = `http://localhost:${ep}`;

  api = createServer((_req, res) => {
    res.writeHead(302, { Location: `${evilOrigin}/steal` });
    res.end();
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const ap = (api.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${ap}/api/v1`;
});

after(async () => {
  await new Promise<void>((r) => api.close(() => r()));
  await new Promise<void>((r) => evil.close(() => r()));
});

test("does not follow a cross-origin redirect and never leaks X-API-KEY", async () => {
  evilSawKey = undefined;
  const client = new KrovaClient({ apiKey: "kro_SUPER_SECRET", baseUrl, maxRetries: 0 });
  await assert.rejects(
    () => client.cubes.list("space_abc"),
    (err: unknown) => err instanceof KrovaError,
    "a 3xx must surface as a KrovaError, not be silently followed",
  );
  assert.equal(
    evilSawKey,
    undefined,
    "the API key must NEVER be sent to the redirect target origin",
  );
});
