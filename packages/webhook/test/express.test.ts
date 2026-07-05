import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { krovaWebhook, type KrovaWebhookContext } from "../src/index.js";

const SECRET = "whsec_express_secret";
const BODY = JSON.stringify({ event: "cube.deleted", data: { id: "cube_999" } });

function sign(body: string, secret: string, timestamp: number): string {
  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

interface FakeReq {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  krovaWebhook?: KrovaWebhookContext;
}

function fakeRes() {
  const state: { code?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.code = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res, state };
}

test("express middleware calls next() and attaches context on valid signature", () => {
  const now = Math.floor(Date.now() / 1000);
  const req: FakeReq = {
    body: Buffer.from(BODY, "utf8"),
    headers: {
      "x-krova-signature": sign(BODY, SECRET, now),
      "x-krova-event": "cube.deleted",
      "x-krova-delivery": "dlv_express_1",
    },
  };
  const { res, state } = fakeRes();
  let nextCalled = false;

  krovaWebhook({ secret: SECRET })(req as never, res as never, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(state.code, undefined);
  assert.equal(req.krovaWebhook?.event, "cube.deleted");
  assert.equal(req.krovaWebhook?.delivery, "dlv_express_1");
  assert.equal(req.krovaWebhook?.timestamp, now);
});

test("express middleware responds 401 on tampered body and does not call next()", () => {
  const now = Math.floor(Date.now() / 1000);
  const req: FakeReq = {
    body: Buffer.from(`${BODY} tampered`, "utf8"),
    headers: { "x-krova-signature": sign(BODY, SECRET, now) },
  };
  const { res, state } = fakeRes();
  let nextCalled = false;

  krovaWebhook({ secret: SECRET })(req as never, res as never, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(state.code, 401);
  assert.deepEqual(state.body, { error: "invalid_signature" });
});

test("express middleware responds 401 with malformed_header when signature missing", () => {
  const req: FakeReq = {
    body: Buffer.from(BODY, "utf8"),
    headers: {},
  };
  const { res, state } = fakeRes();

  krovaWebhook({ secret: SECRET })(req as never, res as never, () => {
    throw new Error("next should not be called");
  });

  assert.equal(state.code, 401);
  assert.deepEqual(state.body, { error: "malformed_header" });
});

test("express middleware returns a clear raw_body_required error on a parsed (non-raw) body", () => {
  // The developer mounted a JSON body parser instead of express.raw(), so
  // req.body is a parsed object. Verification is impossible; the error must
  // point at the real fix instead of a misleading invalid_signature.
  const now = Math.floor(Date.now() / 1000);
  const req: FakeReq = {
    body: JSON.parse(BODY), // a parsed object, not the raw bytes
    headers: { "x-krova-signature": sign(BODY, SECRET, now) },
  };
  const { res, state } = fakeRes();
  let nextCalled = false;

  krovaWebhook({ secret: SECRET })(req as never, res as never, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(state.code, 401);
  assert.equal((state.body as { error: string }).error, "raw_body_required");
});
